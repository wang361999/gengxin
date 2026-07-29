const AdmZip = require('adm-zip');
const tar = require('tar');
const { sendJson, readBody } = require('../lib/helpers');
const { requireAuth, initSecret } = require('../lib/auth');
const { getRepo, addHistory, checkUploadLimit, incrementUploadUsage, getSetting } = require('../lib/db');
const { decrypt } = require('../lib/crypto');
const { parseRepo, uploadFiles, sanitizePath } = require('../lib/github');
const { uploadLimiter, getClientIp, cleanupStore } = require('../lib/rateLimit');
const { triggerWebhook } = require('../lib/webhook');

// 从压缩包 buffer 中提取文件列表
async function extractFiles(buffer, fileName) {
  const lowerName = String(fileName || '').toLowerCase();

  // 判断格式
  if (lowerName.endsWith('.zip')) {
    return extractFromZip(buffer);
  }
  if (lowerName.endsWith('.tar.gz') || lowerName.endsWith('.tgz') || lowerName.endsWith('.tar')) {
    return extractFromTar(buffer, lowerName.endsWith('.tar'));
  }
  // 如果没有扩展名，尝试通过 magic bytes 判断
  // ZIP: PK\x03\x04
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04) {
    return extractFromZip(buffer);
  }
  // gzip: 1f 8b
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    return extractFromTar(buffer, false);
  }
  // tar: ustar at offset 257
  if (buffer.length >= 263 && buffer.toString('utf8', 257, 262) === 'ustar') {
    return extractFromTar(buffer, true);
  }

  throw new Error('不支持的文件格式，支持 ZIP、TAR、TAR.GZ、TGZ');
}

// 从 ZIP 提取
function extractFromZip(buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.replace(/\\/g, '/');
    if (name.includes('__MACOSX/') || name.endsWith('.DS_Store') || name.startsWith('.git/')) continue;
    files.push({ path: name, base64: entry.getData().toString('base64'), size: entry.header.size });
  }
  return { files, format: 'zip', totalCount: entries.length };
}

// 从 TAR / TAR.GZ 提取
async function extractFromTar(buffer, isPlainTar) {
  const files = [];
  let totalCount = 0;
  const stream = require('stream');
  const readable = new stream.Readable();
  readable.push(buffer);
  readable.push(null);

  await new Promise((resolve, reject) => {
    const parser = tar.t({
      onentry: (entry) => {
        totalCount++;
        if (entry.type === 'Directory') return;
        const name = entry.path.replace(/\\/g, '/');
        if (name.includes('__MACOSX/') || name.endsWith('.DS_Store') || name.startsWith('.git/')) return;
        const chunks = [];
        entry.on('data', (c) => chunks.push(c));
        entry.on('end', () => {
          const content = Buffer.concat(chunks);
          files.push({ path: name, base64: content.toString('base64'), size: content.length });
        });
      },
      onend: resolve,
      onerror: reject
    });
    // 使用 gunzip 或者直接解析
    if (isPlainTar) {
      readable.pipe(parser);
    } else {
      const zlib = require('zlib');
      readable.pipe(zlib.createGunzip()).pipe(parser);
    }
  });

  return { files, format: isPlainTar ? 'tar' : 'tar.gz', totalCount };
}

// 处理单个上传请求
async function handleSingleUpload(body, user, res) {
  const repoId = body.repoId;
  if (!repoId) return sendJson(res, 400, { error: '请选择上传目标仓库' });

  // 检查上传限制（变现）- 先检查套餐限制
  const limitCheck = await checkUploadLimit(user.userId);
  if (!limitCheck.allowed) {
    return sendJson(res, 403, {
      error: limitCheck.message || '已达到上传上限',
      needUpgrade: true,
      plan: limitCheck.plan
    });
  }

  const plan = limitCheck.plan;
  // 根据套餐设置大小限制
  const maxSizeMB = plan.id === 'enterprise' ? 100 : plan.id === 'pro' ? 50 : 10;
  const maxBytes = maxSizeMB * 1024 * 1024;

  const fileBuffer = Buffer.from(body.file || body.zip, 'base64');
  const fileName = body.fileName || 'upload.zip';
  if (fileBuffer.length > maxBytes) return sendJson(res, 400, { error: `文件不能超过 ${maxSizeMB}MB（当前套餐：${plan.name}）`, needUpgrade: true });

  const config = await getRepo(user.userId, repoId);
  if (!config) return sendJson(res, 400, { error: '仓库配置不存在' });

  const token = decrypt(config.encToken);
  if (!token) return sendJson(res, 500, { error: 'Token 解密失败' });

  const branch = config.branch || 'main';
  const targetDir = config.targetDir || '.';
  const { owner, repo } = parseRepo(config.repo);

  // 提取压缩包文件（支持 ZIP / TAR / TAR.GZ / TGZ）
  let extracted;
  try {
    extracted = await extractFiles(fileBuffer, fileName);
  } catch (extractErr) {
    return sendJson(res, 400, { error: `文件解析失败: ${extractErr.message}` });
  }

  const allFiles = extracted.files;
  if (extracted.totalCount > 2000) return sendJson(res, 400, { error: '文件不能超过 2000 个' });

  // 拼接目标目录
  const files = allFiles.map(function(f) {
    const fullPath = targetDir === '.' ? f.path : targetDir + '/' + f.path;
    return { path: fullPath, base64: f.base64 };
  });

  if (files.length === 0) return sendJson(res, 400, { error: '压缩包内没有有效文件' });

  // 自定义 commit message，支持模板变量
  let commitMsg = body.commitMsg || `上传 ${files.length} 个文件`;
  commitMsg = commitMsg
    .replace(/\{count\}/g, String(files.length))
    .replace(/\{date\}/g, new Date().toISOString().split('T')[0])
    .replace(/\{filename\}/g, fileName)
    .replace(/\{repo\}/g, `${owner}/${repo}`);

  let result;
  try {
    result = await uploadFiles(owner, repo, files, branch, commitMsg, token);
  } catch (uploadErr) {
    const errMsg = String(uploadErr.message || '');
    return sendJson(res, 500, {
      error: `上传失败：${errMsg}`
    });
  }

  await addHistory(user.userId, {
    fileName: fileName,
    fileCount: files.length,
    size: fileBuffer.length,
    repo: `${owner}/${repo}`,
    branch,
    status: 'success',
    commitSha: result.commitSha
  });

  // 增加用量统计
  await incrementUploadUsage(user.userId, files.length, fileBuffer.length);

  // 触发 Webhook 通知
  triggerWebhook(user.userId, 'upload', {
    success: true,
    repo: `${owner}/${repo}`,
    branch,
    fileName,
    fileCount: files.length,
    commitSha: result.commitSha,
    format: extracted.format,
    timestamp: new Date().toISOString()
  }).catch(() => {});

  return {
    ok: true,
    message: `成功上传 ${files.length} 个文件到 ${config.name || owner + '/' + repo}`,
    fileCount: files.length,
    commitSha: result.commitSha,
    format: extracted.format
  };
}

module.exports = async (req, res) => {
  await initSecret();
  // ===== 文件预览（不实际上传） =====
  if (req.method === 'GET') {
    return sendJson(res, 405, { error: '只支持 POST' });
  }

  if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
  const user = await requireAuth(req, res);
  if (!user) return;

  // 限流
  cleanupStore();
  const ip = getClientIp(req);
  if (uploadLimiter(ip)) return sendJson(res, 429, { error: '上传请求过于频繁，请稍后再试' });

  try {
    const body = await readBody(req);

    // 文件预览模式：只解析不上传
    if (body.preview === true || body.preview === 'true') {
      const fileBuffer = Buffer.from(body.file || body.zip, 'base64');
      const fileName = body.fileName || 'upload.zip';
      let extracted;
      try {
        extracted = await extractFiles(fileBuffer, fileName);
      } catch (extractErr) {
        return sendJson(res, 400, { error: `文件解析失败: ${extractErr.message}` });
      }
      const fileList = extracted.files.map(function(f) {
        return { path: f.path, size: f.size || 0 };
      });
      return sendJson(res, 200, {
        ok: true,
        preview: true,
        files: fileList,
        totalFiles: fileList.length,
        totalEntries: extracted.totalCount,
        format: extracted.format,
        totalSize: fileBuffer.length
      });
    }

    // 批量上传模式：同一个文件上传到多个仓库
    if (body.batchRepos && Array.isArray(body.batchRepos) && body.batchRepos.length > 1) {
      const results = [];
      for (const repoId of body.batchRepos) {
        try {
          const result = await handleSingleUpload({ ...body, repoId, batchRepos: null }, user, res);
          if (result && result.ok) {
            results.push({ repoId, success: true, message: result.message, fileCount: result.fileCount, commitSha: result.commitSha });
          } else if (result) {
            results.push({ repoId, success: false, error: result.error || '上传失败' });
          }
        } catch (e) {
          results.push({ repoId, success: false, error: e.message });
        }
      }
      return sendJson(res, 200, { ok: true, batch: true, results, successCount: results.filter(function(r) { return r.success; }).length });
    }

    // 普通单仓库上传
    const result = await handleSingleUpload(body, user, res);
    if (result && result.ok) {
      return sendJson(res, 200, result);
    }
    // handleSingleUpload 已经通过 sendJson 返回了错误
  } catch (err) {
    return sendJson(res, 500, { error: err.message || '上传失败' });
  }
};
