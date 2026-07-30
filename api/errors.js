const { sendJson, readBody } = require('../lib/helpers');
const { logError } = require('../lib/db');
const { rateLimit, getClientIp, cleanupStore } = require('../lib/rateLimit');

// 错误上报限流：每 IP 每分钟最多 50 条错误
const errorLimiter = rateLimit({ windowMs: 60 * 1000, max: 50 });

// 单批最大条数，超出截断
const MAX_BATCH = 50;

module.exports = async (req, res) => {
  // 仅允许 POST（错误上报）和 OPTIONS（CORS 预检）
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: '只支持 POST' });
  }

  try {
    const ip = getClientIp(req);

    // 限流：每 IP 每分钟最多 50 条
    cleanupStore();
    if (errorLimiter(ip)) {
      return sendJson(res, 429, { error: '请求过于频繁，请稍后再试' });
    }

    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: '请求体解析失败' });
    }

    // 兼容单条对象与批量数组
    let errors;
    if (Array.isArray(body)) {
      errors = body;
    } else if (body && typeof body === 'object') {
      // 支持包装格式 { errors: [...] }
      if (Array.isArray(body.errors)) {
        errors = body.errors;
      } else {
        errors = [body];
      }
    } else {
      return sendJson(res, 400, { error: '请求体必须为对象或数组' });
    }

    if (errors.length === 0) {
      return sendJson(res, 400, { error: '错误数据为空' });
    }

    // 截断批量大小，防止滥用
    const truncated = errors.length > MAX_BATCH;
    if (truncated) {
      errors = errors.slice(0, MAX_BATCH);
    }

    // 补充 IP 地址，逐条入库（失败不阻断后续）
    let saved = 0;
    let failed = 0;
    for (const err of errors) {
      if (!err || typeof err !== 'object') {
        failed++;
        continue;
      }
      try {
        await logError({
          ...err,
          ip_address: err.ip_address || err.ipAddress || ip
        });
        saved++;
      } catch (e) {
        failed++;
      }
    }

    return sendJson(res, 200, {
      ok: true,
      received: errors.length,
      saved,
      failed,
      truncated
    });
  } catch (err) {
    return sendJson(res, 500, { error: err.message || '服务器错误' });
  }
};
