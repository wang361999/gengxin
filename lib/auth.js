const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { query, ensureDB, validateUserSession, validateAdminSession, getAppVersion } = require('./db');

// JWT 密钥管理：
// - 优先使用环境变量 JWT_SECRET（最稳定，所有函数实例共享）
// - 没有环境变量时，从数据库读取/生成密钥
// - 关键修复：不再使用内存缓存，每次都从数据库读取，避免 Vercel 函数实例间密钥不一致

async function getSecret() {
  // 环境变量优先（最稳定）
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;

  // 每次都从数据库读取，确保所有函数实例使用同一个密钥
  try {
    await ensureDB();
    const res = await query('SELECT value FROM settings WHERE key = $1', ['jwt_secret']);
    if (res.rows.length > 0 && res.rows[0].value) {
      return res.rows[0].value;
    }
    // 不存在则生成 64 字节随机密钥并持久化（ON CONFLICT DO NOTHING 避免多实例覆盖）
    const generated = crypto.randomBytes(64).toString('hex');
    await query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', ['jwt_secret', generated]);
    // 重新读取，确保使用数据库中实际的值（可能由其他实例先插入）
    const res2 = await query('SELECT value FROM settings WHERE key = $1', ['jwt_secret']);
    return (res2.rows.length > 0 && res2.rows[0].value) ? res2.rows[0].value : generated;
  } catch (e) {
    // 数据库不可用时的最后手段：使用固定的回退密钥（基于环境信息，不安全但不会崩溃）
    // 这种情况下 token 可能无法跨实例验证，但至少不会报错
    return crypto.createHash('sha256').update('fallback_secret_' + (process.env.VERCEL_URL || 'local')).digest('hex');
  }
}

// 初始化时预加载密钥（兼容旧代码，实际不再需要预加载）
async function initSecret() {
  await getSecret();
}

// 异步签名 token
async function signToken(payload) {
  const secret = await getSecret();
  return jwt.sign(payload, secret, { expiresIn: '7d' });
}

// 异步签名管理员 token
async function signAdminToken(payload) {
  const secret = await getSecret();
  return jwt.sign({ ...payload, role: 'admin' }, secret, { expiresIn: '24h' });
}

// 异步验证 token
async function verifyToken(token) {
  const secret = await getSecret();
  try {
    return jwt.verify(token, secret);
  } catch {
    return null;
  }
}

// 同步版本（兼容旧代码，仅在不涉及密钥时使用）
function getSecretSync() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  return null;
}

// 同步签名（兼容旧代码，不保证密钥已加载）
function signTokenSync(payload) {
  const secret = getSecretSync();
  if (!secret) throw new Error('JWT 密钥未初始化，请使用异步版本或设置 JWT_SECRET 环境变量');
  return jwt.sign(payload, secret, { expiresIn: '7d' });
}

// 同步验证（兼容旧代码，不保证密钥已加载）
function verifyTokenSync(token) {
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
  return verifyTokenSync(token);
}

// 异步版本：先确保密钥已加载，再验证 token
async function getUserAsync(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  return await verifyToken(token);
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

module.exports = { 
  signToken, signAdminToken, verifyToken, 
  signTokenSync, verifyTokenSync,
  getUser, getUserAsync, requireAuth, requireAdmin, initSecret, extractToken 
};
