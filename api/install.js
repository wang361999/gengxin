/**
 * gitd 安装向导 API
 *
 * 路由：/api/install
 *
 * 支持的 action（通过 query 参数 ?action=xxx 或 body.step 指定）：
 *   - status     GET  检查安装状态（是否已安装、环境变量是否配置）
 *   - db-check   POST 测试数据库连接
 *   - db-init    POST 初始化数据库表结构
 *   - setup      POST 创建管理员账号 + 配置授权码 + 完成安装
 */

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Pool } = require('pg');
const { sendJson, readBody } = require('../lib/helpers');

// ============ 安装状态检查 ============

async function checkInstallStatus() {
  const status = {
    installed: false,
    dbConfigured: false,
    dbConnected: false,
    adminExists: false,
    jwtConfigured: false,
    oauthConfigured: false,
  };

  // 检查环境变量
  const dbUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.POSTGRES_POOL_URL;
  status.dbConfigured = !!dbUrl;
  status.jwtConfigured = !!process.env.JWT_SECRET;

  // 尝试连接数据库
  if (dbUrl) {
    let testPool = null;
    try {
      testPool = new Pool({
        connectionString: dbUrl,
        ssl: { rejectUnauthorized: false },
        max: 1,
        connectionTimeoutMillis: 8000,
      });
      await testPool.query('SELECT 1');
      status.dbConnected = true;

      // 检查是否已有管理员
      try {
        const res = await testPool.query('SELECT COUNT(*) as cnt FROM admins');
        if (res.rows.length > 0 && parseInt(res.rows[0].cnt) > 0) {
          status.adminExists = true;
        }
      } catch {
        // admins 表不存在，说明未初始化
      }

      // 检查是否已完成安装（settings 中有 install_completed = true）
      try {
        const res = await testPool.query("SELECT value FROM settings WHERE key = 'install_completed'");
        if (res.rows.length > 0 && res.rows[0].value === 'true') {
          status.installed = true;
        }
      } catch {
        // settings 表不存在
      }
    } catch (e) {
      status.dbError = e.message;
    } finally {
      if (testPool) {
        try { await testPool.end(); } catch {}
      }
    }
  }

  return status;
}

// ============ 数据库连接测试 ============

async function testDbConnection(connectionString) {
  const connStr = connectionString || process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.POSTGRES_POOL_URL;
  if (!connStr) {
    return { success: false, error: '未检测到数据库连接字符串，请配置 POSTGRES_URL 或 DATABASE_URL 环境变量' };
  }

  let testPool = null;
  try {
    testPool = new Pool({
      connectionString: connStr,
      ssl: { rejectUnauthorized: false },
      max: 1,
      connectionTimeoutMillis: 10000,
    });
    const res = await testPool.query('SELECT version()');
    return { success: true, version: res.rows[0].version };
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    if (testPool) {
      try { await testPool.end(); } catch {}
    }
  }
}

// ============ 数据库初始化 ============

async function initDatabase(connectionString) {
  const connStr = connectionString || process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.POSTGRES_POOL_URL;
  if (!connStr) {
    return { success: false, error: '未检测到数据库连接字符串' };
  }

  let initPool = null;
  try {
    initPool = new Pool({
      connectionString: connStr,
      ssl: { rejectUnauthorized: false },
      max: 1,
      connectionTimeoutMillis: 30000,
    });
    const client = await initPool.connect();

    try {
      // ===== 创建所有数据表 =====

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

      // 为已有表添加缺失的列（兼容旧数据）
      const alterColumns = [
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'free'",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMPTZ DEFAULT NULL",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_note TEXT DEFAULT ''",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS active_session TEXT DEFAULT ''",
        "ALTER TABLE admins ADD COLUMN IF NOT EXISTS active_session TEXT DEFAULT ''",
      ];
      for (const sql of alterColumns) {
        try { await client.query(sql); } catch {}
      }

      // 初始化默认设置
      await client.query(`
        INSERT INTO settings (key, value)
        VALUES
          ('site_name', 'gitd'),
          ('allow_register', 'true'),
          ('announcement', ''),
          ('free_upload_limit', '50'),
          ('pro_price', '29'),
          ('enterprise_price', '99'),
          ('contact_email', ''),
          ('contact_wechat', ''),
          ('alipay_qrcode', ''),
          ('wechat_qrcode', ''),
          ('payment_instructions', '请在付款备注中填写订单号后6位，以便管理员核对'),
          ('plans_enabled', 'false'),
          ('donation_enabled', 'true'),
          ('donation_title', '支持开发者'),
          ('donation_message', '如果这个工具对你有帮助，可以考虑请开发者喝杯咖啡'),
          ('license_key', ''),
          ('license_verify_url', 'https://gitd.cn/api/license/verify'),
          ('license_domain', ''),
          ('license_enabled', 'false'),
          ('license_product_slug', ''),
          ('license_version_api_url', 'https://gitd.cn/api'),
          ('legal_enabled', 'true'),
          ('complaint_email', 'admin@gitd.cn'),
          ('app_version', 'v3.0.0'),
          ('admin_password_changed', 'false')
        ON CONFLICT (key) DO NOTHING
      `);

      // 初始化 GitHub OAuth 默认配置
      await client.query(`
        INSERT INTO settings (key, value) VALUES ('github_oauth_client_id', '') ON CONFLICT (key) DO NOTHING
      `);
      await client.query(`
        INSERT INTO settings (key, value) VALUES ('github_oauth_client_secret', '') ON CONFLICT (key) DO NOTHING
      `);

      return { success: true, message: '数据库表结构创建成功' };
    } finally {
      client.release();
    }
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    if (initPool) {
      try { await initPool.end(); } catch {}
    }
  }
}

// ============ 创建管理员账号 ============

async function createAdmin(connectionString, username, password) {
  const connStr = connectionString || process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.POSTGRES_POOL_URL;
  if (!connStr) {
    return { success: false, error: '未检测到数据库连接字符串' };
  }

  let adminPool = null;
  try {
    adminPool = new Pool({
      connectionString: connStr,
      ssl: { rejectUnauthorized: false },
      max: 1,
      connectionTimeoutMillis: 15000,
    });
    const client = await adminPool.connect();

    try {
      // 删除已有的默认管理员
      await client.query("DELETE FROM admins WHERE username = 'admin' AND id = 'admin_1'");
      await client.query("DELETE FROM users WHERE username = 'admin' AND id = 'admin_user'");

      // 创建新管理员
      const hash = await bcrypt.hash(password, 10);
      const safeUsername = username.toLowerCase().trim();

      await client.query(
        `INSERT INTO admins (id, username, password_hash) VALUES ('admin_1', $1, $2)`,
        [safeUsername, hash]
      );

      // 同步创建企业管理员用户记录
      await client.query(
        `INSERT INTO users (id, username, password_hash, brand_name, brand_color, brand_logo, status, plan)
         VALUES ('admin_user', $1, $2, '管理员', '#111827', '', 'active', 'enterprise')
         ON CONFLICT (username) DO UPDATE SET password_hash = $2, status = 'active', plan = 'enterprise'`,
        [safeUsername, hash]
      );

      // 标记密码已修改
      await client.query(
        `INSERT INTO settings (key, value) VALUES ('admin_password_changed', 'true') ON CONFLICT (key) DO UPDATE SET value = 'true'`
      );

      return { success: true, message: '管理员账号创建成功' };
    } finally {
      client.release();
    }
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    if (adminPool) {
      try { await adminPool.end(); } catch {}
    }
  }
}

// ============ 配置授权码 ============

async function configureLicense(connectionString, licenseKey) {
  const connStr = connectionString || process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.POSTGRES_POOL_URL;
  if (!connStr) {
    return { success: false, error: '未检测到数据库连接字符串' };
  }

  let licensePool = null;
  try {
    licensePool = new Pool({
      connectionString: connStr,
      ssl: { rejectUnauthorized: false },
      max: 1,
      connectionTimeoutMillis: 15000,
    });
    const client = await licensePool.connect();

    try {
      // 保存授权码
      await client.query(
        `INSERT INTO settings (key, value) VALUES ('license_key', $1) ON CONFLICT (key) DO UPDATE SET value = $1`,
        [licenseKey]
      );

      // 保存验证地址
      await client.query(
        `INSERT INTO settings (key, value) VALUES ('license_verify_url', 'https://gitd.cn/api/license/verify') ON CONFLICT (key) DO UPDATE SET value = 'https://gitd.cn/api/license/verify'`
      );

      if (licenseKey) {
        // 启用授权验证
        await client.query(
          `INSERT INTO settings (key, value) VALUES ('license_enabled', 'true') ON CONFLICT (key) DO UPDATE SET value = 'true'`
        );
      }

      return { success: true, message: '授权码配置成功' };
    } finally {
      client.release();
    }
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    if (licensePool) {
      try { await licensePool.end(); } catch {}
    }
  }
}

// ============ 完成安装 ============

async function completeInstall(connectionString) {
  const connStr = connectionString || process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.POSTGRES_POOL_URL;
  if (!connStr) {
    return { success: false, error: '未检测到数据库连接字符串' };
  }

  let completePool = null;
  try {
    completePool = new Pool({
      connectionString: connStr,
      ssl: { rejectUnauthorized: false },
      max: 1,
      connectionTimeoutMillis: 15000,
    });
    const client = await completePool.connect();

    try {
      // 标记安装完成
      await client.query(
        `INSERT INTO settings (key, value) VALUES ('install_completed', 'true') ON CONFLICT (key) DO UPDATE SET value = 'true'`
      );

      // 记录安装时间
      const installTime = new Date().toISOString();
      await client.query(
        `INSERT INTO settings (key, value) VALUES ('install_time', $1) ON CONFLICT (key) DO UPDATE SET value = $1`,
        [installTime]
      );

      // 记录安装指纹（用于防篡改，绑定当前部署环境）
      const fingerprint = crypto.createHash('sha256').update(installTime + Math.random().toString()).digest('hex');
      await client.query(
        `INSERT INTO settings (key, value) VALUES ('install_fingerprint', $1) ON CONFLICT (key) DO UPDATE SET value = $1`,
        [fingerprint]
      );

      return { success: true, message: '安装完成', redirect: '/login' };
    } finally {
      client.release();
    }
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    if (completePool) {
      try { await completePool.end(); } catch {}
    }
  }
}

// ============ 主入口 ============

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const action = url.searchParams.get('action') || '';

  // GET /api/install?action=status - 检查安装状态
  if (req.method === 'GET' && action === 'status') {
    try {
      const status = await checkInstallStatus();
      return sendJson(res, 200, { ok: true, status });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: '检查状态失败: ' + e.message });
    }
  }

  // 以下操作都需要 POST
  if (req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: '只支持 GET 和 POST' });
  }

  try {
    const body = await readBody(req);
    const step = body.step || action;
    const connectionString = body.connectionString || '';

    // POST /api/install - 测试数据库连接
    if (step === 'db-check') {
      const result = await testDbConnection(connectionString);
      return sendJson(res, 200, { ok: result.success, ...result });
    }

    // POST /api/install - 初始化数据库
    if (step === 'db-init') {
      const result = await initDatabase(connectionString);
      return sendJson(res, 200, { ok: result.success, ...result });
    }

    // POST /api/install - 创建管理员
    if (step === 'create-admin') {
      const { username, password } = body;
      if (!username || !password) {
        return sendJson(res, 400, { ok: false, error: '请填写用户名和密码' });
      }
      if (password.length < 8) {
        return sendJson(res, 400, { ok: false, error: '密码至少 8 位' });
      }
      const result = await createAdmin(connectionString, username, password);
      return sendJson(res, 200, { ok: result.success, ...result });
    }

    // POST /api/install - 配置授权码
    if (step === 'license') {
      const { licenseKey } = body;
      const result = await configureLicense(connectionString, licenseKey || '');
      return sendJson(res, 200, { ok: result.success, ...result });
    }

    // POST /api/install - 完成安装
    if (step === 'complete') {
      const result = await completeInstall(connectionString);
      return sendJson(res, 200, { ok: result.success, ...result });
    }

    // POST /api/install - 一键完成所有步骤
    if (step === 'setup-all') {
      const { username, password, licenseKey } = body;

      if (!username || !password) {
        return sendJson(res, 400, { ok: false, error: '请填写管理员用户名和密码' });
      }
      if (password.length < 8) {
        return sendJson(res, 400, { ok: false, error: '密码至少 8 位' });
      }

      // 1. 初始化数据库
      const initResult = await initDatabase(connectionString);
      if (!initResult.success) {
        return sendJson(res, 500, { ok: false, error: '数据库初始化失败: ' + initResult.error });
      }

      // 2. 创建管理员
      const adminResult = await createAdmin(connectionString, username, password);
      if (!adminResult.success) {
        return sendJson(res, 500, { ok: false, error: '管理员创建失败: ' + adminResult.error });
      }

      // 3. 配置授权码（如果有）
      if (licenseKey) {
        const licenseResult = await configureLicense(connectionString, licenseKey);
        if (!licenseResult.success) {
          return sendJson(res, 500, { ok: false, error: '授权配置失败: ' + licenseResult.error });
        }
      }

      // 4. 完成安装
      const completeResult = await completeInstall(connectionString);
      if (!completeResult.success) {
        return sendJson(res, 500, { ok: false, error: '完成安装失败: ' + completeResult.error });
      }

      return sendJson(res, 200, {
        ok: true,
        message: '安装完成！即将跳转到登录页面',
        redirect: '/login'
      });
    }

    return sendJson(res, 400, { ok: false, error: '未知的操作步骤: ' + step });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: '服务器错误: ' + e.message });
  }
};
