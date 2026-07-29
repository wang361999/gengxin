const { Pool } = require('pg');

let pool = null;
let initPromise = null;

function getPool() {
  if (!pool) {
    const connectionString = process.env.POSTGRES_URL
      || process.env.DATABASE_URL
      || process.env.POSTGRES_POOL_URL;
    if (!connectionString) {
      throw new Error('未检测到数据库环境变量。请在 Vercel 后台 → Storage → Create Database → Postgres，创建后环境变量自动注入');
    }
    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 15000
    });
  }
  return pool;
}

async function query(sql, params = []) {
  const p = getPool();
  const client = await p.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

// 套餐定义（内置）
const PLANS = {
  free: {
    id: 'free',
    name: '免费版',
    price: 0,
    uploadLimit: 50,
    repoLimit: 3,
    features: ['每月 50 次上传', '最多 3 个仓库', 'ZIP 最大 10MB', '基础支持']
  },
  pro: {
    id: 'pro',
    name: '专业版',
    price: 29,
    uploadLimit: 500,
    repoLimit: 20,
    features: ['每月 500 次上传', '最多 20 个仓库', 'ZIP 最大 50MB', '优先支持', '无广告']
  },
  enterprise: {
    id: 'enterprise',
    name: '企业版',
    price: 99,
    uploadLimit: 0, // 0 = 不限
    repoLimit: 0,
    features: ['无限上传', '无限仓库', 'ZIP 最大 100MB', '专属客服', 'API 接入', '团队协作']
  }
};

// 自动建表（幂等，首次调用时执行）
async function ensureDB() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const p = getPool();
    const client = await p.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          brand_name TEXT DEFAULT '',
          brand_color TEXT DEFAULT '#111827',
          brand_logo TEXT DEFAULT '',
          status TEXT DEFAULT 'active',
          plan TEXT DEFAULT 'free',
          plan_expires_at TIMESTAMPTZ DEFAULT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS admins (
          id TEXT PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS repos (
          id BIGSERIAL PRIMARY KEY,
          user_id TEXT NOT NULL,
          name TEXT NOT NULL DEFAULT '',
          repo TEXT NOT NULL DEFAULT '',
          enc_token TEXT NOT NULL DEFAULT '',
          branch TEXT DEFAULT 'main',
          target_dir TEXT DEFAULT '.',
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS history (
          id BIGSERIAL PRIMARY KEY,
          user_id TEXT NOT NULL,
          file_name TEXT DEFAULT '',
          file_count INTEGER DEFAULT 0,
          size BIGINT DEFAULT 0,
          repo TEXT DEFAULT '',
          branch TEXT DEFAULT '',
          status TEXT DEFAULT 'success',
          commit_sha TEXT DEFAULT '',
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL DEFAULT '',
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      // 用量追踪表（按月统计）
      await client.query(`
        CREATE TABLE IF NOT EXISTS usage_stats (
          id BIGSERIAL PRIMARY KEY,
          user_id TEXT NOT NULL,
          year INTEGER NOT NULL,
          month INTEGER NOT NULL,
          upload_count INTEGER DEFAULT 0,
          total_files INTEGER DEFAULT 0,
          total_size BIGINT DEFAULT 0,
          UNIQUE(user_id, year, month)
        )
      `);
      // 订阅/订单表
      await client.query(`
        CREATE TABLE IF NOT EXISTS subscriptions (
          id BIGSERIAL PRIMARY KEY,
          user_id TEXT NOT NULL,
          plan TEXT NOT NULL,
          amount NUMERIC(10,2) DEFAULT 0,
          status TEXT DEFAULT 'pending',
          payment_method TEXT DEFAULT '',
          trade_no TEXT DEFAULT '',
          period TEXT DEFAULT 'monthly',
          starts_at TIMESTAMPTZ DEFAULT NOW(),
          expires_at TIMESTAMPTZ DEFAULT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      // ===== 第二阶段：API 密钥表 =====
      await client.query(`
        CREATE TABLE IF NOT EXISTS api_keys (
          id BIGSERIAL PRIMARY KEY,
          user_id TEXT NOT NULL,
          key_name TEXT DEFAULT 'default',
          api_key TEXT UNIQUE NOT NULL,
          status TEXT DEFAULT 'active',
          last_used_at TIMESTAMPTZ DEFAULT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      // ===== 第二阶段：通知消息表 =====
      await client.query(`
        CREATE TABLE IF NOT EXISTS notifications (
          id BIGSERIAL PRIMARY KEY,
          user_id TEXT NOT NULL,
          type TEXT DEFAULT 'info',
          title TEXT NOT NULL,
          content TEXT DEFAULT '',
          is_read BOOLEAN DEFAULT false,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      // ===== 第二阶段：充值订单表 =====
      await client.query(`
        CREATE TABLE IF NOT EXISTS orders (
          id BIGSERIAL PRIMARY KEY,
          user_id TEXT NOT NULL,
          order_no TEXT UNIQUE NOT NULL,
          plan TEXT NOT NULL,
          amount NUMERIC(10,2) DEFAULT 0,
          period TEXT DEFAULT 'monthly',
          status TEXT DEFAULT 'pending',
          pay_method TEXT DEFAULT '',
          paid_at TIMESTAMPTZ DEFAULT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      // ===== 第三阶段：团队协作 =====
      await client.query(`
        CREATE TABLE IF NOT EXISTS teams (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT DEFAULT '',
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS team_members (
          id BIGSERIAL PRIMARY KEY,
          team_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          role TEXT DEFAULT 'member',
          status TEXT DEFAULT 'active',
          joined_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(team_id, user_id)
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS team_repos (
          id BIGSERIAL PRIMARY KEY,
          team_id TEXT NOT NULL,
          repo_id BIGINT NOT NULL,
          shared_by TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      // 初始化默认设置
      await client.query(`
        INSERT INTO settings (key, value)
        VALUES
          ('site_name', 'GitUpload'),
          ('allow_register', 'true'),
          ('announcement', ''),
          ('free_upload_limit', '50'),
          ('pro_price', '29'),
          ('enterprise_price', '99'),
          ('contact_email', ''),
          ('contact_wechat', ''),
          ('alipay_qrcode', ''),
          ('wechat_qrcode', ''),
          ('payment_instructions', '请在付款备注中填写订单号后6位，以便管理员核对')
        ON CONFLICT (key) DO NOTHING
      `);

      // 为已有用户添加缺失的列（兼容旧数据）
      try { await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'`); } catch {}
      try { await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'free'`); } catch {}
      try { await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMPTZ DEFAULT NULL`); } catch {}
      // 订单表增加付款备注列（用户点击"我已支付"时填写）
      try { await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_note TEXT DEFAULT ''`); } catch {}
      // 单会话登录：记录当前活跃 session token（每次登录覆盖，旧 token 自动失效）
      try { await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS active_session TEXT DEFAULT ''`); } catch {}
      try { await client.query(`ALTER TABLE admins ADD COLUMN IF NOT EXISTS active_session TEXT DEFAULT ''`); } catch {}
      // 初始化 app_version 设置（动态版本号，部署后前端自动检测并强制刷新）
      try {
        await client.query(`INSERT INTO settings (key, value) VALUES ('app_version', 'v2.6.0') ON CONFLICT (key) DO NOTHING`);
      } catch {}

      await client.query(`CREATE INDEX IF NOT EXISTS idx_repos_user_id ON repos(user_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_history_user_id ON history(user_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_history_created_at ON history(created_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_usage_stats_user ON usage_stats(user_id, year, month)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_teams_owner ON teams(owner_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_team_repos_team ON team_repos(team_id)`);
    } finally {
      client.release();
    }
  })();
  return initPromise;
}

// ===== 用户 =====
async function createUser(username, passwordHash, brandName) {
  await ensureDB();
  const id = `u_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const res = await query(
    `INSERT INTO users (id, username, password_hash, brand_name, brand_color, brand_logo, status, plan)
     VALUES ($1, $2, $3, $4, '#111827', '', 'active', 'free')
     RETURNING *`,
    [id, username.toLowerCase(), passwordHash, brandName || username]
  );
  const u = res.rows[0];
  return {
    id: u.id,
    username: u.username,
    passwordHash: u.password_hash,
    brandName: u.brand_name,
    brandColor: u.brand_color,
    brandLogo: u.brand_logo || '',
    status: u.status || 'active',
    plan: u.plan || 'free',
    planExpiresAt: u.plan_expires_at || null,
    createdAt: u.created_at
  };
}

async function findUserByUsername(username) {
  await ensureDB();
  const res = await query(`SELECT * FROM users WHERE username = $1 LIMIT 1`, [username.toLowerCase()]);
  if (res.rows.length === 0) return null;
  const u = res.rows[0];
  return {
    id: u.id,
    username: u.username,
    passwordHash: u.password_hash,
    brandName: u.brand_name,
    brandColor: u.brand_color,
    brandLogo: u.brand_logo || '',
    status: u.status || 'active',
    plan: u.plan || 'free',
    planExpiresAt: u.plan_expires_at || null,
    createdAt: u.created_at
  };
}

async function findUserById(id) {
  await ensureDB();
  const res = await query(`SELECT * FROM users WHERE id = $1 LIMIT 1`, [id]);
  if (res.rows.length === 0) return null;
  const u = res.rows[0];
  return {
    id: u.id,
    username: u.username,
    passwordHash: u.password_hash,
    brandName: u.brand_name,
    brandColor: u.brand_color,
    brandLogo: u.brand_logo || '',
    status: u.status || 'active',
    plan: u.plan || 'free',
    planExpiresAt: u.plan_expires_at || null,
    createdAt: u.created_at
  };
}

async function updateUser(id, updates) {
  await ensureDB();
  const sets = [];
  const vals = [];
  let idx = 1;
  if (updates.passwordHash !== undefined) { sets.push(`password_hash = $${idx++}`); vals.push(updates.passwordHash); }
  if (updates.brandName !== undefined) { sets.push(`brand_name = $${idx++}`); vals.push(updates.brandName); }
  if (updates.brandColor !== undefined) { sets.push(`brand_color = $${idx++}`); vals.push(updates.brandColor); }
  if (updates.brandLogo !== undefined) { sets.push(`brand_logo = $${idx++}`); vals.push(updates.brandLogo); }
  if (updates.status !== undefined) { sets.push(`status = $${idx++}`); vals.push(updates.status); }
  if (updates.plan !== undefined) { sets.push(`plan = $${idx++}`); vals.push(updates.plan); }
  if (updates.planExpiresAt !== undefined) { sets.push(`plan_expires_at = $${idx++}`); vals.push(updates.planExpiresAt); }
  if (sets.length === 0) return await findUserById(id);
  vals.push(id);
  const res = await query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`, vals);
  if (res.rows.length === 0) return null;
  const u = res.rows[0];
  return {
    id: u.id,
    username: u.username,
    passwordHash: u.password_hash,
    brandName: u.brand_name,
    brandColor: u.brand_color,
    brandLogo: u.brand_logo || '',
    status: u.status || 'active',
    plan: u.plan || 'free',
    planExpiresAt: u.plan_expires_at || null,
    createdAt: u.created_at
  };
}

async function listAllUsers() {
  await ensureDB();
  const res = await query(`SELECT id, username, brand_name, status, plan, plan_expires_at, created_at FROM users ORDER BY created_at DESC`);
  return res.rows.map(u => ({
    id: u.id,
    username: u.username,
    brandName: u.brand_name,
    status: u.status || 'active',
    plan: u.plan || 'free',
    planExpiresAt: u.plan_expires_at,
    createdAt: u.created_at
  }));
}

async function deleteUser(id) {
  await ensureDB();
  await query(`DELETE FROM repos WHERE user_id = $1`, [id]);
  await query(`DELETE FROM history WHERE user_id = $1`, [id]);
  await query(`DELETE FROM usage_stats WHERE user_id = $1`, [id]);
  await query(`DELETE FROM subscriptions WHERE user_id = $1`, [id]);
  await query(`DELETE FROM users WHERE id = $1`, [id]);
  return true;
}

// ===== 套餐管理 =====
function getPlans() {
  return PLANS;
}

// 获取用户当前套餐（检查是否过期，过期则降为 free）
async function getUserPlan(userId) {
  await ensureDB();
  // 管理员默认使用企业版
  if (userId && (userId === 'admin_user' || userId.startsWith('admin_'))) {
    const planInfo = PLANS.enterprise;
    // 查询管理员用量（如果有）
    const now0 = new Date();
    const year0 = now0.getFullYear();
    const month0 = now0.getMonth() + 1;
    const usageRes0 = await query(
      `SELECT upload_count, total_files, total_size FROM usage_stats WHERE user_id = $1 AND year = $2 AND month = $3`,
      [userId, year0, month0]
    );
    const usage0 = usageRes0.rows[0] || { upload_count: 0, total_files: 0, total_size: 0 };
    return {
      ...planInfo,
      currentUsage: parseInt(usage0.upload_count),
      totalFiles: parseInt(usage0.total_files),
      totalSize: parseInt(usage0.total_size),
      planExpiresAt: null,
      remaining: -1
    };
  }
  const userRes = await query(`SELECT plan, plan_expires_at FROM users WHERE id = $1`, [userId]);
  if (userRes.rows.length === 0) return PLANS.free;
  const u = userRes.rows[0];
  let plan = u.plan || 'free';
  let planExpiresAt = u.plan_expires_at;

  // 检查是否过期
  if (plan !== 'free' && planExpiresAt) {
    const now = new Date();
    const expires = new Date(planExpiresAt);
    if (now > expires) {
      // 套餐已过期，降为免费版
      await query(`UPDATE users SET plan = 'free', plan_expires_at = NULL WHERE id = $1`, [userId]);
      plan = 'free';
      planExpiresAt = null;
    }
  }

  const planInfo = PLANS[plan] || PLANS.free;

  // 获取当月用量
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const usageRes = await query(
    `SELECT upload_count, total_files, total_size FROM usage_stats WHERE user_id = $1 AND year = $2 AND month = $3`,
    [userId, year, month]
  );
  const usage = usageRes.rows[0] || { upload_count: 0, total_files: 0, total_size: 0 };

  return {
    ...planInfo,
    currentUsage: parseInt(usage.upload_count),
    totalFiles: parseInt(usage.total_files),
    totalSize: parseInt(usage.total_size),
    planExpiresAt: planExpiresAt,
    remaining: planInfo.uploadLimit === 0 ? -1 : Math.max(0, planInfo.uploadLimit - parseInt(usage.upload_count))
  };
}

// 检查上传限制
async function checkUploadLimit(userId) {
  const planInfo = await getUserPlan(userId);
  if (planInfo.uploadLimit === 0) return { allowed: true, plan: planInfo }; // 不限
  if (planInfo.currentUsage >= planInfo.uploadLimit) {
    return { allowed: false, plan: planInfo, message: `已达到本月上传上限 (${planInfo.uploadLimit} 次)，请升级套餐` };
  }
  return { allowed: true, plan: planInfo };
}

// 增加上传用量
async function incrementUploadUsage(userId, fileCount, size) {
  await ensureDB();
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  await query(
    `INSERT INTO usage_stats (user_id, year, month, upload_count, total_files, total_size)
     VALUES ($1, $2, $3, 1, $4, $5)
     ON CONFLICT (user_id, year, month)
     DO UPDATE SET upload_count = usage_stats.upload_count + 1,
                   total_files = usage_stats.total_files + $4,
                   total_size = usage_stats.total_size + $5`,
    [userId, year, month, fileCount, size]
  );
  return true;
}

// 管理员设置用户套餐
async function setUserPlan(userId, plan, period = 'monthly') {
  await ensureDB();
  const planInfo = PLANS[plan];
  if (!planInfo) throw new Error('未知套餐: ' + plan);

  let expiresAt = null;
  if (plan !== 'free') {
    const now = new Date();
    if (period === 'yearly') {
      expiresAt = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());
    } else {
      expiresAt = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());
    }
  }

  await query(`UPDATE users SET plan = $1, plan_expires_at = $2 WHERE id = $3`, [plan, expiresAt, userId]);

  // 创建订阅记录
  if (plan !== 'free') {
    await query(
      `INSERT INTO subscriptions (user_id, plan, amount, status, payment_method, trade_no, period, starts_at, expires_at)
       VALUES ($1, $2, $3, 'active', 'admin_assigned', 'admin_' || $4, $5, NOW(), $6)`,
      [userId, plan, planInfo.price, Date.now(), period, expiresAt]
    );
  }

  return { plan, expiresAt };
}

// 获取用户订阅记录
async function getUserSubscriptions(userId) {
  await ensureDB();
  const res = await query(
    `SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [userId]
  );
  return res.rows.map(s => ({
    id: s.id,
    plan: s.plan,
    amount: parseFloat(s.amount),
    status: s.status,
    paymentMethod: s.payment_method,
    tradeNo: s.trade_no,
    period: s.period,
    startsAt: s.starts_at,
    expiresAt: s.expires_at,
    createdAt: s.created_at
  }));
}

// ===== 上传历史 =====
async function addHistory(userId, record) {
  await ensureDB();
  const res = await query(
    `INSERT INTO history (user_id, file_name, file_count, size, repo, branch, status, commit_sha)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [userId, record.fileName || '', record.fileCount || 0, record.size || 0,
     record.repo || '', record.branch || '', record.status || 'success', record.commitSha || '']
  );
  const h = res.rows[0];
  return {
    id: h.id,
    time: h.created_at,
    fileName: h.file_name,
    fileCount: h.file_count,
    size: h.size,
    repo: h.repo,
    branch: h.branch,
    status: h.status,
    commitSha: h.commit_sha
  };
}

async function getHistory(userId, limit = 50) {
  await ensureDB();
  const res = await query(
    `SELECT * FROM history WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return res.rows.map(h => ({
    id: h.id,
    time: h.created_at,
    fileName: h.file_name,
    fileCount: h.file_count,
    size: h.size,
    repo: h.repo,
    branch: h.branch,
    status: h.status,
    commitSha: h.commit_sha
  }));
}

async function clearHistory(userId) {
  await ensureDB();
  await query(`DELETE FROM history WHERE user_id = $1`, [userId]);
  return true;
}

async function getAllHistory(limit = 100) {
  await ensureDB();
  const res = await query(
    `SELECT h.*, u.username, u.brand_name
     FROM history h
     LEFT JOIN users u ON h.user_id = u.id
     ORDER BY h.created_at DESC
     LIMIT $1`,
    [limit]
  );
  return res.rows.map(h => ({
    id: h.id,
    userId: h.user_id,
    username: h.username || '未知',
    brandName: h.brand_name || '',
    time: h.created_at,
    fileName: h.file_name,
    fileCount: h.file_count,
    size: h.size,
    repo: h.repo,
    branch: h.branch,
    status: h.status,
    commitSha: h.commit_sha
  }));
}

// ===== 统计数据 =====
async function getStats() {
  await ensureDB();
  const userCount = await query(`SELECT COUNT(*) as cnt FROM users`);
  const uploadCount = await query(`SELECT COUNT(*) as cnt FROM history`);
  const repoCount = await query(`SELECT COUNT(*) as cnt FROM repos`);
  const totalFiles = await query(`SELECT COALESCE(SUM(file_count), 0) as cnt FROM history`);
  const totalSize = await query(`SELECT COALESCE(SUM(size), 0) as cnt FROM history`);
  const todayUploads = await query(
    `SELECT COUNT(*) as cnt FROM history WHERE created_at >= NOW() - INTERVAL '24 hours'`
  );
  const weekUploads = await query(
    `SELECT COUNT(*) as cnt FROM history WHERE created_at >= NOW() - INTERVAL '7 days'`
  );
  // 付费用户数
  const paidUsers = await query(`SELECT COUNT(*) as cnt FROM users WHERE plan != 'free'`);
  // 总收入
  const revenueRes = await query(
    `SELECT COALESCE(SUM(amount), 0) as cnt FROM subscriptions WHERE status = 'active'`
  );

  const dailyStats = await query(
    `SELECT DATE(created_at) as date, COUNT(*) as cnt
     FROM history
     WHERE created_at >= NOW() - INTERVAL '7 days'
     GROUP BY DATE(created_at)
     ORDER BY date ASC`
  );
  return {
    totalUsers: parseInt(userCount.rows[0].cnt),
    totalUploads: parseInt(uploadCount.rows[0].cnt),
    totalRepos: parseInt(repoCount.rows[0].cnt),
    totalFiles: parseInt(totalFiles.rows[0].cnt),
    totalSize: parseInt(totalSize.rows[0].cnt),
    todayUploads: parseInt(todayUploads.rows[0].cnt),
    weekUploads: parseInt(weekUploads.rows[0].cnt),
    paidUsers: parseInt(paidUsers.rows[0].cnt),
    totalRevenue: parseFloat(revenueRes.rows[0].cnt),
    dailyStats: dailyStats.rows.map(r => ({ date: r.date, count: parseInt(r.cnt) }))
  };
}

async function getUserStats(userId) {
  await ensureDB();
  const uploadCount = await query(`SELECT COUNT(*) as cnt FROM history WHERE user_id = $1`, [userId]);
  const repoCount = await query(`SELECT COUNT(*) as cnt FROM repos WHERE user_id = $1`, [userId]);
  const totalFiles = await query(`SELECT COALESCE(SUM(file_count), 0) as cnt FROM history WHERE user_id = $1`, [userId]);
  const totalSize = await query(`SELECT COALESCE(SUM(size), 0) as cnt FROM history WHERE user_id = $1`, [userId]);
  return {
    totalUploads: parseInt(uploadCount.rows[0].cnt),
    totalRepos: parseInt(repoCount.rows[0].cnt),
    totalFiles: parseInt(totalFiles.rows[0].cnt),
    totalSize: parseInt(totalSize.rows[0].cnt)
  };
}

// ===== 管理员 =====
async function createAdmin(username, passwordHash) {
  await ensureDB();
  await query(
    `INSERT INTO admins (id, username, password_hash) VALUES ('admin_1', $1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [username.toLowerCase(), passwordHash]
  );
  return { id: 'admin_1', username, passwordHash };
}

async function findAdmin(username) {
  await ensureDB();
  const res = await query(`SELECT * FROM admins WHERE username = $1 LIMIT 1`, [username.toLowerCase()]);
  if (res.rows.length === 0) return null;
  const a = res.rows[0];
  return {
    id: a.id,
    username: a.username,
    passwordHash: a.password_hash,
    createdAt: a.created_at
  };
}

async function findAdminById(id) {
  await ensureDB();
  const res = await query(`SELECT * FROM admins WHERE id = $1 LIMIT 1`, [id]);
  if (res.rows.length === 0) return null;
  const a = res.rows[0];
  return {
    id: a.id,
    username: a.username,
    passwordHash: a.password_hash,
    createdAt: a.created_at
  };
}

async function updateAdminPassword(id, passwordHash) {
  await ensureDB();
  await query(`UPDATE admins SET password_hash = $1 WHERE id = $2`, [passwordHash, id]);
  return true;
}

async function ensureDefaultAdmin() {
  try {
    await ensureDB();
    const existing = await findAdmin('admin');
    if (existing) return;
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('Admin@123456', 10);
    await createAdmin('admin', hash);
    // 标记管理员密码未修改（首次部署）
    await query(`INSERT INTO settings (key, value) VALUES ('admin_password_changed', 'false') ON CONFLICT (key) DO NOTHING`);
    // 同步创建一条企业管理员用户记录，使 admin 可访问前台所有功能
    const adminUser = await findUserByUsername('admin');
    if (!adminUser) {
      await query(
        `INSERT INTO users (id, username, password_hash, brand_name, brand_color, brand_logo, status, plan)
         VALUES ('admin_user', 'admin', $1, '管理员', '#111827', '', 'active', 'enterprise')
         ON CONFLICT (username) DO NOTHING`,
        [hash]
      );
    }
  } catch (e) {
    // 首次部署数据库未就绪时静默忽略
  }
}

// ===== 多仓库管理 =====
async function addRepo(userId, repoData) {
  await ensureDB();
  const { name, repo, encToken, branch, targetDir } = repoData;
  const res = await query(
    `INSERT INTO repos (user_id, name, repo, enc_token, branch, target_dir)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [userId, name || '', repo, encToken, branch || 'main', targetDir || '.']
  );
  const r = res.rows[0];
  return {
    id: Number(r.id),
    name: r.name,
    repo: r.repo,
    branch: r.branch,
    targetDir: r.target_dir,
    hasToken: true
  };
}

async function listRepos(userId) {
  await ensureDB();
  const res = await query(
    `SELECT id, name, repo, branch, target_dir, enc_token, created_at FROM repos WHERE user_id = $1 ORDER BY created_at ASC`,
    [userId]
  );
  return res.rows.map(r => ({
    id: Number(r.id),
    name: r.name,
    repo: r.repo,
    branch: r.branch,
    targetDir: r.target_dir,
    hasToken: !!r.enc_token
  }));
}

async function getRepo(userId, repoId) {
  await ensureDB();
  const res = await query(`SELECT * FROM repos WHERE id = $1 AND user_id = $2 LIMIT 1`, [repoId, userId]);
  if (res.rows.length === 0) return null;
  const r = res.rows[0];
  return {
    id: Number(r.id),
    name: r.name,
    repo: r.repo,
    encToken: r.enc_token,
    branch: r.branch,
    targetDir: r.target_dir
  };
}

async function updateRepo(userId, repoId, updates) {
  await ensureDB();
  const sets = [];
  const vals = [];
  let idx = 1;
  if (updates.name !== undefined) { sets.push(`name = $${idx++}`); vals.push(updates.name); }
  if (updates.repo !== undefined) { sets.push(`repo = $${idx++}`); vals.push(updates.repo); }
  if (updates.encToken !== undefined) { sets.push(`enc_token = $${idx++}`); vals.push(updates.encToken); }
  if (updates.branch !== undefined) { sets.push(`branch = $${idx++}`); vals.push(updates.branch); }
  if (updates.targetDir !== undefined) { sets.push(`target_dir = $${idx++}`); vals.push(updates.targetDir); }
  if (sets.length === 0) return await getRepo(userId, repoId);
  vals.push(repoId);
  vals.push(userId);
  const res = await query(
    `UPDATE repos SET ${sets.join(', ')} WHERE id = $${idx++} AND user_id = $${idx} RETURNING *`,
    vals
  );
  if (res.rows.length === 0) return null;
  const r = res.rows[0];
  return {
    id: Number(r.id),
    name: r.name,
    repo: r.repo,
    encToken: r.enc_token,
    branch: r.branch,
    targetDir: r.target_dir
  };
}

async function deleteRepo(userId, repoId) {
  await ensureDB();
  await query(`DELETE FROM repos WHERE id = $1 AND user_id = $2`, [repoId, userId]);
  return true;
}

// ===== 系统设置 =====
async function getSetting(key) {
  await ensureDB();
  const res = await query(`SELECT value FROM settings WHERE key = $1`, [key]);
  return res.rows.length > 0 ? res.rows[0].value : null;
}

async function getAllSettings() {
  await ensureDB();
  const res = await query(`SELECT key, value FROM settings`);
  const settings = {};
  for (const row of res.rows) {
    settings[row.key] = row.value;
  }
  return settings;
}

async function updateSetting(key, value) {
  await ensureDB();
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, String(value)]
  );
  return true;
}

// 获取用户详情（包含仓库和历史摘要）
async function getUserDetail(userId) {
  await ensureDB();
  const userRes = await query(`SELECT id, username, brand_name, brand_color, status, plan, plan_expires_at, created_at FROM users WHERE id = $1`, [userId]);
  if (userRes.rows.length === 0) return null;

  const u = userRes.rows[0];
  const statsRes = await query(
    `SELECT
       COUNT(*) as upload_count,
       COALESCE(SUM(file_count), 0) as total_files,
       COALESCE(SUM(size), 0) as total_size
     FROM history WHERE user_id = $1`,
    [userId]
  );
  const repoCountRes = await query(`SELECT COUNT(*) as cnt FROM repos WHERE user_id = $1`, [userId]);
  const recentHistoryRes = await query(
    `SELECT file_name, file_count, size, repo, branch, status, commit_sha, created_at
     FROM history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`,
    [userId]
  );
  const reposRes = await query(
    `SELECT id, name, repo, branch, target_dir, created_at FROM repos WHERE user_id = $1 ORDER BY created_at ASC`,
    [userId]
  );

  // 获取当月用量
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const usageRes = await query(
    `SELECT upload_count, total_files, total_size FROM usage_stats WHERE user_id = $1 AND year = $2 AND month = $3`,
    [userId, year, month]
  );
  const usage = usageRes.rows[0] || { upload_count: 0, total_files: 0, total_size: 0 };

  const s = statsRes.rows[0];
  const planInfo = PLANS[u.plan || 'free'] || PLANS.free;

  return {
    id: u.id,
    username: u.username,
    brandName: u.brand_name,
    brandColor: u.brand_color,
    status: u.status || 'active',
    plan: u.plan || 'free',
    planName: planInfo.name,
    planExpiresAt: u.plan_expires_at,
    createdAt: u.created_at,
    stats: {
      uploadCount: parseInt(s.upload_count),
      totalFiles: parseInt(s.total_files),
      totalSize: parseInt(s.total_size),
      repoCount: parseInt(repoCountRes.rows[0].cnt)
    },
    monthlyUsage: {
      uploads: parseInt(usage.upload_count),
      files: parseInt(usage.total_files),
      size: parseInt(usage.total_size),
      limit: planInfo.uploadLimit
    },
    repos: reposRes.rows.map(r => ({
      id: r.id,
      name: r.name,
      repo: r.repo,
      branch: r.branch,
      targetDir: r.target_dir,
      createdAt: r.created_at
    })),
    recentHistory: recentHistoryRes.rows.map(h => ({
      fileName: h.file_name,
      fileCount: h.file_count,
      size: h.size,
      repo: h.repo,
      branch: h.branch,
      status: h.status,
      commitSha: h.commit_sha,
      time: h.created_at
    }))
  };
}

// 最近 N 天上传趋势
async function getUploadTrend(days = 30) {
  await ensureDB();
  const res = await query(
    `SELECT DATE(created_at) as date, COUNT(*) as count, COALESCE(SUM(file_count), 0) as files
     FROM history
     WHERE created_at >= NOW() - INTERVAL '${parseInt(days)} days'
     GROUP BY DATE(created_at)
     ORDER BY date ASC`
  );
  return res.rows.map(r => ({
    date: r.date,
    count: parseInt(r.count),
    files: parseInt(r.files)
  }));
}

// ===== 数据分析（仪表盘） =====
async function getAnalyticsData() {
  await ensureDB();

  // 1. 上传趋势（最近 30 天，按天）
  const trendRes = await query(
    `SELECT DATE(created_at) as date, COUNT(*) as uploads, COALESCE(SUM(file_count), 0) as files, COALESCE(SUM(size), 0) as size
     FROM history
     WHERE created_at >= NOW() - INTERVAL '30 days'
     GROUP BY DATE(created_at)
     ORDER BY date ASC`
  );

  // 2. 仓库分布（按仓库名分组，Top 10）
  const repoDistRes = await query(
    `SELECT repo, COUNT(*) as count, COALESCE(SUM(file_count), 0) as files
     FROM history
     WHERE created_at >= NOW() - INTERVAL '30 days'
     GROUP BY repo
     ORDER BY count DESC
     LIMIT 10`
  );

  // 3. 套餐分布
  const planDistRes = await query(
    `SELECT plan, COUNT(*) as count FROM users GROUP BY plan ORDER BY count DESC`
  );

  // 4. 套餐转化漏斗
  const totalUsers = await query(`SELECT COUNT(*) as count FROM users`);
  const planUsers = await query(
    `SELECT plan, COUNT(*) as count FROM users WHERE plan != 'free' GROUP BY plan`
  );
  const paidCount = planUsers.rows.reduce((sum, r) => sum + parseInt(r.count), 0);
  const funnel = {
    total: parseInt(totalUsers.rows[0].count),
    paid: paidCount,
    conversionRate: parseInt(totalUsers.rows[0].count) > 0
      ? ((paidCount / parseInt(totalUsers.rows[0].count)) * 100).toFixed(1)
      : '0'
  };

  // 5. 用户活跃热力图（最近 30 天，按天统计活跃用户数）
  const activityRes = await query(
    `SELECT DATE(created_at) as date, COUNT(DISTINCT user_id) as active_users
     FROM history
     WHERE created_at >= NOW() - INTERVAL '30 days'
     GROUP BY DATE(created_at)
     ORDER BY date ASC`
  );

  // 6. 顶层汇总
  const totalUploads = await query(`SELECT COUNT(*) as count FROM history`);
  const totalFiles = await query(`SELECT COALESCE(SUM(file_count), 0) as count FROM history`);
  const totalSize = await query(`SELECT COALESCE(SUM(size), 0) as count FROM history`);

  return {
    summary: {
      totalUploads: parseInt(totalUploads.rows[0].count),
      totalFiles: parseInt(totalFiles.rows[0].count),
      totalSize: parseInt(totalSize.rows[0].count),
      totalUsers: parseInt(totalUsers.rows[0].count)
    },
    trend: trendRes.rows.map(r => ({
      date: r.date,
      count: parseInt(r.uploads),
      files: parseInt(r.files),
      size: parseInt(r.size)
    })),
    topRepos: repoDistRes.rows.map(r => ({
      repo: r.repo,
      count: parseInt(r.count),
      files: parseInt(r.files)
    })),
    planDistribution: planDistRes.rows.map(r => ({
      plan: r.plan,
      count: parseInt(r.count)
    })),
    funnel,
    activeHeatmap: activityRes.rows.map(r => ({
      date: r.date,
      activeUsers: parseInt(r.active_users)
    }))
  };
}

// ===== 第二阶段：API 密钥管理 =====
async function createApiKey(userId, keyName) {
  await ensureDB();
  const crypto = require('crypto');
  const apiKey = 'gk_' + crypto.randomBytes(24).toString('hex');
  const res = await query(
    `INSERT INTO api_keys (user_id, key_name, api_key)
     VALUES ($1, $2, $3) RETURNING *`,
    [userId, keyName || 'default', apiKey]
  );
  const k = res.rows[0];
  return {
    id: k.id,
    keyName: k.key_name,
    apiKey: k.api_key,
    status: k.status,
    lastUsedAt: k.last_used_at,
    createdAt: k.created_at
  };
}

async function listApiKeys(userId) {
  await ensureDB();
  const res = await query(`SELECT * FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return res.rows.map(k => ({
    id: k.id,
    keyName: k.key_name,
    apiKey: k.api_key,
    status: k.status,
    lastUsedAt: k.last_used_at,
    createdAt: k.created_at
  }));
}

async function deleteApiKey(userId, keyId) {
  await ensureDB();
  await query(`DELETE FROM api_keys WHERE id = $1 AND user_id = $2`, [keyId, userId]);
  return true;
}

async function findApiKey(apiKey) {
  await ensureDB();
  const res = await query(`SELECT * FROM api_keys WHERE api_key = $1 AND status = 'active' LIMIT 1`, [apiKey]);
  if (res.rows.length === 0) return null;
  const k = res.rows[0];
  // 更新最后使用时间
  await query(`UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`, [k.id]);
  // 获取用户信息
  const user = await findUserById(k.user_id);
  return { userId: k.user_id, user };
}

// ===== 第二阶段：通知消息 =====
async function addNotification(userId, type, title, content) {
  await ensureDB();
  const res = await query(
    `INSERT INTO notifications (user_id, type, title, content)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [userId, type || 'info', title, content || '']
  );
  const n = res.rows[0];
  return { id: n.id, type: n.type, title: n.title, content: n.content, isRead: n.is_read, createdAt: n.created_at };
}

async function getNotifications(userId, limit = 20) {
  await ensureDB();
  const res = await query(
    `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return res.rows.map(n => ({
    id: n.id,
    type: n.type,
    title: n.title,
    content: n.content,
    isRead: n.is_read,
    createdAt: n.created_at
  }));
}

async function getUnreadCount(userId) {
  await ensureDB();
  const res = await query(`SELECT COUNT(*) as cnt FROM notifications WHERE user_id = $1 AND is_read = false`, [userId]);
  return parseInt(res.rows[0].cnt);
}

async function markNotificationRead(userId, notifId) {
  await ensureDB();
  await query(`UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2`, [notifId, userId]);
  return true;
}

async function markAllNotificationsRead(userId) {
  await ensureDB();
  await query(`UPDATE notifications SET is_read = true WHERE user_id = $1`, [userId]);
  return true;
}

// 用户清除自己的所有通知
async function clearNotifications(userId) {
  await ensureDB();
  await query(`DELETE FROM notifications WHERE user_id = $1`, [userId]);
  return true;
}

// ===== 第二阶段：订单管理 =====
async function createOrder(userId, plan, period) {
  await ensureDB();
  const planInfo = PLANS[plan];
  if (!planInfo) throw new Error('未知套餐: ' + plan);

  const orderNo = 'ORD' + Date.now() + Math.random().toString(36).slice(2, 8).toUpperCase();
  let amount = planInfo.price;
  if (period === 'yearly') amount = planInfo.price * 10; // 年付 = 10个月价格

  const res = await query(
    `INSERT INTO orders (user_id, order_no, plan, amount, period, status)
     VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING *`,
    [userId, orderNo, plan, amount, period || 'monthly']
  );
  const o = res.rows[0];
  return {
    id: o.id,
    orderNo: o.order_no,
    plan: o.plan,
    amount: parseFloat(o.amount),
    period: o.period,
    status: o.status,
    createdAt: o.created_at
  };
}

async function getUserOrders(userId) {
  await ensureDB();
  const res = await query(
    `SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [userId]
  );
  return res.rows.map(o => ({
    id: o.id,
    orderNo: o.order_no,
    plan: o.plan,
    amount: parseFloat(o.amount),
    period: o.period,
    status: o.status,
    payMethod: o.pay_method,
    paymentNote: o.payment_note || '',
    paidAt: o.paid_at,
    createdAt: o.created_at
  }));
}

async function getAllOrders(limit = 100) {
  await ensureDB();
  const res = await query(
    `SELECT o.*, u.username, u.brand_name FROM orders o
     LEFT JOIN users u ON o.user_id = u.id
     ORDER BY o.created_at DESC LIMIT $1`,
    [limit]
  );
  return res.rows.map(o => ({
    id: o.id,
    orderNo: o.order_no,
    userId: o.user_id,
    username: o.username || '未知',
    brandName: o.brand_name || '',
    plan: o.plan,
    amount: parseFloat(o.amount),
    period: o.period,
    status: o.status,
    payMethod: o.pay_method,
    paymentNote: o.payment_note || '',
    paidAt: o.paid_at,
    createdAt: o.created_at
  }));
}

// 用户标记订单已支付（填写付款备注，等待管理员确认）
async function markOrderPaid(orderId, userId, paymentNote) {
  await ensureDB();
  const orderRes = await query(
    `SELECT * FROM orders WHERE id = $1 AND user_id = $2 AND status = 'pending' LIMIT 1`,
    [orderId, userId]
  );
  if (orderRes.rows.length === 0) throw new Error('订单不存在或已处理');
  await query(
    `UPDATE orders SET status = 'paid_pending', pay_method = 'manual', payment_note = $1 WHERE id = $2`,
    [String(paymentNote || '').slice(0, 200), orderId]
  );
  return { ok: true };
}

// 管理员确认订单已支付
async function confirmOrder(orderId) {
  await ensureDB();
  const orderRes = await query(`SELECT * FROM orders WHERE id = $1 AND status IN ('pending', 'paid_pending') LIMIT 1`, [orderId]);
  if (orderRes.rows.length === 0) throw new Error('订单不存在或已处理');

  const order = orderRes.rows[0];
  await query(`UPDATE orders SET status = 'paid', paid_at = NOW() WHERE id = $1`, [orderId]);

  // 自动设置用户套餐
  const result = await setUserPlan(order.user_id, order.plan, order.period);

  // 发送通知
  await addNotification(order.user_id, 'success', '套餐开通成功',
    `您的${PLANS[order.plan].name}已开通，有效期至 ${new Date(result.expiresAt).toLocaleDateString('zh-CN')}`);

  return { ok: true, plan: result.plan, expiresAt: result.expiresAt };
}

// 管理员清除未支付订单（pending 和 paid_pending）
async function clearPendingOrders() {
  await ensureDB();
  const res = await query(
    `DELETE FROM orders WHERE status IN ('pending', 'paid_pending') RETURNING id`
  );
  return { deletedCount: res.rowCount };
}

// 用户创建升级订单（提交申请）
async function requestUpgrade(userId, plan, period) {
  await ensureDB();
  const planInfo = PLANS[plan];
  if (!planInfo) throw new Error('未知套餐: ' + plan);
  if (plan === 'free') throw new Error('不能升级到免费版');

  const order = await createOrder(userId, plan, period);

  // 通知管理员（通过系统设置获取）
  await addNotification(userId, 'info', '升级申请已提交',
    `您的${planInfo.name}升级申请已提交，订单号：${order.orderNo}，金额：¥${order.amount}。请联系管理员完成支付。`);

  return order;
}

// ===== 第三阶段：团队协作 =====

// 创建团队
async function createTeam(ownerId, name, description) {
  await ensureDB();
  const id = 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  await query(
    `INSERT INTO teams (id, owner_id, name, description) VALUES ($1, $2, $3, $4)`,
    [id, ownerId, name, description || '']
  );
  // 创建者自动成为管理员成员
  await query(
    `INSERT INTO team_members (team_id, user_id, role, status) VALUES ($1, $2, 'admin', 'active')`,
    [id, ownerId]
  );
  return { id, ownerId, name, description };
}

// 获取用户加入的所有团队
async function getUserTeams(userId) {
  await ensureDB();
  const res = await query(
    `SELECT t.*, tm.role, tm.joined_at FROM teams t
     INNER JOIN team_members tm ON t.id = tm.team_id
     WHERE tm.user_id = $1 AND tm.status = 'active'
     ORDER BY t.created_at DESC`,
    [userId]
  );
  return res.rows.map(t => ({
    id: t.id,
    ownerId: t.owner_id,
    name: t.name,
    description: t.description,
    role: t.role,
    createdAt: t.created_at,
    joinedAt: t.joined_at
  }));
}

// 获取团队详情
async function getTeam(teamId) {
  await ensureDB();
  const res = await query(`SELECT * FROM teams WHERE id = $1 LIMIT 1`, [teamId]);
  if (res.rows.length === 0) return null;
  const t = res.rows[0];
  return { id: t.id, ownerId: t.owner_id, name: t.name, description: t.description, createdAt: t.created_at };
}

// 获取团队成员列表
async function getTeamMembers(teamId) {
  await ensureDB();
  const res = await query(
    `SELECT tm.*, u.username, u.brand_name FROM team_members tm
     LEFT JOIN users u ON tm.user_id = u.id
     WHERE tm.team_id = $1 AND tm.status = 'active'
     ORDER BY tm.joined_at ASC`,
    [teamId]
  );
  return res.rows.map(m => ({
    id: m.id,
    userId: m.user_id,
    username: m.username || '未知用户',
    brandName: m.brand_name || '',
    role: m.role,
    status: m.status,
    joinedAt: m.joined_at
  }));
}

// 检查用户是否是团队成员
async function getTeamMemberRole(teamId, userId) {
  await ensureDB();
  const res = await query(
    `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1`,
    [teamId, userId]
  );
  if (res.rows.length === 0) return null;
  return res.rows[0].role;
}

// 邀请成员加入团队（通过用户名查找）
async function addTeamMember(teamId, userId, role) {
  await ensureDB();
  // 检查是否已在团队中
  const existing = await query(
    `SELECT * FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId]
  );
  if (existing.rows.length > 0) {
    if (existing.rows[0].status === 'active') throw new Error('该用户已在团队中');
    // 重新激活
    await query(
      `UPDATE team_members SET status = 'active', role = $3 WHERE team_id = $1 AND user_id = $2`,
      [teamId, userId, role || 'member']
    );
    return { ok: true, reactivated: true };
  }
  await query(
    `INSERT INTO team_members (team_id, user_id, role, status) VALUES ($1, $2, $3, 'active')`,
    [teamId, userId, role || 'member']
  );
  return { ok: true };
}

// 移除团队成员
async function removeTeamMember(teamId, userId) {
  await ensureDB();
  await query(
    `UPDATE team_members SET status = 'removed' WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId]
  );
  return true;
}

// 更新成员角色
async function updateMemberRole(teamId, userId, role) {
  await ensureDB();
  await query(
    `UPDATE team_members SET role = $3 WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId, role]
  );
  return true;
}

// 删除团队
async function deleteTeam(teamId) {
  await ensureDB();
  await query(`DELETE FROM team_members WHERE team_id = $1`, [teamId]);
  await query(`DELETE FROM team_repos WHERE team_id = $1`, [teamId]);
  await query(`DELETE FROM teams WHERE id = $1`, [teamId]);
  return true;
}

// 共享仓库到团队
async function shareRepoToTeam(teamId, repoId, sharedBy) {
  await ensureDB();
  // 检查是否已共享
  const existing = await query(
    `SELECT * FROM team_repos WHERE team_id = $1 AND repo_id = $2`, [teamId, repoId]
  );
  if (existing.rows.length > 0) throw new Error('该仓库已共享到团队');
  await query(
    `INSERT INTO team_repos (team_id, repo_id, shared_by) VALUES ($1, $2, $3)`,
    [teamId, repoId, sharedBy]
  );
  return true;
}

// 取消共享仓库
async function unshareRepoFromTeam(teamId, repoId) {
  await ensureDB();
  await query(`DELETE FROM team_repos WHERE team_id = $1 AND repo_id = $2`, [teamId, repoId]);
  return true;
}

// 获取团队共享的仓库列表
async function getTeamRepos(teamId) {
  await ensureDB();
  const res = await query(
    `SELECT tr.*, r.name as repo_name, r.repo as repo_url, r.branch, r.target_dir,
            u.username as shared_by_name
     FROM team_repos tr
     LEFT JOIN repos r ON tr.repo_id = r.id
     LEFT JOIN users u ON tr.shared_by = u.id
     WHERE tr.team_id = $1 ORDER BY tr.created_at DESC`,
    [teamId]
  );
  return res.rows.map(r => ({
    id: r.id,
    teamId: r.team_id,
    repoId: r.repo_id,
    repoName: r.repo_name || '未知仓库',
    repoUrl: r.repo_url || '',
    branch: r.branch || 'main',
    targetDir: r.target_dir || '.',
    sharedBy: r.shared_by,
    sharedByName: r.shared_by_name || '未知',
    createdAt: r.created_at
  }));
}

// 获取团队成员上传历史汇总
async function getTeamHistory(teamId, limit = 50) {
  await ensureDB();
  const members = await getTeamMembers(teamId);
  const memberIds = members.map(m => m.user_id);
  if (memberIds.length === 0) return [];
  // 用 ANY 数组匹配
  const res = await query(
    `SELECT h.*, u.username FROM history h
     LEFT JOIN users u ON h.user_id = u.id
     WHERE h.user_id = ANY($1::text[])
     ORDER BY h.created_at DESC LIMIT $2`,
    [memberIds, limit]
  );
  return res.rows.map(h => ({
    id: h.id,
    userId: h.user_id,
    username: h.username || '未知',
    fileName: h.file_name,
    fileCount: h.file_count,
    size: h.size,
    repo: h.repo,
    branch: h.branch,
    status: h.status,
    commitSha: h.commit_sha,
    time: h.created_at
  }));
}

// ===== 单会话登录管理 =====
// 用户登录时更新 active_session，使旧 token 失效
async function updateUserSession(userId, sessionToken) {
  await ensureDB();
  await query(`UPDATE users SET active_session = $1 WHERE id = $2`, [sessionToken, userId]);
  return true;
}

// 管理员登录时更新 active_session
async function updateAdminSession(adminId, sessionToken) {
  await ensureDB();
  await query(`UPDATE admins SET active_session = $1 WHERE id = $2`, [sessionToken, adminId]);
  return true;
}

// 验证用户 token 是否为当前活跃会话
async function validateUserSession(userId, token) {
  await ensureDB();
  const res = await query(`SELECT active_session FROM users WHERE id = $1 LIMIT 1`, [userId]);
  if (res.rows.length === 0) return false;
  const activeSession = res.rows[0].active_session || '';
  // 如果数据库中没有记录 session，允许通过（兼容旧数据）
  if (!activeSession) return true;
  return activeSession === token;
}

// 验证管理员 token 是否为当前活跃会话
async function validateAdminSession(adminId, token) {
  await ensureDB();
  const res = await query(`SELECT active_session FROM admins WHERE id = $1 LIMIT 1`, [adminId]);
  if (res.rows.length === 0) return false;
  const activeSession = res.rows[0].active_session || '';
  if (!activeSession) return true;
  return activeSession === token;
}

// ===== 动态版本号管理 =====
async function getAppVersion() {
  await ensureDB();
  const res = await query(`SELECT value FROM settings WHERE key = 'app_version' LIMIT 1`);
  return res.rows.length > 0 ? res.rows[0].value : 'v2.6.0';
}

async function updateAppVersion(version) {
  await ensureDB();
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('app_version', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [String(version)]
  );
  return true;
}

// ===== 数据库健康检查 =====
async function healthCheck() {
  try {
    const p = getPool();
    const client = await p.connect();
    try {
      await client.query('SELECT 1');
      return { ok: true, message: '数据库连接正常' };
    } finally {
      client.release();
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  PLANS,
  createUser,
  findUserByUsername,
  findUserById,
  updateUser,
  listAllUsers,
  deleteUser,
  getUserPlan,
  checkUploadLimit,
  incrementUploadUsage,
  setUserPlan,
  getUserSubscriptions,
  getPlans,
  addHistory,
  getHistory,
  clearHistory,
  getAllHistory,
  getStats,
  getUserStats,
  getUploadTrend,
  createAdmin,
  findAdmin,
  findAdminById,
  updateAdminPassword,
  ensureDefaultAdmin,
  addRepo,
  listRepos,
  getRepo,
  updateRepo,
  deleteRepo,
  getSetting,
  getAllSettings,
  updateSetting,
  getUserDetail,
  // 第二阶段
  createApiKey,
  listApiKeys,
  deleteApiKey,
  findApiKey,
  addNotification,
  getNotifications,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
  clearNotifications,
  createOrder,
  getUserOrders,
  getAllOrders,
  confirmOrder,
  markOrderPaid,
  clearPendingOrders,
  requestUpgrade,
  // 第三阶段：团队协作
  createTeam,
  getUserTeams,
  getTeam,
  getTeamMembers,
  getTeamMemberRole,
  addTeamMember,
  removeTeamMember,
  updateMemberRole,
  deleteTeam,
  shareRepoToTeam,
  unshareRepoFromTeam,
  getTeamRepos,
  getTeamHistory,
  getAnalyticsData,
  // 单会话登录
  updateUserSession,
  updateAdminSession,
  validateUserSession,
  validateAdminSession,
  // 动态版本号
  getAppVersion,
  updateAppVersion,
  // 健康检查
  healthCheck
};
