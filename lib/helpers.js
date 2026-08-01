// 安全头注入：所有 JSON 响应自动添加安全头
function sendJson(res, code, data) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // 安全头注入
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
  } catch {}
  res.end(JSON.stringify(data));
}

// 请求体大小限制（防止大请求 DoS）
const MAX_BODY_SIZE = 150 * 1024 * 1024; // 150MB（上传需要大限制）

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  const chunks = [];
  let totalSize = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalSize += buf.length;
    if (totalSize > MAX_BODY_SIZE) {
      throw new Error('请求体过大');
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

module.exports = { sendJson, readBody, MAX_BODY_SIZE };
