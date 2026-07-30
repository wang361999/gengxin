const https = require('https');
const pathModule = require('path');

// 安全处理文件路径：防止路径穿越攻击
function sanitizePath(filePath) {
  let p = String(filePath || '').replace(/\\/g, '/');
  // 移除开头的 /
  p = p.replace(/^\/+/, '');
  // 标准化路径，解析 .. 和 .
  const parts = p.split('/');
  const safeParts = [];
  for (const part of parts) {
    if (part === '..' || part === '.') continue;
    if (part === '') continue;
    // 移除 null bytes 和控制字符
    const clean = part.replace(/[\x00-\x1f]/g, '');
    if (clean) safeParts.push(clean);
  }
  return safeParts.join('/');
}

function ghRequest(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'git-upload-saas',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    let payload = null;
    if (body) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    const req = https.request({
      hostname: 'api.github.com',
      path,
      method,
      headers,
      timeout: 25000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('GitHub API 超时')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function parseRepo(url) {
  const v = String(url || '').trim();
  const ssh = v.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  const short = v.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (short && !v.includes('://')) return { owner: short[1], repo: short[2] };
  const u = new URL(v);
  const parts = u.pathname.replace(/^\/+/, '').replace(/\.git$/, '').split('/');
  if (parts.length < 2) throw new Error('仓库地址格式不正确');
  return { owner: parts[0], repo: parts[1] };
}

function explainError(status, data) {
  if (status === 401) return 'Token 无效或已过期';
  if (status === 403) return (data?.message || '权限不足或被限流') + (data?.documentation_url ? ` (${data.documentation_url})` : '');
  if (status === 404) return '仓库不存在或无权访问';
  if (data?.message) return data.message;
  return `GitHub 返回 ${status}`;
}

// 初始化空仓库：创建 README.md 并建立分支
async function initEmptyRepo(owner, repo, branch, token) {
  // 1. 创建 README.md blob
  const readmeContent = Buffer.from(`# ${repo}\n\nThis repository is managed by GitShip.\n`).toString('base64');
  const blobRes = await ghRequest('POST', `/repos/${owner}/${repo}/git/blobs`, token, {
    content: readmeContent,
    encoding: 'base64'
  });
  if (blobRes.status < 200 || blobRes.status >= 300) {
    throw new Error(`创建 README.md blob 失败: ${explainError(blobRes.status, blobRes.data)}`);
  }

  // 2. 创建只含 README.md 的 tree
  const treeRes = await ghRequest('POST', `/repos/${owner}/${repo}/git/trees`, token, {
    tree: [{ path: 'README.md', sha: blobRes.data.sha, mode: '100644', type: 'blob' }]
  });
  if (treeRes.status < 200 || treeRes.status >= 300) {
    throw new Error(`创建 tree 失败: ${explainError(treeRes.status, treeRes.data)}`);
  }

  // 3. 创建初始 commit（无 parent）
  const commitRes = await ghRequest('POST', `/repos/${owner}/${repo}/git/commits`, token, {
    message: 'Initial commit: README.md\n\n由 GitShip 工具自动创建',
    tree: treeRes.data.sha
  });
  if (commitRes.status < 200 || commitRes.status >= 300) {
    throw new Error(`创建初始 commit 失败: ${explainError(commitRes.status, commitRes.data)}`);
  }

  // 4. 尝试创建分支引用
  const refRes = await ghRequest('POST', `/repos/${owner}/${repo}/git/refs`, token, {
    ref: `refs/heads/${branch}`,
    sha: commitRes.data.sha
  });

  // 如果分支已存在（422），尝试更新它
  if (refRes.status === 422) {
    const updateRefRes = await ghRequest('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, token, {
      sha: commitRes.data.sha,
      force: true
    });
    if (updateRefRes.status < 200 || updateRefRes.status >= 300) {
      throw new Error(`更新分支引用失败: ${explainError(updateRefRes.status, updateRefRes.data)}`);
    }
  } else if (refRes.status < 200 || refRes.status >= 300) {
    throw new Error(`创建分支失败: ${explainError(refRes.status, refRes.data)}`);
  }

  return { commitSha: commitRes.data.sha, treeSha: treeRes.data.sha };
}

async function uploadFiles(owner, repo, files, branch, commitMsg, token) {
  let baseSha = null;
  let currentBase = null;

  // 1. 尝试获取分支引用，如果分支不存在则自动初始化仓库
  const ref = await ghRequest('GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, token);
  if (ref.status === 404) {
    // 分支不存在，仓库可能为空，自动初始化
    // 先检查仓库本身是否存在
    const repoRes = await ghRequest('GET', `/repos/${owner}/${repo}`, token);
    if (repoRes.status === 404) throw new Error('仓库不存在或无权访问');
    if (repoRes.status !== 200) throw new Error(`获取仓库信息失败: ${explainError(repoRes.status, repoRes.data)}`);

    // 检查是否已有任何分支
    const branchesRes = await ghRequest('GET', `/repos/${owner}/${repo}/branches`, token);
    const existingBranches = (branchesRes.status === 200 && Array.isArray(branchesRes.data)) ? branchesRes.data : [];

    if (existingBranches.length === 0) {
      // 仓库完全为空，没有任何分支，初始化仓库
      const initResult = await initEmptyRepo(owner, repo, branch, token);
      baseSha = initResult.commitSha;
      currentBase = initResult.treeSha;
    } else {
      // 有其他分支但目标分支不存在，从默认分支创建目标分支
      const defaultBranch = repoRes.data.default_branch || existingBranches[0].name;
      const defaultRef = await ghRequest('GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`, token);
      if (defaultRef.status !== 200) throw new Error(`获取默认分支 ${defaultBranch} 失败: ${explainError(defaultRef.status, defaultRef.data)}`);

      // 从默认分支创建目标分支
      const createRefRes = await ghRequest('POST', `/repos/${owner}/${repo}/git/refs`, token, {
        ref: `refs/heads/${branch}`,
        sha: defaultRef.data.object.sha
      });
      if (createRefRes.status < 200 || createRefRes.status >= 300) {
        throw new Error(`创建分支 ${branch} 失败: ${explainError(createRefRes.status, createRefRes.data)}`);
      }
      baseSha = defaultRef.data.object.sha;
      const commitInfo = await ghRequest('GET', `/repos/${owner}/${repo}/git/commits/${baseSha}`, token);
      if (commitInfo.status !== 200) throw new Error(`获取 commit 信息失败: ${explainError(commitInfo.status, commitInfo.data)}`);
      currentBase = commitInfo.data.tree.sha;
    }
  } else if (ref.status !== 200) {
    throw new Error(`获取分支 ${branch} 失败: ${explainError(ref.status, ref.data)}`);
  } else {
    // 分支存在，正常获取
    baseSha = ref.data.object.sha;
    const commitInfo = await ghRequest('GET', `/repos/${owner}/${repo}/git/commits/${baseSha}`, token);
    if (commitInfo.status !== 200) throw new Error(`获取 commit 信息失败: ${explainError(commitInfo.status, commitInfo.data)}`);
    currentBase = commitInfo.data.tree.sha;
  }

  // 2. 创建 blobs
  const blobs = [];
  for (const file of files) {
    const safePath = sanitizePath(file.path);
    if (!safePath) continue; // 跳过无效路径
    const r = await ghRequest('POST', `/repos/${owner}/${repo}/git/blobs`, token, {
      content: file.base64,
      encoding: 'base64'
    });
    if (r.status < 200 || r.status >= 300) throw new Error(`创建 blob 失败 (${safePath}): ${explainError(r.status, r.data)}`);
    blobs.push({ path: safePath, sha: r.data.sha, mode: '100644', type: 'blob' });
  }

  if (blobs.length === 0) throw new Error('没有有效的文件可上传（路径校验后为空）');

  // 3. 创建 tree
  for (let i = 0; i < blobs.length; i += 500) {
    const batch = blobs.slice(i, i + 500);
    const r = await ghRequest('POST', `/repos/${owner}/${repo}/git/trees`, token, {
      base_tree: currentBase,
      tree: batch
    });
    if (r.status < 200 || r.status >= 300) throw new Error(`创建 tree 失败: ${explainError(r.status, r.data)}`);
    currentBase = r.data.sha;
  }

  // 4. 创建 commit
  const commit = await ghRequest('POST', `/repos/${owner}/${repo}/git/commits`, token, {
    message: commitMsg,
    parents: [baseSha],
    tree: currentBase
  });
  if (commit.status < 200 || commit.status >= 300) throw new Error(`创建 commit 失败: ${explainError(commit.status, commit.data)}`);

  // 5. 更新分支引用
  const push = await ghRequest('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, token, {
    sha: commit.data.sha,
    force: false
  });
  if (push.status < 200 || push.status >= 300) throw new Error(`推送失败: ${explainError(push.status, push.data)}`);

  return { commitSha: commit.data.sha, fileCount: files.length };
}

// 获取仓库文件树（用于预览清空前展示文件列表）
async function getRepoFileTree(owner, repo, branch, token) {
  // 1. 获取分支引用
  const ref = await ghRequest('GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, token);
  if (ref.status === 404) throw new Error(`分支 "${branch}" 不存在`);
  if (ref.status !== 200) throw new Error(`获取分支失败: ${explainError(ref.status, ref.data)}`);
  const baseSha = ref.data.object.sha;

  // 2. 获取 commit 的 tree sha
  const commitInfo = await ghRequest('GET', `/repos/${owner}/${repo}/git/commits/${baseSha}`, token);
  if (commitInfo.status !== 200) throw new Error(`获取 commit 信息失败: ${explainError(commitInfo.status, commitInfo.data)}`);

  // 3. 递归获取文件树
  const treeRes = await ghRequest('GET', `/repos/${owner}/${repo}/git/trees/${commitInfo.data.tree.sha}?recursive=1`, token);
  if (treeRes.status !== 200) throw new Error(`获取文件树失败: ${explainError(treeRes.status, treeRes.data)}`);

  const allItems = treeRes.data.tree || [];
  // 返回文件和文件夹，前端可分别展示和删除
  const items = allItems
    .filter(item => item.type === 'blob' || item.type === 'tree')
    .map(item => ({
      path: item.path,
      size: item.size || 0,
      type: item.type // 'blob' = 文件, 'tree' = 文件夹
    }));

  // 文件夹没有 size，但可以计算其包含的文件数
  const dirs = allItems.filter(item => item.type === 'tree');
  const blobs = allItems.filter(item => item.type === 'blob');
  for (const dir of dirs) {
    const childCount = blobs.filter(b => b.path.startsWith(dir.path + '/')).length;
    const dirItem = items.find(i => i.path === dir.path);
    if (dirItem) dirItem.size = childCount; // 复用 size 字段存子文件数
  }

  const files = items.filter(i => i.type === 'blob');

  return {
    files,          // 仅文件（保持向后兼容）
    items,          // 文件 + 文件夹
    truncated: treeRes.data.truncated === true,
    totalFiles: files.length,
    branch: branch,
    commitSha: baseSha
  };
}

// 清空仓库所有文件 - 保留 README.md（否则仓库无法被引用，后续上传会失败）
async function clearRepoFiles(owner, repo, branch, token) {
  // 1. 获取分支引用
  const ref = await ghRequest('GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, token);
  if (ref.status === 404) throw new Error(`分支 "${branch}" 不存在，无法清空`);
  if (ref.status !== 200) throw new Error(`获取分支失败: ${explainError(ref.status, ref.data)}`);
  const baseSha = ref.data.object.sha;

  // 2. 获取当前 commit 信息
  const commitInfo = await ghRequest('GET', `/repos/${owner}/${repo}/git/commits/${baseSha}`, token);
  if (commitInfo.status !== 200) throw new Error(`获取 commit 信息失败: ${explainError(commitInfo.status, commitInfo.data)}`);

  // 3. 获取文件树（递归）
  const treeRes = await ghRequest('GET', `/repos/${owner}/${repo}/git/trees/${commitInfo.data.tree.sha}?recursive=1`, token);
  if (treeRes.status !== 200) throw new Error(`获取文件树失败: ${explainError(treeRes.status, treeRes.data)}`);

  const allItems = treeRes.data.tree || [];
  const files = allItems.filter(item => item.type === 'blob');

  if (files.length === 0) {
    return { commitSha: baseSha, deletedCount: 0, message: '仓库已经是空的' };
  }

  // 4. 查找是否已有 README.md
  const existingReadme = files.find(f => f.path === 'README.md' || f.path === 'readme.md');

  // 5. 为新 tree 准备内容
  let newTreeItems = [];
  if (existingReadme) {
    // 如果已有 README.md，直接引用它的 blob SHA
    newTreeItems.push({ path: existingReadme.path, sha: existingReadme.sha, mode: '100644', type: 'blob' });
  } else {
    // 没有 README.md，创建一个新的
    const readmeContent = Buffer.from('# ' + repo + '\n\nThis repository is managed by GitShip.\n').toString('base64');
    const readmeBlob = await ghRequest('POST', `/repos/${owner}/${repo}/git/blobs`, token, {
      content: readmeContent,
      encoding: 'base64'
    });
    if (readmeBlob.status < 200 || readmeBlob.status >= 300) {
      throw new Error(`创建 README.md blob 失败: ${explainError(readmeBlob.status, readmeBlob.data)}`);
    }
    newTreeItems.push({ path: 'README.md', sha: readmeBlob.data.sha, mode: '100644', type: 'blob' });
  }

  // 6. 创建只含 README.md 的 tree
  const newTreeRes = await ghRequest('POST', `/repos/${owner}/${repo}/git/trees`, token, {
    tree: newTreeItems
  });
  if (newTreeRes.status < 200 || newTreeRes.status >= 300) {
    throw new Error(`创建 tree 失败: ${explainError(newTreeRes.status, newTreeRes.data)}`);
  }

  // 7. 创建 commit，parent 为当前 HEAD，tree 指向只含 README.md 的 tree
  const deletedCount = files.length - (existingReadme ? 1 : 0);
  const commit = await ghRequest('POST', `/repos/${owner}/${repo}/git/commits`, token, {
    message: `清空仓库：删除 ${deletedCount} 个文件（保留 README.md）\n\n由 GitShip 工具执行`,
    parents: [baseSha],
    tree: newTreeRes.data.sha
  });
  if (commit.status < 200 || commit.status >= 300) {
    throw new Error(`创建 commit 失败: ${explainError(commit.status, commit.data)}`);
  }

  // 8. 更新分支引用指向新 commit
  const push = await ghRequest('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, token, {
    sha: commit.data.sha,
    force: false
  });
  if (push.status < 200 || push.status >= 300) {
    throw new Error(`更新分支失败: ${explainError(push.status, push.data)}`);
  }

  return {
    commitSha: commit.data.sha,
    deletedCount: deletedCount,
    keptReadme: true
  };
}

// 获取仓库打包下载链接（GitHub 自带的 archive 接口）
async function getRepoArchiveUrl(owner, repo, branch, token) {
  // 先检查仓库和分支是否存在
  const ref = await ghRequest('GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, token);
  if (ref.status === 404) throw new Error(`分支 "${branch}" 不存在`);
  if (ref.status !== 200) throw new Error(`获取分支失败: ${explainError(ref.status, ref.data)}`);

  // GitHub archive 下载链接（需要 token 认证）
  const archiveUrl = `https://api.github.com/repos/${owner}/${repo}/zipball/${encodeURIComponent(branch)}`;
  return archiveUrl;
}

// 下载仓库文件并返回 Buffer
async function downloadRepoArchive(owner, repo, branch, token) {
  const archiveUrl = await getRepoArchiveUrl(owner, repo, branch, token);

  return new Promise((resolve, reject) => {
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'git-upload-saas',
      'X-GitHub-Api-Version': '2022-11-28'
    };

    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/zipball/${encodeURIComponent(branch)}`,
      method: 'GET',
      headers,
      timeout: 60000 // 下载可能较慢，超时 60s
    }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        // GitHub 返回重定向到实际下载地址
        const redirectUrl = res.headers.location;
        if (redirectUrl) {
          // 直接返回重定向 URL，让前端直接下载
          resolve({ redirectUrl, buffer: null });
          return;
        }
      }
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try { data = JSON.parse(raw); } catch { data = raw; }
          reject(new Error(`下载失败: ${explainError(res.statusCode, data)}`));
        });
        return;
      }
      // 如果直接返回 zip 内容，收集 buffer
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({ redirectUrl: null, buffer });
      });
    });
    req.on('timeout', () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
    req.end();
  });
}

// 删除仓库中的指定文件（支持批量删除）
async function deleteFiles(owner, repo, branch, filePaths, token) {
  // 1. 获取分支引用
  const ref = await ghRequest('GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, token);
  if (ref.status === 404) throw new Error(`分支 "${branch}" 不存在`);
  if (ref.status !== 200) throw new Error(`获取分支失败: ${explainError(ref.status, ref.data)}`);
  const baseSha = ref.data.object.sha;

  // 2. 获取当前 commit 信息
  const commitInfo = await ghRequest('GET', `/repos/${owner}/${repo}/git/commits/${baseSha}`, token);
  if (commitInfo.status !== 200) throw new Error(`获取 commit 信息失败: ${explainError(commitInfo.status, commitInfo.data)}`);

  // 3. 获取文件树（递归）
  const treeRes = await ghRequest('GET', `/repos/${owner}/${repo}/git/trees/${commitInfo.data.tree.sha}?recursive=1`, token);
  if (treeRes.status !== 200) throw new Error(`获取文件树失败: ${explainError(treeRes.status, treeRes.data)}`);

  const allItems = treeRes.data.tree || [];
  const allFiles = allItems.filter(item => item.type === 'blob');

  // 4. 规范化要删除的路径，支持文件和文件夹
  // 如果路径是文件夹，则展开为该文件夹下的所有文件
  const deletePaths = new Set();
  for (const fp of filePaths) {
    const cleanPath = sanitizePath(fp);
    deletePaths.add(cleanPath);
  }

  // 5. 找出所有要删除的文件（包括文件夹下的所有文件）
  const filesToDelete = allFiles.filter(f => {
    // 精确匹配文件路径
    if (deletePaths.has(f.path)) return true;
    // 检查是否在某个被删除的文件夹下
    for (const dp of deletePaths) {
      if (f.path.startsWith(dp + '/')) return true;
    }
    return false;
  });
  if (filesToDelete.length === 0) {
    throw new Error('指定的文件或文件夹在仓库中不存在');
  }

  // 要删除的文件路径集合
  const deleteSet = new Set(filesToDelete.map(f => f.path));

  // 6. 使用 base_tree + sha:null 方式删除文件（正确做法）
  // GitHub Trees API 支持在 base_tree 基础上，通过设置 sha:null 来删除指定条目
  // 这样可以保留目录结构，避免 "Invalid tree info" 错误
  const batchSize = 500;
  let newTreeSha = commitInfo.data.tree.sha;

  // 构建删除项列表
  const deleteItems = filesToDelete.map(f => ({
    path: f.path,
    mode: f.mode || '100644',
    type: 'blob',
    sha: null  // sha:null 表示删除该条目
  }));

  // 分批处理（每批最多 500 个）
  for (let i = 0; i < deleteItems.length; i += batchSize) {
    const batch = deleteItems.slice(i, i + batchSize);
    const treeRes = await ghRequest('POST', `/repos/${owner}/${repo}/git/trees`, token, {
      base_tree: newTreeSha,
      tree: batch
    });
    if (treeRes.status < 200 || treeRes.status >= 300) {
      throw new Error(`创建 tree 失败: ${explainError(treeRes.status, treeRes.data)}`);
    }
    newTreeSha = treeRes.data.sha;
  }

  // 8. 创建 commit
  const commitMsg = `删除 ${filesToDelete.length} 个文件\n\n由 GitShip 工具执行\n\n删除的文件:\n${filesToDelete.map(f => '- ' + f.path).join('\n')}`;
  const commit = await ghRequest('POST', `/repos/${owner}/${repo}/git/commits`, token, {
    message: commitMsg,
    parents: [baseSha],
    tree: newTreeSha
  });
  if (commit.status < 200 || commit.status >= 300) {
    throw new Error(`创建 commit 失败: ${explainError(commit.status, commit.data)}`);
  }

  // 9. 更新分支引用
  const push = await ghRequest('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, token, {
    sha: commit.data.sha,
    force: false
  });
  if (push.status < 200 || push.status >= 300) {
    throw new Error(`更新分支失败: ${explainError(push.status, push.data)}`);
  }

  return {
    commitSha: commit.data.sha,
    deletedCount: filesToDelete.length,
    deletedFiles: filesToDelete.map(f => f.path)
  };
}

// 获取仓库中单个文件的内容（用于在线浏览）
async function getRepoFileContent(owner, repo, path, branch, token) {
  const safePath = sanitizePath(path);
  if (!safePath) throw new Error('文件路径无效');

  const r = await ghRequest('GET', `/repos/${owner}/${repo}/contents/${encodeURIComponent(safePath)}?ref=${encodeURIComponent(branch)}`, token);
  if (r.status === 404) throw new Error('文件不存在');
  if (r.status !== 200) throw new Error(`获取文件内容失败: ${explainError(r.status, r.data)}`);

  const data = r.data;
  if (data.type !== 'file') throw new Error('路径不是文件');

  // 判断是否为二进制文件（图片、PDF 等）
  const binaryExts = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg', '.pdf', '.zip', '.tar', '.gz', '.exe', '.dll', '.so', '.bin'];
  const isBinary = binaryExts.some(ext => safePath.toLowerCase().endsWith(ext));
  const ext = safePath.split('.').pop().toLowerCase();

  let content = '';
  let encoding = 'text';

  if (data.content && data.encoding === 'base64') {
    if (isBinary && data.size < 1024 * 1024) {
      // 小图片返回 base64 用于前端预览
      content = data.content;
      encoding = 'base64';
    } else if (isBinary) {
      content = '(二进制文件，无法预览)';
      encoding = 'binary';
    } else {
      // 文本文件：base64 解码
      content = Buffer.from(data.content, 'base64').toString('utf8');
      encoding = 'text';
    }
  }

  return {
    path: safePath,
    content,
    encoding,
    size: data.size || 0,
    sha: data.sha || '',
    ext,
    isBinary
  };
}

// 检查 GitHub Token 有效性和权限
async function checkTokenStatus(token) {
  // 1. 验证 Token 本身是否有效
  const userRes = await ghRequest('GET', '/user', token);
  if (userRes.status === 401) {
    return { valid: false, expired: true, message: 'Token 无效或已过期', scopes: [] };
  }
  if (userRes.status === 403) {
    // 可能被限流
    const remaining = userRes.headers ? '' : '';
    return { valid: false, expired: false, rateLimited: true, message: 'GitHub API 限流，请稍后重试', scopes: [] };
  }
  if (userRes.status !== 200) {
    return { valid: false, expired: false, message: `GitHub 返回 ${userRes.status}`, scopes: [] };
  }

  // 2. 获取 Token 的 scopes（通过响应头 X-OAuth-Scopes）
  // 注意：ghRequest 不返回 headers，所以通过 rate limit 接口获取
  const rateRes = await ghRequest('GET', '/rate_limit', token);
  const scopes = [];

  // 3. 检查 repo 权限（能否访问私有仓库）
  const canAccessRepo = true; // 简化：如果 /user 成功，说明 token 有效

  // 4. 获取 Token 关联的用户信息
  const userInfo = {
    login: userRes.data.login || '',
    name: userRes.data.name || '',
    avatar: userRes.data.avatar_url || '',
    id: userRes.data.id || 0
  };

  // 5. 获取剩余 API 调用次数
  let remaining = -1;
  let resetTime = null;
  if (rateRes.status === 200 && rateRes.data && rateRes.data.rate) {
    remaining = rateRes.data.rate.remaining;
    resetTime = rateRes.data.rate.reset;
  }

  return {
    valid: true,
    expired: false,
    message: 'Token 有效',
    userInfo,
    remaining,
    resetTime,
    scopes
  };
}

// 创建或更新文件（使用 GitHub Contents API）
async function createOrUpdateFile(owner, repo, path, content, branch, commitMsg, token) {
  const safePath = sanitizePath(path);
  if (!safePath) throw new Error('文件路径无效');

  const r = await ghRequest('PUT', `/repos/${owner}/${repo}/contents/${encodeURIComponent(safePath)}`, token, {
    message: commitMsg,
    content: Buffer.from(content).toString('base64'),
    branch: branch
  });
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`创建/更新文件失败: ${explainError(r.status, r.data)}`);
  }

  return {
    commitSha: (r.data.commit && r.data.commit.sha) ? r.data.commit.sha : '',
    path: safePath,
    message: commitMsg
  };
}

// 仅创建新文件（如已存在则报错）
async function createFileInRepo(owner, repo, path, content, branch, commitMsg, token) {
  const safePath = sanitizePath(path);
  if (!safePath) throw new Error('文件路径无效');

  // 检查文件是否已存在
  const check = await ghRequest('GET', `/repos/${owner}/${repo}/contents/${encodeURIComponent(safePath)}?ref=${encodeURIComponent(branch)}`, token);
  if (check.status === 200) {
    throw new Error(`文件已存在: ${safePath}`);
  }
  if (check.status !== 404) {
    throw new Error(`检查文件是否存在失败: ${explainError(check.status, check.data)}`);
  }

  return createOrUpdateFile(owner, repo, safePath, content, branch, commitMsg, token);
}

// 重命名/移动文件：读取旧文件内容 -> 新路径创建文件 -> 删除旧文件
async function renameFile(owner, repo, oldPath, newPath, branch, commitMsg, token) {
  const safeOldPath = sanitizePath(oldPath);
  const safeNewPath = sanitizePath(newPath);
  if (!safeOldPath) throw new Error('原文件路径无效');
  if (!safeNewPath) throw new Error('目标文件路径无效');
  if (safeOldPath === safeNewPath) throw new Error('原路径与目标路径相同');

  // 1. 获取原文件内容
  const file = await getRepoFileContent(owner, repo, safeOldPath, branch, token);

  // 处理内容编码：
  // getRepoFileContent 对文本文件返回解码后的 utf8 字符串（encoding='text'），
  // 对小二进制文件返回 base64 字符串（encoding='base64'），
  // 对大二进制文件返回占位文本（encoding='binary'）。
  let content;
  if (file.encoding === 'base64') {
    // 先解码为原始字节，交由 createOrUpdateFile 重新 base64 编码（避免双重编码）
    content = Buffer.from(file.content, 'base64');
  } else if (file.encoding === 'binary') {
    throw new Error('无法重命名二进制文件（文件过大，无法获取内容）');
  } else {
    content = file.content;
  }

  // 2. 在新路径创建文件
  await createOrUpdateFile(owner, repo, safeNewPath, content, branch, commitMsg, token);

  // 3. 删除旧路径文件
  await deleteFiles(owner, repo, branch, [safeOldPath], token);

  return {
    oldPath: safeOldPath,
    newPath: safeNewPath,
    message: commitMsg
  };
}

// 获取指定目录的文件树（非递归，使用 GitHub Contents API）
async function getFileTree(owner, repo, branch, token, dirPath) {
  const safePath = sanitizePath(dirPath || '');
  const url = safePath
    ? `/repos/${owner}/${repo}/contents/${encodeURIComponent(safePath)}?ref=${encodeURIComponent(branch)}`
    : `/repos/${owner}/${repo}/contents/?ref=${encodeURIComponent(branch)}`;

  const r = await ghRequest('GET', url, token);
  if (r.status === 404) throw new Error(`目录 "${dirPath || '/'}" 不存在`);
  if (r.status !== 200) throw new Error(`获取文件树失败: ${explainError(r.status, r.data)}`);

  const items = Array.isArray(r.data) ? r.data : [];
  return items.map(item => ({
    name: item.name,
    path: item.path,
    type: item.type, // 'file' | 'dir'
    size: item.size || 0,
    sha: item.sha || ''
  }));
}

// 创建或更新仓库中的单个文件（基于 Contents API）
// 如果文件已存在则更新，不存在则创建
async function createOrUpdateFile(owner, repo, path, content, branch, commitMsg, token) {
  const safePath = sanitizePath(path);
  if (!safePath) throw new Error('文件路径无效');

  // 1. 查询文件是否已存在，获取其 sha（更新时需要）
  let existingSha = null;
  const checkRes = await ghRequest('GET', `/repos/${owner}/${repo}/contents/${encodeURIComponent(safePath)}?ref=${encodeURIComponent(branch)}`, token);
  if (checkRes.status === 200 && checkRes.data && checkRes.data.sha) {
    existingSha = checkRes.data.sha;
  } else if (checkRes.status !== 404) {
    // 404 是正常的（文件不存在，将创建），其他错误需要处理
    throw new Error(`检查文件状态失败: ${explainError(checkRes.status, checkRes.data)}`);
  }

  // 2. 使用 Contents API 创建/更新文件
  const payload = {
    message: commitMsg,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: branch
  };
  if (existingSha) payload.sha = existingSha;

  const r = await ghRequest('PUT', `/repos/${owner}/${repo}/contents/${encodeURIComponent(safePath)}`, token, payload);
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`保存文件失败: ${explainError(r.status, r.data)}`);
  }

  return {
    commitSha: r.data.commit ? r.data.commit.sha : null,
    contentSha: r.data.content ? r.data.content.sha : null,
    path: safePath,
    action: existingSha ? 'updated' : 'created'
  };
}

// 在仓库中新建文件（若已存在则报错）
async function createFileInRepo(owner, repo, path, content, branch, commitMsg, token) {
  const safePath = sanitizePath(path);
  if (!safePath) throw new Error('文件路径无效');

  // 1. 检查文件是否已存在
  const checkRes = await ghRequest('GET', `/repos/${owner}/${repo}/contents/${encodeURIComponent(safePath)}?ref=${encodeURIComponent(branch)}`, token);
  if (checkRes.status === 200) {
    throw new Error(`文件已存在: ${safePath}`);
  } else if (checkRes.status !== 404) {
    throw new Error(`检查文件状态失败: ${explainError(checkRes.status, checkRes.data)}`);
  }

  // 2. 创建新文件
  const payload = {
    message: commitMsg,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: branch
  };

  const r = await ghRequest('PUT', `/repos/${owner}/${repo}/contents/${encodeURIComponent(safePath)}`, token, payload);
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`创建文件失败: ${explainError(r.status, r.data)}`);
  }

  return {
    commitSha: r.data.commit ? r.data.commit.sha : null,
    contentSha: r.data.content ? r.data.content.sha : null,
    path: safePath
  };
}

// 重命名文件：读取旧文件内容 -> 在新路径创建 -> 删除旧文件
// 注意：GitHub 没有原生的重命名 API，这里通过"创建新路径 + 删除旧路径"实现
async function renameFile(owner, repo, oldPath, newPath, branch, commitMsg, token) {
  const safeOldPath = sanitizePath(oldPath);
  const safeNewPath = sanitizePath(newPath);
  if (!safeOldPath) throw new Error('原文件路径无效');
  if (!safeNewPath) throw new Error('新文件路径无效');
  if (safeOldPath === safeNewPath) throw new Error('新旧路径相同，无需重命名');

  // 1. 读取旧文件内容
  const getRes = await ghRequest('GET', `/repos/${owner}/${repo}/contents/${encodeURIComponent(safeOldPath)}?ref=${encodeURIComponent(branch)}`, token);
  if (getRes.status === 404) throw new Error(`原文件不存在: ${safeOldPath}`);
  if (getRes.status !== 200) throw new Error(`读取原文件失败: ${explainError(getRes.status, getRes.data)}`);
  if (getRes.data.type !== 'file') throw new Error('原路径不是文件，无法重命名');

  const fileContent = getRes.data.content || '';
  // GitHub 返回的 content 可能包含换行符，需要清理后解码
  const cleanContent = fileContent.replace(/\n/g, '');
  const decodedContent = Buffer.from(cleanContent, 'base64').toString('utf8');

  // 2. 在新路径创建文件（使用旧文件的 sha 作为基础，避免重复传输内容）
  //    使用 Contents API 创建新文件
  const createPayload = {
    message: commitMsg,
    content: cleanContent, // 直接复用 base64 内容
    branch: branch
  };
  // 如果新路径已存在，先检查
  const checkNewRes = await ghRequest('GET', `/repos/${owner}/${repo}/contents/${encodeURIComponent(safeNewPath)}?ref=${encodeURIComponent(branch)}`, token);
  if (checkNewRes.status === 200) {
    throw new Error(`目标文件已存在: ${safeNewPath}`);
  } else if (checkNewRes.status !== 404) {
    throw new Error(`检查目标文件状态失败: ${explainError(checkNewRes.status, checkNewRes.data)}`);
  }

  const createRes = await ghRequest('PUT', `/repos/${owner}/${repo}/contents/${encodeURIComponent(safeNewPath)}`, token, createPayload);
  if (createRes.status < 200 || createRes.status >= 300) {
    throw new Error(`创建新文件失败: ${explainError(createRes.status, createRes.data)}`);
  }

  // 3. 删除旧文件
  const deletePayload = {
    message: commitMsg,
    sha: getRes.data.sha,
    branch: branch
  };
  const deleteRes = await ghRequest('DELETE', `/repos/${owner}/${repo}/contents/${encodeURIComponent(safeOldPath)}`, token, deletePayload);
  if (deleteRes.status < 200 || deleteRes.status >= 300) {
    throw new Error(`删除旧文件失败: ${explainError(deleteRes.status, deleteRes.data)}`);
  }

  return {
    commitSha: deleteRes.data.commit ? deleteRes.data.commit.sha : (createRes.data.commit ? createRes.data.commit.sha : null),
    oldPath: safeOldPath,
    newPath: safeNewPath
  };
}

// 获取仓库指定目录下的文件列表（可指定子路径，默认根目录）
// 基于 Contents API，返回目录下的直接子项
async function getFileTree(owner, repo, branch, token, dirPath = '') {
  const safePath = sanitizePath(dirPath);
  const apiPath = safePath
    ? `/repos/${owner}/${repo}/contents/${encodeURIComponent(safePath)}?ref=${encodeURIComponent(branch)}`
    : `/repos/${owner}/${repo}/contents?ref=${encodeURIComponent(branch)}`;

  const r = await ghRequest('GET', apiPath, token);
  if (r.status === 404) {
    // 目录不存在或为空
    return [];
  }
  if (r.status !== 200) {
    throw new Error(`获取目录列表失败: ${explainError(r.status, r.data)}`);
  }

  // Contents API 对目录返回数组，对文件返回对象
  const data = r.data;
  if (!Array.isArray(data)) {
    // 如果路径指向的是文件而非目录，返回包含该项的数组
    return [{
      name: data.name,
      path: data.path,
      type: data.type, // 'file' | 'dir'
      size: data.size || 0,
      sha: data.sha || ''
    }];
  }

  return data.map(item => ({
    name: item.name,
    path: item.path,
    type: item.type, // 'file' | 'dir'
    size: item.size || 0,
    sha: item.sha || ''
  }));
}

module.exports = { ghRequest, parseRepo, explainError, uploadFiles, initEmptyRepo, clearRepoFiles, getRepoFileTree, getRepoArchiveUrl, downloadRepoArchive, deleteFiles, sanitizePath, getRepoFileContent, checkTokenStatus, createOrUpdateFile, createFileInRepo, renameFile, getFileTree };
