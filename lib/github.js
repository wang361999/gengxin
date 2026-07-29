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
  const readmeContent = Buffer.from(`# ${repo}\n\nThis repository is managed by GitUpload.\n`).toString('base64');
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
    message: 'Initial commit: README.md\n\n由 GitUpload 工具自动创建',
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
  const files = allItems
    .filter(item => item.type === 'blob')
    .map(item => ({
      path: item.path,
      size: item.size || 0,
      type: item.type
    }));

  return {
    files,
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
    const readmeContent = Buffer.from('# ' + repo + '\n\nThis repository is managed by GitUpload.\n').toString('base64');
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
    message: `清空仓库：删除 ${deletedCount} 个文件（保留 README.md）\n\n由 GitUpload 工具执行`,
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

  // 4. 规范化要删除的文件路径
  const deleteSet = new Set();
  for (const fp of filePaths) {
    deleteSet.add(sanitizePath(fp));
  }

  // 5. 检查是否有文件被删除
  const filesToDelete = allFiles.filter(f => deleteSet.has(f.path));
  if (filesToDelete.length === 0) {
    throw new Error('指定的文件在仓库中不存在');
  }

  // 6. 构建 tree items：保留未被删除的文件
  const keptItems = allFiles
    .filter(f => !deleteSet.has(f.path))
    .map(f => ({ path: f.path, sha: f.sha, mode: f.mode || '100644', type: 'blob' }));

  // 7. 创建新 tree（包含所有保留的文件，不包含被删除的文件）
  let newTreeSha = commitInfo.data.tree.sha;
  // 如果保留的文件数不等于全部文件数，说明有删除，创建新 tree
  if (keptItems.length !== allFiles.length) {
    // 创建新的 tree，只包含保留的文件
    // 使用 base_tree 然后 tree 中删除指定文件（path 设为 null 也可，但 GitHub 不支持）
    // 实际做法是：创建一个全新的 tree，列出所有保留的文件
    let currentBase = commitInfo.data.tree.sha;
    const batchSize = 500;
    for (let i = 0; i < keptItems.length; i += batchSize) {
      const batch = keptItems.slice(i, i + batchSize);
      const r = await ghRequest('POST', `/repos/${owner}/${repo}/git/trees`, token, {
        tree: batch
      });
      if (r.status < 200 || r.status >= 300) {
        throw new Error(`创建 tree 失败: ${explainError(r.status, r.data)}`);
      }
      currentBase = r.data.sha;
    }
    // 如果有保留文件，最后一轮创建的 tree 即为最终 tree
    if (keptItems.length > 0) {
      // 需要分批处理：每次基于前一个 tree 添加
      // 但更好的方式是：一次性创建包含所有保留文件的 tree
      // 实际上上面的循环有问题，应该只创建一次 tree
      // 修正：一次性创建
      const createTreeRes = await ghRequest('POST', `/repos/${owner}/${repo}/git/trees`, token, {
        tree: keptItems.slice(0, batchSize)
      });
      if (createTreeRes.status < 200 || createTreeRes.status >= 300) {
        throw new Error(`创建 tree 失败: ${explainError(createTreeRes.status, createTreeRes.data)}`);
      }
      newTreeSha = createTreeRes.data.sha;

      // 如果超过 500 个文件，继续追加
      for (let i = batchSize; i < keptItems.length; i += batchSize) {
        const batch = keptItems.slice(i, i + batchSize);
        const r = await ghRequest('POST', `/repos/${owner}/${repo}/git/trees`, token, {
          base_tree: newTreeSha,
          tree: batch
        });
        if (r.status < 200 || r.status >= 300) {
          throw new Error(`创建 tree 失败: ${explainError(r.status, r.data)}`);
        }
        newTreeSha = r.data.sha;
      }
    } else {
      // 删除所有文件，创建空 tree
      const emptyTreeRes = await ghRequest('POST', `/repos/${owner}/${repo}/git/trees`, token, {
        tree: []
      });
      if (emptyTreeRes.status < 200 || emptyTreeRes.status >= 300) {
        throw new Error(`创建空 tree 失败: ${explainError(emptyTreeRes.status, emptyTreeRes.data)}`);
      }
      newTreeSha = emptyTreeRes.data.sha;
    }
  } else {
    // 没有文件被删除（不应该到达这里）
    return { commitSha: baseSha, deletedCount: 0 };
  }

  // 8. 创建 commit
  const commitMsg = `删除 ${filesToDelete.length} 个文件\n\n由 GitUpload 工具执行\n\n删除的文件:\n${filesToDelete.map(f => '- ' + f.path).join('\n')}`;
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

module.exports = { ghRequest, parseRepo, explainError, uploadFiles, initEmptyRepo, clearRepoFiles, getRepoFileTree, getRepoArchiveUrl, downloadRepoArchive, deleteFiles, sanitizePath };
