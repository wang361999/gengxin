// 简单内存限流（IP 维度），适用于 Vercel Serverless 单实例
// 注意：Serverless 多实例场景下限流可能不精确，但能挡住大部分暴力攻击

const store = new Map(); // key -> { count, resetAt }

/**
 * 限流中间件
 * @param {object} opts - { windowMs: 时间窗口(ms), max: 最大请求数 }
 * @returns {function} 返回 true 表示被限流，false 表示放行
 */
function rateLimit(opts = {}) {
  const windowMs = opts.windowMs || 60 * 1000; // 默认 1 分钟
  const max = opts.max || 60; // 默认每分钟 60 次

  return function check(key) {
    const now = Date.now();
    const entry = store.get(key);

    if (!entry || now > entry.resetAt) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      return false;
    }

    entry.count++;
    if (entry.count > max) {
      return true; // 被限流
    }
    return false;
  };
}

// 预定义限流策略
const loginLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 }); // 登录每分钟 10 次
const registerLimiter = rateLimit({ windowMs: 60 * 1000, max: 5 }); // 注册每分钟 5 次
const uploadLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 }); // 上传每分钟 20 次
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 }); // 通用 API 每分钟 60 次

// 获取客户端 IP
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// 清理过期条目（防止内存泄漏，每次调用时随机清理）
function cleanupStore() {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now > entry.resetAt) store.delete(key);
  }
}

module.exports = { rateLimit, loginLimiter, registerLimiter, uploadLimiter, apiLimiter, getClientIp, cleanupStore };
