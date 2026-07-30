const { sendJson, readBody } = require('../lib/helpers');
const { requireAuth, getUser, verifyToken, initSecret } = require('../lib/auth');
const { addRepo, listRepos, getRepo, updateRepo, deleteRepo, addHistory, getUserPlan, checkUploadLimit, incrementUploadUsage, createUploadTemplate, listUploadTemplates, deleteUploadTemplate, createSchedule, listSchedules, deleteSchedule, updateScheduleStatus, getEmailConfig, updateEmailConfig, getUserEmailNotify, setUserEmailNotify, getUserUploadTrend, getUserRepoDist, getUserFileTypeDist } = require('../lib/db');
const { encrypt, decrypt } = require('../lib/crypto');
const { parseRepo, ghRequest, clearRepoFiles, getRepoFileTree, getRepoArchiveUrl, deleteFiles, getRepoFileContent, checkTokenStatus, createOrUpdateFile, createFileInRepo, renameFile, getFileTree } = require('../lib/github');
const { sendUploadEmail } = require('../lib/email');
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
          items: result.items || result.files,
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

      // ===== 获取仓库文件内容（在线浏览） =====
      if (action === 'file-content') {
        const repoId = body.repoId;
        const filePath = body.path;
        if (!repoId) return sendJson(res, 400, { error: '缺少仓库 ID' });
        if (!filePath) return sendJson(res, 400, { error: '缺少文件路径' });

        const config = await getRepo(user.userId, repoId);
        if (!config) return sendJson(res, 404, { error: '仓库不存在' });

        const token = decrypt(config.encToken);
        if (!token) return sendJson(res, 500, { error: 'Token 解密失败' });

        const branch = config.branch || 'main';
        const { owner, repo } = parseRepo(config.repo);

        const result = await getRepoFileContent(owner, repo, filePath, branch, token);

        return sendJson(res, 200, { ok: true, ...result });
      }

      // ===== Token 状态检测 =====
      if (action === 'check-token') {
        const repoId = body.repoId;
        if (!repoId) return sendJson(res, 400, { error: '缺少仓库 ID' });

        const config = await getRepo(user.userId, repoId);
        if (!config) return sendJson(res, 404, { error: '仓库不存在' });

        const token = decrypt(config.encToken);
        if (!token) return sendJson(res, 500, { error: 'Token 解密失败' });

        const result = await checkTokenStatus(token);

        return sendJson(res, 200, { ok: true, ...result });
      }

      // ===== 保存文件（新建或更新） =====
      if (action === 'save-file') {
        const repoId = body.repoId;
        const filePath = body.path;
        if (!repoId) return sendJson(res, 400, { error: '缺少仓库 ID' });
        if (!filePath) return sendJson(res, 400, { error: '缺少文件路径' });
        if (body.content === undefined || body.content === null) {
          return sendJson(res, 400, { error: '缺少文件内容' });
        }

        const config = await getRepo(user.userId, repoId);
        if (!config) return sendJson(res, 404, { error: '仓库不存在' });

        const token = decrypt(config.encToken);
        if (!token) return sendJson(res, 500, { error: 'Token 解密失败' });

        const branch = config.branch || 'main';
        const { owner, repo } = parseRepo(config.repo);

        const commitMsg = body.commitMsg || ('更新文件: ' + filePath);
        const result = await createOrUpdateFile(owner, repo, filePath, body.content, branch, commitMsg, token);

        await addHistory(user.userId, {
          fileName: filePath,
          fileCount: 1,
          size: Buffer.byteLength(String(body.content), 'utf8'),
          repo: `${owner}/${repo}`,
          branch,
          status: 'success',
          commitSha: result.commitSha
        });

        return sendJson(res, 200, {
          ok: true,
          commitSha: result.commitSha,
          message: '文件已保存'
        });
      }

      // ===== 新建文件（已存在则报错） =====
      if (action === 'create-file') {
        const repoId = body.repoId;
        const filePath = body.path;
        if (!repoId) return sendJson(res, 400, { error: '缺少仓库 ID' });
        if (!filePath) return sendJson(res, 400, { error: '缺少文件路径' });
        if (body.content === undefined || body.content === null) {
          return sendJson(res, 400, { error: '缺少文件内容' });
        }

        const config = await getRepo(user.userId, repoId);
        if (!config) return sendJson(res, 404, { error: '仓库不存在' });

        const token = decrypt(config.encToken);
        if (!token) return sendJson(res, 500, { error: 'Token 解密失败' });

        const branch = config.branch || 'main';
        const { owner, repo } = parseRepo(config.repo);

        const commitMsg = body.commitMsg || ('新建文件: ' + filePath);
        const result = await createFileInRepo(owner, repo, filePath, body.content, branch, commitMsg, token);

        await addHistory(user.userId, {
          fileName: filePath,
          fileCount: 1,
          size: Buffer.byteLength(String(body.content), 'utf8'),
          repo: `${owner}/${repo}`,
          branch,
          status: 'success',
          commitSha: result.commitSha
        });

        return sendJson(res, 200, {
          ok: true,
          commitSha: result.commitSha,
          message: '文件已创建'
        });
      }

      // ===== 重命名文件 =====
      if (action === 'rename-file') {
        const repoId = body.repoId;
        const oldPath = body.oldPath;
        const newPath = body.newPath;
        if (!repoId) return sendJson(res, 400, { error: '缺少仓库 ID' });
        if (!oldPath) return sendJson(res, 400, { error: '缺少原文件路径 (oldPath)' });
        if (!newPath) return sendJson(res, 400, { error: '缺少新文件路径 (newPath)' });

        const config = await getRepo(user.userId, repoId);
        if (!config) return sendJson(res, 404, { error: '仓库不存在' });

        const token = decrypt(config.encToken);
        if (!token) return sendJson(res, 500, { error: 'Token 解密失败' });

        const branch = config.branch || 'main';
        const { owner, repo } = parseRepo(config.repo);

        const commitMsg = body.commitMsg || ('重命名: ' + oldPath + ' -> ' + newPath);
        const result = await renameFile(owner, repo, oldPath, newPath, branch, commitMsg, token);

        return sendJson(res, 200, {
          ok: true,
          message: '文件已重命名'
        });
      }

      // ===== 列出目录内容 =====
      if (action === 'list-dir') {
        const repoId = body.repoId;
        if (!repoId) return sendJson(res, 400, { error: '缺少仓库 ID' });
        const dirPath = body.path || '';

        const config = await getRepo(user.userId, repoId);
        if (!config) return sendJson(res, 404, { error: '仓库不存在' });

        const token = decrypt(config.encToken);
        if (!token) return sendJson(res, 500, { error: 'Token 解密失败' });

        const branch = config.branch || 'main';
        const { owner, repo } = parseRepo(config.repo);

        const result = await getFileTree(owner, repo, branch, token, dirPath);

        return sendJson(res, 200, {
          ok: true,
          items: result,
          path: dirPath,
          branch
        });
      }

      // ===== 上传模板管理 =====
      if (action === 'create-template') {
        const name = String(body.name || '').trim();
        if (!name) return sendJson(res, 400, { error: '模板名称必填' });
        const tpl = await createUploadTemplate(user.userId, name, body.repoId, body.targetDir, body.commitMsg);
        return sendJson(res, 200, { ok: true, template: tpl });
      }

      if (action === 'list-templates') {
        const templates = await listUploadTemplates(user.userId);
        return sendJson(res, 200, { ok: true, templates });
      }

      if (action === 'delete-template') {
        if (!body.id) return sendJson(res, 400, { error: '缺少模板 ID' });
        await deleteUploadTemplate(user.userId, body.id);
        return sendJson(res, 200, { ok: true, message: '模板已删除' });
      }

      // ===== 定时上传任务 =====
      if (action === 'create-schedule') {
        const name = String(body.name || '').trim();
        if (!name) return sendJson(res, 400, { error: '任务名称必填' });
        if (!body.repoId) return sendJson(res, 400, { error: '请选择目标仓库' });
        if (!body.fileData || !body.fileData.content) return sendJson(res, 400, { error: '缺少文件数据' });

        const sched = await createSchedule(user.userId, name, body.repoId, body.fileData, body.targetDir, body.commitMsg, body.cron, body.enabled !== false);
        return sendJson(res, 200, { ok: true, schedule: sched });
      }

      if (action === 'list-schedules') {
        const schedules = await listSchedules(user.userId);
        return sendJson(res, 200, { ok: true, schedules });
      }

      if (action === 'delete-schedule') {
        if (!body.id) return sendJson(res, 400, { error: '缺少任务 ID' });
        await deleteSchedule(user.userId, body.id);
        return sendJson(res, 200, { ok: true, message: '定时任务已删除' });
      }

      if (action === 'toggle-schedule') {
        if (!body.id) return sendJson(res, 400, { error: '缺少任务 ID' });
        await updateScheduleStatus(user.userId, body.id, body.enabled !== false);
        return sendJson(res, 200, { ok: true, message: '任务状态已更新' });
      }

      // ===== 邮件通知配置 =====
      if (action === 'get-email-config') {
        const config = await getEmailConfig();
        const userNotify = await getUserEmailNotify(user.userId);
        return sendJson(res, 200, { ok: true, config: config || {}, userNotify: userNotify || { enabled: false, email: '' } });
      }

      if (action === 'set-email-config') {
        const config = {
          provider: body.provider || 'resend',
          apiKey: body.apiKey || '',
          webhookUrl: body.webhookUrl || '',
          secret: body.secret || ''
        };
        await updateEmailConfig(config);
        return sendJson(res, 200, { ok: true, message: '邮件配置已保存' });
      }

      if (action === 'set-user-email-notify') {
        const userNotify = {
          enabled: body.enabled === true,
          email: body.email || ''
        };
        await setUserEmailNotify(user.userId, userNotify);
        return sendJson(res, 200, { ok: true, message: '邮件通知设置已保存' });
      }

      // ===== 数据统计图表 =====
      if (action === 'chart-data') {
        const days = body.days || 30;
        const trend = await getUserUploadTrend(user.userId, days);
        const repoDist = await getUserRepoDist(user.userId);
        const fileTypeDist = await getUserFileTypeDist(user.userId);
        return sendJson(res, 200, { ok: true, trend, repoDist, fileTypeDist });
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
