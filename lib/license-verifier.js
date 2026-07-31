/**
 * ET Studio 授权验证 SDK（Vercel Serverless 适配版）
 *
 * 原始 SDK 基于文件缓存和 setInterval，不适用于 Serverless 环境。
 * 本适配版将缓存改为内存缓存 + 数据库缓存，移除定时器。
 *
 * 授权服务器域名：gitd.cn
 * 验证接口：https://gitd.cn/api/license/verify
 */

'use strict';

// ============ 配置 ============
const CONFIG = {
  licenseKey: '',
  verifyUrl: '',
  checkInterval: 24 * 60 * 60 * 1000, // 24 小时
  requestTimeout: 10000, // 10 秒超时
};

// ============ 运行时状态（内存缓存，同一 serverless 实例内有效） ============
let isVerified = false;
let licenseInfo = null;
let lastCheckTime = null;
let onUnauthorized = null;

// ============ 数据库缓存（跨实例持久化） ============
let dbModule = null;

async function getDb() {
  if (!dbModule) {
    dbModule = require('./db');
  }
  return dbModule;
}

/** 从数据库读取缓存的授权信息 */
async function readCacheFromDB() {
  try {
    const db = await getDb();
    const cached = await db.getSetting('license_cache');
    if (cached) {
      return JSON.parse(cached);
    }
  } catch {
    // 忽略
  }
  return null;
}

/** 将授权信息写入数据库缓存 */
async function writeCacheToDB(data) {
  try {
    const db = await getDb();
    await db.updateSetting('license_cache', JSON.stringify(data));
  } catch {
    // 忽略
  }
}

/** 清除数据库缓存 */
async function clearCacheFromDB() {
  try {
    const db = await getDb();
    await db.updateSetting('license_cache', '');
  } catch {
    // 忽略
  }
}

// ============ 工具函数 ============

/** 获取当前运行域名 */
function getCurrentDomain() {
  if (process.env.LICENSE_DOMAIN) {
    return process.env.LICENSE_DOMAIN;
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || process.env.VERCEL_URL;
  if (appUrl) {
    return appUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '').split(':')[0];
  }

  if (typeof window !== 'undefined' && window.location) {
    return window.location.hostname;
  }

  return 'localhost';
}

// ============ 核心验证逻辑 ============

/**
 * 验证授权码
 * @param {Object} options - 可选覆盖配置
 * @returns {Promise<Object>} 验证结果
 */
async function verifyLicense(options = {}) {
  const licenseKey = options.licenseKey || CONFIG.licenseKey;
  const verifyUrl = options.verifyUrl || CONFIG.verifyUrl;
  const domain = options.domain || getCurrentDomain();

  if (!licenseKey) {
    return { valid: false, code: 'no_license', message: '未配置授权码' };
  }

  if (!verifyUrl) {
    return { valid: false, code: 'no_verify_url', message: '未配置验证接口地址' };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.requestTimeout);

    const response = await fetch(verifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: licenseKey, domain }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const data = await response.json();

    if (data.valid) {
      isVerified = true;
      licenseInfo = data;
      lastCheckTime = Date.now();
      await writeCacheToDB({
        valid: true,
        info: data,
        lastCheck: lastCheckTime,
        domain,
      });
    } else {
      isVerified = false;
      licenseInfo = null;
      await clearCacheFromDB();

      if (onUnauthorized && typeof onUnauthorized === 'function') {
        onUnauthorized(data);
      }
    }

    return data;
  } catch (error) {
    // 网络错误时检查数据库缓存（允许离线宽限 48 小时）
    const cache = await readCacheFromDB();
    if (cache && cache.valid && cache.info) {
      const cacheAge = Date.now() - (cache.lastCheck || 0);
      if (cacheAge < 48 * 60 * 60 * 1000) {
        isVerified = true;
        licenseInfo = cache.info;
        lastCheckTime = cache.lastCheck;
        return {
          valid: true,
          code: 'cached',
          message: '使用缓存授权（离线宽限期内）',
          ...cache.info,
        };
      }
    }

    isVerified = false;
    return {
      valid: false,
      code: 'network_error',
      message: `验证请求失败: ${error.message || '网络错误'}`,
    };
  }
}

/**
 * 初始化授权验证（项目启动时调用）
 * 在 Serverless 环境中，每次冷启动时会重新初始化
 */
async function initLicense(config) {
  if (!config || !config.licenseKey) {
    throw new Error('初始化失败：缺少 licenseKey');
  }
  if (!config.verifyUrl) {
    throw new Error('初始化失败：缺少 verifyUrl');
  }

  CONFIG.licenseKey = config.licenseKey;
  CONFIG.verifyUrl = config.verifyUrl;
  onUnauthorized = config.onUnauthorized || null;

  // 执行首次验证
  const result = await verifyLicense();

  // Serverless 环境不启动定时器，改为每次请求时检查
  return result;
}

/**
 * 检查授权状态（带缓存，避免每次请求都调用远程验证）
 * 如果距离上次验证不足 24 小时，直接返回缓存结果
 * @returns {Promise<Object>} 验证结果
 */
async function checkLicenseCached() {
  // 内存缓存有效且在 24 小时内
  if (isVerified && lastCheckTime && (Date.now() - lastCheckTime < CONFIG.checkInterval)) {
    return { valid: true, code: 'cached', message: '授权有效（缓存）' };
  }

  // 内存缓存过期，检查数据库缓存
  const dbCache = await readCacheFromDB();
  if (dbCache && dbCache.valid && dbCache.lastCheck) {
    const cacheAge = Date.now() - dbCache.lastCheck;
    if (cacheAge < CONFIG.checkInterval) {
      // 数据库缓存在有效期内
      isVerified = true;
      licenseInfo = dbCache.info;
      lastCheckTime = dbCache.lastCheck;
      return { valid: true, code: 'cached', message: '授权有效（数据库缓存）' };
    }
  }

  // 缓存过期，重新验证
  return await verifyLicense();
}

/**
 * 启动定时校验（Serverless 环境下空操作，实际靠 checkLicenseCached 按需验证）
 */
function startPeriodicCheck() {
  // Serverless 环境不使用 setInterval
  // 授权验证通过 checkLicenseCached() 在每次 API 请求时按需检查
}

/**
 * 停止定时校验
 */
function stopPeriodicCheck() {
  // No-op in serverless
}

/**
 * 获取当前授权状态
 */
function getLicenseStatus() {
  return {
    isVerified,
    licenseInfo,
    lastCheckTime,
  };
}

/**
 * Vercel Serverless 中间件：保护 API 路由
 * 未授权时返回 403
 *
 * 用法：
 *   const { checkLicenseForRequest } = require('./license-verifier');
 *   const licenseResult = await checkLicenseForRequest();
 *   if (!licenseResult.valid) return sendJson(res, 403, { error: '未授权', message: licenseResult.message });
 */
async function checkLicenseForRequest() {
  // 如果未配置授权码，放行（未启用授权验证）
  if (!CONFIG.licenseKey) {
    return { valid: true, code: 'no_config', message: '未配置授权码，跳过验证' };
  }

  return await checkLicenseCached();
}

/**
 * Express 风格中间件（兼容原始 SDK 接口）
 */
function licenseMiddleware(req, res, next) {
  if (isVerified) {
    next();
  } else {
    if (res && typeof res.status === 'function') {
      res.status(403).json({
        error: '未授权',
        message: '系统未授权或授权已过期，请联系管理员',
        code: 'unauthorized',
      });
    } else if (next) {
      next();
    }
  }
}

/**
 * Next.js Edge Middleware 辅助（兼容原始 SDK 接口）
 */
async function checkLicenseForMiddleware(request, config) {
  if (isVerified && lastCheckTime && (Date.now() - lastCheckTime < CONFIG.checkInterval)) {
    return null;
  }

  const result = await verifyLicense(config);
  if (result.valid) {
    return null;
  }

  if (config.unauthorizedUrl) {
    return Response.redirect(config.unauthorizedUrl, 302);
  }

  return new Response(
    JSON.stringify({ error: '未授权', message: result.message, code: result.code }),
    { status: 403, headers: { 'Content-Type': 'application/json' } }
  );
}

// ============ 版本检查功能 ============

async function checkVersion(apiUrl, productSlug, currentVersion) {
  try {
    const res = await fetch(`${apiUrl}/products/${productSlug}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      return { hasUpdate: false, currentVersion, latestVersion: null };
    }
    const data = await res.json();
    const latest =
      (data.versions && data.versions.find((v) => v.isLatest)) ||
      (data.versions && data.versions[0]);
    if (!latest) {
      return { hasUpdate: false, currentVersion, latestVersion: null };
    }

    const hasUpdate = compareVersions(latest.version, currentVersion) > 0;
    return {
      hasUpdate,
      currentVersion,
      latestVersion: {
        version: latest.version,
        title: latest.title,
        changelog: latest.changelog,
        downloadUrl: latest.downloadUrl,
        downloadPassword: latest.downloadPassword,
        fileSize: latest.fileSize,
        createdAt: latest.createdAt,
      },
    };
  } catch {
    return { hasUpdate: false, currentVersion, latestVersion: null };
  }
}

function compareVersions(a, b) {
  const normalize = (v) =>
    String(v)
      .replace(/^v/i, '')
      .split('.')
      .map((part) => Number(part));
  const partsA = normalize(a);
  const partsB = normalize(b);
  const maxLen = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < maxLen; i++) {
    const va = partsA[i] || 0;
    const vb = partsB[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

function startVersionCheck(apiUrl, productSlug, currentVersion, onUpdate) {
  // Serverless 环境不使用 setInterval
  // 版本检查通过后台管理面板手动触发
  return null;
}

// ============ 导出 ============

module.exports = {
  initLicense,
  verifyLicense,
  checkLicenseCached,
  checkLicenseForRequest,
  startPeriodicCheck,
  stopPeriodicCheck,
  getLicenseStatus,
  licenseMiddleware,
  checkLicenseForMiddleware,
  getCurrentDomain,
  checkVersion,
  compareVersions,
  startVersionCheck,
};
