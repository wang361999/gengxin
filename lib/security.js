'use strict';

/**
 * 安全加固和性能优化中间件
 *
 * 提供：
 * 1. 安全 HTTP 头设置（防点击劫持、MIME 嗅探、降级等）
 * 2. 输入净化（去空格、限长、去 null 字节与控制字符）
 * 3. SQL 注入检测
 * 4. XSS 检测
 * 5. 请求体验证（类型 / 必填 / 长度 / 正则）
 * 6. CSRF token 生成与时间安全验证
 * 7. 内容安全策略(CSP)生成
 */

const crypto = require('crypto');

// ============ 1. 安全 HTTP 头 ============

/**
 * 在响应对象上设置安全 HTTP 头
 * @param {object} res - HTTP 响应对象（需具备 setHeader 方法）
 */
function setSecurityHeaders(res) {
  if (!res || typeof res.setHeader !== 'function') return;
  try {
    // 防止点击劫持：禁止任何页面通过 iframe 嵌入本站
    res.setHeader('X-Frame-Options', 'DENY');
    // 禁止 MIME 类型嗅探
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // 限制 Referer 泄漏，仅在同源跨域时发送完整来源
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    // 禁用敏感浏览器能力（摄像头、麦克风、地理位置、支付等）
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()'
    );
    // 强制 HTTPS（2 年，含子域名与预加载）
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    // 启用浏览器内置 XSS 过滤器
    res.setHeader('X-XSS-Protection', '1; mode=block');
    // 禁止 Adobe / Flash 等跨域策略文件读取
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    // 隔离顶级浏览上下文，防止跨源 opener 干扰
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    // 要求跨源资源携带 CORP 头，实现跨源隔离
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    // 内容安全策略
    res.setHeader('Content-Security-Policy', getCSPHeader());
  } catch {
    // 设置头失败不应中断响应流程，静默忽略
  }
}

// ============ 2. 输入净化 ============

/**
 * 净化输入字符串
 * - 去除首尾空格
 * - 限制最大长度（默认 1000）
 * - 移除 null 字节
 * - 移除控制字符（保留 \t \n \r）
 *
 * 注意：单引号等 SQL 特殊字符不在此处转义或修改原文本，
 *       仅由 detectSQLInjection / detectXSS 用于检测，
 *       避免破坏合法输入内容。
 *
 * @param {string} str - 原始输入
 * @param {number} [maxLength=1000] - 最大长度
 * @returns {string} 净化后的字符串
 */
function sanitizeInput(str, maxLength = 1000) {
  try {
    if (str === null || str === undefined) return '';
    let s = String(str);

    // 去除首尾空格
    s = s.trim();

    // 限制最大长度
    const max = Number.isFinite(maxLength) && maxLength > 0 ? Math.floor(maxLength) : 1000;
    if (s.length > max) s = s.slice(0, max);

    // 移除 null 字节
    s = s.replace(/\0/g, '');

    // 移除控制字符（保留制表符 \t、换行 \n、回车 \r）
    s = s.replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

    return s;
  } catch {
    return '';
  }
}

// ============ 3. SQL 注入检测 ============

/**
 * 检测常见 SQL 注入模式
 * 覆盖：UNION SELECT、OR/AND 1=1、注释符、DROP/DELETE/INSERT/UPDATE/SELECT、
 *       存储过程、延时注入、堆叠查询等。
 *
 * @param {string} input - 待检测输入
 * @returns {boolean} true 表示疑似 SQL 注入
 */
function detectSQLInjection(input) {
  try {
    if (input === null || input === undefined) return false;
    const s = String(input);
    const patterns = [
      /\bunion\s+(all\s+)?select\b/i,
      /\bor\s+\d+\s*=\s*\d+/i,
      /\band\s+\d+\s*=\s*\d+/i,
      /\bor\s+['"]?\w+['"]?\s*=\s*['"]?\w+['"]?/i,
      /--/, // SQL 行注释
      /\/\*/, // 块注释起始
      /\*\//, // 块注释结束
      /\bdrop\s+table\b/i,
      /\bdelete\s+from\b/i,
      /\binsert\s+into\b/i,
      /\bupdate\s+\w+\s+set\b/i,
      /\bselect\s+.+\s+from\b/i,
      /\btruncate\s+table\b/i,
      /\bexec(\s|\()/i,
      /\bxp_\w+/i,
      /\bwaitfor\s+delay\b/i,
      /\bsleep\s*\(/i,
      /\bbenchmark\s*\(/i,
      /\bload_file\s*\(/i,
      /\binto\s+(outfile|dumpfile)\b/i,
      /;\s*(drop|delete|insert|update|select|alter|create)\b/i, // 堆叠查询
    ];
    return patterns.some((re) => re.test(s));
  } catch {
    return false;
  }
}

// ============ 4. XSS 检测 ============

/**
 * 检测常见 XSS 攻击模式
 * 覆盖：<script>、onerror=、onload= 等事件处理器、javascript: 伪协议、
 *       <iframe>、<object>、<embed>、<svg>、<base>、data:text/html 等。
 *
 * @param {string} input - 待检测输入
 * @returns {boolean} true 表示疑似 XSS
 */
function detectXSS(input) {
  try {
    if (input === null || input === undefined) return false;
    const s = String(input);
    const patterns = [
      /<script[\s>]/i,
      /<\/script>/i,
      /\bon(error|load|click|mouseover|focus|submit|change|toggle)\s*=/i, // 常见事件处理器
      /javascript:/i,
      /vbscript:/i,
      /<iframe[\s>]/i,
      /<object[\s>]/i,
      /<embed[\s>]/i,
      /<svg[\s>]/i,
      /<base[\s>]/i,
      /<img[^>]+on\w+\s*=/i,
      /data:text\/html/i,
      /<form[\s>]/i,
      /<meta[^>]+http-equiv/i,
    ];
    return patterns.some((re) => re.test(s));
  } catch {
    return false;
  }
}

// ============ 5. 请求体验证 ============

/**
 * 根据规则验证请求体
 * @param {object} body - 请求体对象
 * @param {object} rules - 规则对象
 *   格式: { field: { type: 'string'|'number'|'boolean', required: bool, maxLength: num, pattern: regex } }
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateRequestBody(body, rules) {
  try {
    if (!body || typeof body !== 'object') {
      return { valid: false, errors: ['请求体无效'] };
    }
    if (!rules || typeof rules !== 'object') {
      return { valid: true, errors: [] };
    }

    const errors = [];

    for (const field of Object.keys(rules)) {
      const rule = rules[field] || {};
      const value = body[field];

      // 必填校验
      if (rule.required && (value === undefined || value === null || value === '')) {
        errors.push(`字段 "${field}" 为必填项`);
        continue;
      }

      // 字段未提供则跳过后续校验
      if (value === undefined || value === null) continue;

      // 类型校验
      if (rule.type) {
        const actual = typeof value;
        if (rule.type === 'string' && actual !== 'string') {
          errors.push(`字段 "${field}" 应为 string 类型`);
          continue;
        }
        if (rule.type === 'number' && (actual !== 'number' || !Number.isFinite(value))) {
          errors.push(`字段 "${field}" 应为 number 类型`);
          continue;
        }
        if (rule.type === 'boolean' && actual !== 'boolean') {
          errors.push(`字段 "${field}" 应为 boolean 类型`);
          continue;
        }
      }

      // 字符串最大长度校验
      if (rule.maxLength !== undefined && typeof value === 'string') {
        const limit = Number(rule.maxLength);
        if (Number.isFinite(limit) && value.length > limit) {
          errors.push(`字段 "${field}" 长度超过最大值 ${limit}`);
        }
      }

      // 正则格式校验
      if (rule.pattern && rule.pattern instanceof RegExp && typeof value === 'string') {
        if (!rule.pattern.test(value)) {
          errors.push(`字段 "${field}" 格式不正确`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  } catch {
    return { valid: false, errors: ['请求体验证发生异常'] };
  }
}

// ============ 6. CSRF token 生成与验证 ============

/**
 * 生成随机 CSRF token（256 位熵，hex 编码）
 * @returns {string} CSRF token
 */
function generateCSRFToken() {
  try {
    return crypto.randomBytes(32).toString('hex');
  } catch {
    // 降级方案：时间戳 + 随机数（仅在 crypto.randomBytes 不可用时）
    return Date.now().toString(16) + Math.random().toString(36).slice(2);
  }
}

/**
 * 使用恒定时间比较验证 CSRF token，防止时序攻击
 * @param {string} token - 待验证 token
 * @param {string} expected - 期望 token
 * @returns {boolean} true 表示匹配
 */
function verifyCSRFToken(token, expected) {
  try {
    if (!token || !expected) return false;
    const a = Buffer.from(String(token));
    const b = Buffer.from(String(expected));
    // 长度不同直接返回 false，避免 timingSafeEqual 抛错
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ============ 7. 内容安全策略(CSP) ============

/**
 * 生成内容安全策略(CSP)头字符串
 * - script-src: 'self' 'unsafe-inline'（页面含内联脚本）
 * - style-src: 'self' 'unsafe-inline'（页面含内联样式）
 * - img-src: 'self' data: https:
 * - connect-src: 'self' https://api.github.com
 * - font-src: 'self'
 * - object-src: 'none'
 * - frame-ancestors: 'self'
 * @returns {string} CSP 头值
 */
function getCSPHeader() {
  try {
    return [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "connect-src 'self' https://api.github.com",
      "font-src 'self'",
      "object-src 'none'",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ');
  } catch {
    return "default-src 'self'";
  }
}

// ============ 导出 ============

module.exports = {
  setSecurityHeaders,
  sanitizeInput,
  detectSQLInjection,
  detectXSS,
  validateRequestBody,
  generateCSRFToken,
  verifyCSRFToken,
  getCSPHeader,
};
