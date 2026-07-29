const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { query, ensureDB, validateUserSession, validateAdminSession, getAppVersion } = require('./db');

// JWT 密钥：优先用环境变量，否则从数据库读取，没有则生成并持久化
let cachedSecret = null;
let secretLoadFailed = false; // 标记上次是否失败，失败则下次重试

async function getSecret() {
  // 环境变量优先（最稳定）
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;

  // 如果已成功缓存且未失败过，直接返回
  if (cachedSecret && !secretLoadFailed) return cachedSecret;

  // 从数据库读取
  try {
    await ensureDB();
    const res = await query('SELECT value FROM settings WHERE key = $1', ['jwt_secret']);
    if (res.rows.length > 0 && res.rows[0].value) {
      cachedSecret = res.rows[0].value;
      secretLoadFailed = false;
      return cachedSecret;
    }
    // 不存在则生成 64 字节随机密钥并持久化（ON CONFLICT DO NOTHING 避免多实例覆盖）
    const generated = crypto.randomBytes(64).toString('hex');
    await query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', ['jwt_secret', generated]);
    // 重新读取，确保使用数据库中实际的值（可能由其他实例先插入）
    const res2 = await query('SELECT value FROM settings WHERE key = $1', ['jwt_secret']);
    cachedSecret = (res2.rows.length > 0 && res2.rows[0].value) ? res2.rows[0].value : generated;
    secretLoadFailed = false;
    return cachedSecret;
  } catch (e) {
    // 数据库不可用时：如果之前有成功的缓存，继续使用；否则生成临时密钥并标记失败
    if (cachedSecret && !secretLoadFailed) return cachedSecret;
    // 生成临时密钥，但标记为失败以便下次重试从数据库读取
    cachedSecret = crypto.randomBytes(64).toString('hex');
    secretLoadFailed = true;
    return cachedSecret;
  }
}

// 同步获取（仅在已初始化后使用）
function getSecretSync() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (cachedSecret) return cachedSecret;
  return null;
}

// 初始化时预加载密钥（可选调用，requireAuth 内部会自动调用）
async function initSecret() {
  await getSecret();
}

function signToken(payload) {
  const secret = getSecretSync();
  if (!secret) throw new Error('JWT 密钥未初始化');
  return jwt.sign(payload, secret, { expiresIn: '7d' });
}

function signAdminToken(payload) {
  const secret = getSecretSync();
  if (!secret) throw new Error('JWT 密钥未初始化');
  return jwt.sign({ ...payload, role: 'admin' }, secret, { expiresIn: '24h' });
}

function verifyToken(token) {
  const secret = getSecretSync();
  if (!secret) return null;
  try {
    return jwt.verify(token, secret);
  } catch {
    return null;
  }
}

// 同步版本（兼容旧代码，不保证密钥已加载）
function getUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  return verifyToken(token);
}

// 异步版本：先确保密钥已加载，再验证 token
async function getUserAsync(req) {
  await getSecret(); // 确保密钥已从数据库加载
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;

  // 第一次验证
  const result = verifyToken(token);
  if (result) return result;

  // 如果第一次失败，可能是因为缓存了错误的密钥，强制重新从数据库加载
  secretLoadFailed = true;
  cachedSecret = null;
  await getSecret();

  // 第二次验证
  return verifyToken(token);
}

// 提取原始 token（不含 Bearer 前缀）
function extractToken(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}

// 异步版 requireAuth：自动加载密钥，确保 token 验证正确，并检查单会话
async function requireAuth(req, res) {
  const user = await getUserAsync(req);
  if (!user) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: false, error: '请先登录' }));
    return null;
  }
  // 管理员 token 兼容：使用 adminId 作为 userId，方便数据库查询
  if (user.role === 'admin' && !user.userId) {
    // 检查管理员单会话
    const rawToken = extractToken(req);
    const sessionValid = await validateAdminSession(user.adminId || 'admin_1', rawToken);
    if (!sessionValid) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: false, error: '账号已在其他设备登录，请重新登录' }));
      return null;
    }
    return { ...user, userId: user.adminId || 'admin_user', isAdmin: true };
  }
  // 检查普通用户单会话
  const rawToken = extractToken(req);
  const sessionValid = await validateUserSession(user.userId, rawToken);
  if (!sessionValid) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: false, error: '账号已在其他设备登录，请重新登录' }));
    return null;
  }
  return user;
}

// 异步版 requireAdmin：自动加载密钥，确保 token 验证正确，并检查单会话
async function requireAdmin(req, res) {
  const user = await getUserAsync(req);
  if (!user || user.role !== 'admin') {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: false, error: '需要管理员权限' }));
    return null;
  }
  // 检查管理员单会话
  const rawToken = extractToken(req);
  const sessionValid = await validateAdminSession(user.adminId || 'admin_1', rawToken);
  if (!sessionValid) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: false, error: '账号已在其他设备登录，请重新登录' }));
    return null;
  }
  return user;
}

module.exports = { signToken, signAdminToken, verifyToken, getUser, getUserAsync, requireAuth, requireAdmin, initSecret, extractToken };
