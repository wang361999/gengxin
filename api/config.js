const { sendJson, readBody } = require('../lib/helpers');
const { requireAuth, getUser, verifyToken, initSecret } = require('../lib/auth');
const { addRepo, listRepos, getRepo, updateRepo, deleteRepo, addHistory, getUserPlan, checkUploadLimit, incrementUploadUsage } = require('../lib/db');
const { encrypt, decrypt } = require('../lib/crypto');
const { parseRepo, ghRequest, clearRepoFiles, getRepoFileTree, getRepoArchiveUrl, deleteFiles } = require('../lib/github');
const https = require('https');
const http = require('http');

// 获取 GitHub zipball 的临时下载 URL（codeload.github.com）
function getCodeloadUrl(owner, repo, branch, ghToken) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/zipball/${encodeURIComponent(branch)}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${ghToken}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'git-upload-saas',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      timeout: 25000
    }, (ghRes) => {
      // GitHub 返回 302 重定向到 codeload.github.com
      if (ghRes.statusCode === 302 || ghRes.statusCode === 301) {
        const location = ghRes.headers.location;
        if (location) {
          // 消费掉响应体防止内存泄漏
          ghRes.resume();
          resolve(location);
          return;
        }
      }
      // 404 或其他错误
      const chunks = [];
      ghRes.on('data', (c) => chunks.push(c));
      ghRes.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(raw); } catch { data = raw; }
        reject(new Error(data?.message || `GitHub 返回 ${ghRes.statusCode}`));
      });
    });
    req.on('timeout', () => { req.destroy(new Error('GitHub API 超时')); });
    req.on('error', reject);
    req.end();
  });
}

module.exports = async (req, res) => {
  await initSecret();
  const user = await requireAuth(req, res);
  if (!user) return;

  // GET: 获取仓库列表
  if (req.method === 'GET') {
    // 检查是否是下载请求 ?download=repoId&token=xxx
    const urlObj = new URL(req.url, 'http://localhost');
    const downloadRepoId = urlObj.searchParams.get('download');
    const queryToken = urlObj.searchParams.get('token');

    if (downloadRepoId && queryToken) {
      // 确保密钥已加载后验证 token（异步版本）
      const payload = await verifyToken(queryToken);
      if (!payload) return sendJson(res, 401, { error: 'Token 无效' });
      const dlUserId = payload.role === 'admin' && !payload.userId ? (payload.adminId || 'admin_user') : payload.userId;
      if (!dlUserId) return sendJson(res, 401, { error: '无法识别用户' });

      try {
        const config = await getRepo(dlUserId, downloadRepoId);
        if (!config) return sendJson(res, 404, { error: '仓库不存在' });

        const ghToken = decrypt(config.encToken);
        if (!ghToken) return sendJson(res, 500, { error: 'Token 解密失败' });

        const branch = config.branch || 'main';
        const { owner, repo } = parseRepo(config.repo);

        // 通过 GitHub API 获取 zipball 的临时下载链接（302 重定向 URL）
        const codeloadUrl = await getCodeloadUrl(owner, repo, branch, ghToken);
        if (!codeloadUrl) return sendJson(res, 500, { error: '获取下载链接失败' });

        // 返回重定向到 GitHub codeload 的 URL（临时链接，无需 Token）
        res.statusCode = 302;
        res.setHeader('Location', codeloadUrl);
        res.setHeader('Content-Type', 'text/plain');
        res.end();
        return;
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    try {
      const repos = await listRepos(user.userId);
      return sendJson(res, 200, { ok: true, repos });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // POST: 根据 _action 区分操作
  if (req.method === 'POST') {
    try {
      const body = await readBody(req);
      const action = body._action || '';

      // ===== 测试连接 =====
      if (action === 'test') {
        const repoId = body.repoId;
        if (!repoId) return sendJson(res, 400, { error: '缺少仓库 ID' });

        const config = await getRepo(user.userId, repoId);
        if (!config) return sendJson(res, 404, { error: '仓库不存在' });

        const token = decrypt(config.encToken);
        if (!token) return sendJson(res, 500, { error: 'Token 解密失败' });

        const { owner, repo } = parseRepo(config.repo);
        const branch = config.branch || 'main';

        const repoRes = await ghRequest('GET', `/repos/${owner}/${repo}`, token);
        if (repoRes.status === 404) return sendJson(res, 200, { ok: true, connected: false, message: '仓库不存在或无权访问' });
        if (repoRes.status === 401) return sendJson(res, 200, { ok: true, connected: false, message: 'Token 无效或已过期' });
        if (repoRes.status === 403) return sendJson(res, 200, { ok: true, connected: false, message: '权限不足或被限流' });
        if (repoRes.status !== 200) return sendJson(res, 200, { ok: true, connected: false, message: `GitHub 返回 ${repoRes.status}` });

        const branchRes = await ghRequest('GET', `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`, token);
        if (branchRes.status !== 200) {
          return sendJson(res, 200, {
            ok: true, connected: true, branchExists: false,
            message: `仓库可访问，但分支 "${branch}" 不存在`,
            repoInfo: { name: repoRes.data.full_name, private: repoRes.data.private, defaultBranch: repoRes.data.default_branch }
          });
        }

        return sendJson(res, 200, {
          ok: true, connected: true, branchExists: true,
          message: '连接成功，仓库和分支均可访问',
          repoInfo: {
            name: repoRes.data.full_name,
            private: repoRes.data.private,
            defaultBranch: repoRes.data.default_branch,
            stars: repoRes.data.stargazers_count
          }
        });
      }

      // ===== 预览仓库文件（清空前展示） =====
      if (action === 'preview-files') {
        const repoId = body.repoId;
        if (!repoId) return sendJson(res, 400, { error: '缺少仓库 ID' });

        const config = await getRepo(user.userId, repoId);
        if (!config) return sendJson(res, 404, { error: '仓库不存在' });

        const token = decrypt(config.encToken);
        if (!token) return sendJson(res, 500, { error: 'Token 解密失败' });

        const branch = config.branch || 'main';
        const { owner, repo } = parseRepo(config.repo);

        const result = await getRepoFileTree(owner, repo, branch, token);

        return sendJson(res, 200, {
          ok: true,
          files: result.files,
          totalFiles: result.totalFiles,
          truncated: result.truncated,
          branch: result.branch,
          repo: `${owner}/${repo}`
        });
      }

      // ===== 清空仓库 =====
      if (action === 'clear') {
        const repoId = body.repoId;
        if (!repoId) return sendJson(res, 400, { error: '缺少仓库 ID' });
        if (!body.confirm || body.confirm !== 'DELETE_ALL') {
          return sendJson(res, 400, { error: '请确认清空操作' });
        }

        const config = await getRepo(user.userId, repoId);
        if (!config) return sendJson(res, 404, { error: '仓库不存在' });

        const token = decrypt(config.encToken);
        if (!token) return sendJson(res, 500, { error: 'Token 解密失败' });

        const branch = config.branch || 'main';
        const { owner, repo } = parseRepo(config.repo);

        const result = await clearRepoFiles(owner, repo, branch, token);

        await addHistory(user.userId, {
          fileName: '清空仓库操作',
          fileCount: -(result.deletedCount),
          size: 0,
          repo: `${owner}/${repo}`,
          branch,
          status: 'success',
          commitSha: result.commitSha
        });

        return sendJson(res, 200, {
          ok: true,
          message: result.deletedCount === 0
            ? '仓库已经是空的（已保留 README.md）'
            : `已清空仓库，删除了 ${result.deletedCount} 个文件（已保留 README.md，确保后续可正常上传）`,
          deletedCount: result.deletedCount,
          commitSha: result.commitSha,
          keptReadme: result.keptReadme
        });
      }

      // ===== 删除指定文件（支持批量） =====
      if (action === 'delete-files') {
        const repoId = body.repoId;
        if (!repoId) return sendJson(res, 400, { error: '缺少仓库 ID' });
        const filesToDelete = Array.isArray(body.files) ? body.files : [];
        if (filesToDelete.length === 0) return sendJson(res, 400, { error: '请选择要删除的文件' });
        if (filesToDelete.length > 500) return sendJson(res, 400, { error: '单次最多删除 500 个文件' });

        const config = await getRepo(user.userId, repoId);
        if (!config) return sendJson(res, 404, { error: '仓库不存在' });

        const token = decrypt(config.encToken);
        if (!token) return sendJson(res, 500, { error: 'Token 解密失败' });

        const branch = config.branch || 'main';
        const { owner, repo } = parseRepo(config.repo);

        const result = await deleteFiles(owner, repo, branch, filesToDelete, token);

        await addHistory(user.userId, {
          fileName: `删除 ${result.deletedCount} 个文件`,
          fileCount: -(result.deletedCount),
          size: 0,
          repo: `${owner}/${repo}`,
          branch,
          status: 'success',
          commitSha: result.commitSha
        });

        return sendJson(res, 200, {
          ok: true,
          message: `成功删除 ${result.deletedCount} 个文件`,
          deletedCount: result.deletedCount,
          deletedFiles: result.deletedFiles,
          commitSha: result.commitSha
        });
      }

      // ===== 下载仓库打包 =====
      if (action === 'download') {
        const repoId = body.repoId;
        if (!repoId) return sendJson(res, 400, { error: '缺少仓库 ID' });

        const config = await getRepo(user.userId, repoId);
        if (!config) return sendJson(res, 404, { error: '仓库不存在' });

        const token = decrypt(config.encToken);
        if (!token) return sendJson(res, 500, { error: 'Token 解密失败' });

        const branch = config.branch || 'main';
        const { owner, repo } = parseRepo(config.repo);

        // 获取 GitHub 临时下载链接
        const codeloadUrl = await getCodeloadUrl(owner, repo, branch, token);

        // 获取当前用户的 JWT token（用于 GET 下载时认证）
        const jwtToken = (req.headers.authorization || '').replace('Bearer ', '');

        // 构建后端代理下载 URL（带 JWT 认证，后端会 302 到 codeload）
        const downloadUrl = `/api/config?download=${repoId}&token=${encodeURIComponent(jwtToken)}`;

        return sendJson(res, 200, {
          ok: true,
          downloadUrl,
          fileName: `${repo}-${branch}.zip`,
          repoName: `${owner}/${repo}`,
          directUrl: codeloadUrl
        });
      }

      // ===== 新增/更新仓库（默认） =====
      const name = String(body.name || '').trim();
      const repo = String(body.repo || '').trim();
      const token = String(body.token || '').trim();
      const branch = String(body.branch || 'main').trim();
      const targetDir = String(body.targetDir || '.').trim();
      const repoId = body.id;

      if (!repo) return sendJson(res, 400, { error: '仓库地址必填' });
      if (!name) return sendJson(res, 400, { error: '仓库名称必填' });

      if (repoId) {
        const updates = { name, repo, branch, targetDir };
        if (token) updates.encToken = encrypt(token);
        const updated = await updateRepo(user.userId, repoId, updates);
        if (!updated) return sendJson(res, 404, { error: '仓库不存在' });
        return sendJson(res, 200, {
          ok: true, message: '仓库配置已更新',
          repo: { id: updated.id, name: updated.name, repo: updated.repo, branch: updated.branch, targetDir: updated.targetDir, hasToken: true }
        });
      } else {
        if (!token) return sendJson(res, 400, { error: 'GitHub Token 必填' });

        // 检查仓库数量限制（变现）
        const planInfo = await getUserPlan(user.userId);
        if (planInfo.repoLimit > 0) {
          const existingRepos = await listRepos(user.userId);
          if (existingRepos.length >= planInfo.repoLimit) {
            return sendJson(res, 403, {
              error: `已达到仓库数量上限 (${planInfo.repoLimit} 个)，当前套餐：${planInfo.name}，请升级套餐`,
              needUpgrade: true,
              plan: planInfo
            });
          }
        }

        const encToken = encrypt(token);
        const created = await addRepo(user.userId, { name, repo, encToken, branch, targetDir });
        return sendJson(res, 200, { ok: true, message: '仓库已添加', repo: created });
      }
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // DELETE: 删除仓库
  if (req.method === 'DELETE') {
    try {
      const body = await readBody(req);
      if (!body.id) return sendJson(res, 400, { error: '缺少仓库 ID' });
      await deleteRepo(user.userId, body.id);
      return sendJson(res, 200, { ok: true, message: '仓库已删除' });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  return sendJson(res, 405, { error: '只支持 GET、POST 和 DELETE' });
};
