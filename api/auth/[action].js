const bcrypt = require('bcryptjs');
const https = require('https');
const { sendJson, readBody } = require('../../lib/helpers');
const { findUserByUsername, ensureDefaultAdmin, findAdmin, createUser, findUserById, updateUser, deleteUser, getSetting, getAllSettings, getUserPlan, getUserSubscriptions, getPlans, getNotifications, getUnreadCount, markNotificationRead, markAllNotificationsRead, clearNotifications, getUserOrders, requestUpgrade, listApiKeys, createApiKey, deleteApiKey, markOrderPaid, updateUserSession, updateAdminSession, getAppVersion, updateAppVersion, healthCheck, getOnlineCount, getOnlineUsers, cleanOnlineSessions } = require('../../lib/db');
const { signToken, signAdminToken, requireAuth, initSecret, extractToken } = require('../../lib/auth');
const { loginLimiter, registerLimiter, getClientIp, cleanupStore } = require('../../lib/rateLimit');

// 通过 GitHub Token 获取用户信息
function getGithubUserByToken(token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: '/user',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'git-upload-saas',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(data);
        } catch (e) {
          reject(new Error('解析 GitHub 用户信息失败'));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = async (req, res) => {
  await initSecret();
  const segments = (req.url || '').split('?')[0].split('/').filter(Boolean);
  const action = segments[segments.length - 1];

  try {
    // ===== 公开设置（无需登录） =====
    if (action === 'public-settings') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
      const all = await getAllSettings();
      // 检查授权状态：没有配置有效授权码即为未授权
      let licenseAuthorized = false;
      let licenseVerified = false;
      const licenseKey = all.license_key || '';
      const licenseEnabled = all.license_enabled === 'true';

      if (licenseKey) {
        // 有授权码，检查是否验证通过
        const { checkLicenseForRequest } = require('../../lib/license-verifier');
        try {
          const result = await checkLicenseForRequest();
          licenseVerified = !!result.valid;
          licenseAuthorized = licenseVerified;
        } catch {
          // SDK 异常时当作未验证
          licenseAuthorized = false;
        }
      }
      // 管理员豁免：license_enabled 未开启时也显示未授权横幅（只要有授权码就检查，没有授权码就是未授权）
      return sendJson(res, 200, {
        ok: true,
        settings: {
          siteName: all.site_name || 'GitShip',
          allowRegister: all.allow_register !== 'false',
          announcement: all.announcement || '',
          legalEnabled: all.legal_enabled !== 'false',
          complaintEmail: all.complaint_email || '',
          userAgreement: all.user_agreement || '',
          privacyPolicy: all.privacy_policy || ''
        },
        license: {
          enabled: licenseEnabled,
          authorized: licenseAuthorized,
          hasKey: !!licenseKey,
          verified: licenseVerified
        }
      });
    }

    // ===== 获取套餐列表（公开） =====
    if (action === 'plans') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
      const all = await getAllSettings();
      const plans = getPlans();
      // 套餐功能开关：关闭时所有套餐价格置为 0（免费），适合前期推广
      // 注：db.js 初始化时 plans_enabled 默认 'false'（关闭），以数据库实际值为准
      const plansOff = all.plans_enabled === 'false';
      const planList = Object.values(plans).map(p => {
        // 套餐关闭时，所有套餐价格返回 0（免费）
        const price = plansOff ? 0 : (
          p.id === 'pro' ? (parseFloat(all.pro_price) || p.price) :
          p.id === 'enterprise' ? (parseFloat(all.enterprise_price) || p.price) :
          p.price
        );
        return { ...p, price };
      });
      return sendJson(res, 200, { ok: true, plans: planList, plansEnabled: !plansOff });
    }

    // ===== 获取打赏/赞助信息（公开） =====
    if (action === 'donation-info') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
      const all = await getAllSettings();
      return sendJson(res, 200, {
        ok: true,
        donation: {
          enabled: all.donation_enabled !== 'false',
          title: all.donation_title || '支持开发者',
          message: all.donation_message || '如果这个工具对你有帮助，可以考虑请开发者喝杯咖啡 ☕',
          alipayQrcode: all.alipay_qrcode || '',
          wechatQrcode: all.wechat_qrcode || ''
        }
      });
    }

    // ===== 获取收款信息（公开，用户付款页展示） =====
    if (action === 'payment-info') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
      const all = await getAllSettings();
      return sendJson(res, 200, {
        ok: true,
        payment: {
          alipayQrcode: all.alipay_qrcode || '',
          wechatQrcode: all.wechat_qrcode || '',
          instructions: all.payment_instructions || '请在付款备注中填写订单号后6位，以便管理员核对',
          contactWechat: all.contact_wechat || '',
          contactEmail: all.contact_email || ''
        }
      });
    }

    // ===== 动态版本号（公开，前端检测版本变化强制刷新） =====
    if (action === 'version') {
      const version = await getAppVersion();
      return sendJson(res, 200, { ok: true, version: version });
    }

    // ===== 数据库健康检查（公开，诊断连接状态） =====
    if (action === 'health') {
      const result = await healthCheck();
      // 同时检查环境变量
      const envStatus = {
        hasDbUrl: !!(process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.POSTGRES_POOL_URL),
        hasJwtSecret: !!process.env.JWT_SECRET,
        nodeVersion: process.version || 'unknown'
      };
      return sendJson(res, 200, { ok: true, db: result, env: envStatus });
    }

    // ===== 在线人数（公开端点） =====
    if (action === 'online-count') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
      const count = await getOnlineCount();
      return sendJson(res, 200, { ok: true, onlineCount: count });
    }

    // ===== 登录 =====
    if (action === 'login') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      cleanupStore();
      const ip = getClientIp(req);
      if (loginLimiter(ip)) return sendJson(res, 429, { error: '请求过于频繁，请稍后再试' });
      await ensureDefaultAdmin();
      const body = await readBody(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!username || !password) return sendJson(res, 400, { error: '用户名和密码必填' });

      // 优先检查管理员账号（避免与同名普通用户冲突）
      const admin = await findAdmin(username);
      if (admin) {
        const valid = await bcrypt.compare(password, admin.passwordHash);
        if (!valid) return sendJson(res, 401, { error: '用户名或密码错误' });
        const token = await signAdminToken({ adminId: admin.id, username: admin.username });
        // 单会话登录：记录当前活跃 token，使旧 token 自动失效
        try { await updateAdminSession(admin.id, token); } catch {}
        // 检查是否需要强制修改密码
        const pwdChanged = await getSetting('admin_password_changed');
        return sendJson(res, 200, { ok: true, token, role: 'admin', redirect: '/admin', needChangePassword: pwdChanged !== 'true' });
      }

      const user = await findUserByUsername(username);
      if (user) {
        // 检查账号状态
        if (user.status === 'disabled') {
          return sendJson(res, 403, { error: '账号已被禁用，请联系管理员' });
        }
        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) return sendJson(res, 401, { error: '用户名或密码错误' });
        const token = await signToken({ userId: user.id, username: user.username });
        // 单会话登录：记录当前活跃 token，使旧 token 自动失效
        try { await updateUserSession(user.id, token); } catch {}
        return sendJson(res, 200, { ok: true, token, role: 'user', redirect: '/dashboard' });
      }
      return sendJson(res, 401, { error: '用户名或密码错误' });
    }

    // ===== GitHub Token 登录（用 GitHub Personal Access Token 登录/注册） =====
    if (action === 'github-login') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      cleanupStore();
      const ip = getClientIp(req);
      if (loginLimiter(ip)) return sendJson(res, 429, { error: '请求过于频繁，请稍后再试' });

      const body = await readBody(req);
      const ghToken = String(body.token || '').trim();
      if (!ghToken) return sendJson(res, 400, { error: '请输入 GitHub Token' });

      // 通过 Token 获取 GitHub 用户信息
      let ghUser;
      try {
        ghUser = await getGithubUserByToken(ghToken);
      } catch (e) {
        return sendJson(res, 401, { error: 'GitHub Token 验证失败，请检查 Token 是否有效' });
      }
      if (!ghUser || !ghUser.login) {
        return sendJson(res, 401, { error: 'GitHub Token 无效或已过期' });
      }

      // 检查是否已有该 GitHub 用户（username 格式: github_用户名）
      const ghUsername = 'github_' + ghUser.login.toLowerCase();
      let user = await findUserByUsername(ghUsername);

      if (user) {
        // 已有账号，直接登录
        if (user.status === 'disabled') {
          return sendJson(res, 403, { error: '账号已被禁用，请联系管理员' });
        }
        const token = await signToken({ userId: user.id, username: user.username });
        try { await updateUserSession(user.id, token); } catch {}
        return sendJson(res, 200, { ok: true, token, role: 'user', redirect: '/dashboard' });
      }

      // 没有账号则自动注册
      const allowRegister = await getSetting('allow_register');
      if (allowRegister === 'false') {
        return sendJson(res, 403, { error: '系统已关闭注册，无法通过 GitHub 登录' });
      }

      // 使用随机密码创建用户（GitHub 登录用户不需要密码）
      const randomPwd = Math.random().toString(36).slice(2) + Date.now().toString(36);
      const hash = await bcrypt.hash(randomPwd, 10);
      user = await createUser(ghUsername, hash, ghUser.name || ghUser.login);
      const token = await signToken({ userId: user.id, username: user.username });
      try { await updateUserSession(user.id, token); } catch {}
      return sendJson(res, 200, { ok: true, token, role: 'user', redirect: '/dashboard', githubUser: ghUser.login });
    }

    // ===== 注册 =====
    if (action === 'register') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      cleanupStore();
      const ip = getClientIp(req);
      if (registerLimiter(ip)) return sendJson(res, 429, { error: '注册请求过于频繁，请稍后再试' });

      const allowRegister = await getSetting('allow_register');
      if (allowRegister === 'false') {
        return sendJson(res, 403, { error: '系统已关闭注册，请联系管理员' });
      }

      const body = await readBody(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const brandName = String(body.brandName || '').trim();

      if (!username || username.length < 3 || username.length > 20) {
        return sendJson(res, 400, { error: '用户名 3-20 个字符' });
      }
      if (!password || password.length < 6) {
        return sendJson(res, 400, { error: '密码至少 6 位' });
      }

      const existing = await findUserByUsername(username);
      if (existing) return sendJson(res, 409, { error: '用户名已被注册' });

      const hash = await bcrypt.hash(password, 10);
      const user = await createUser(username, hash, brandName || username);
      const token = await signToken({ userId: user.id, username: user.username });
      // 单会话登录：记录当前活跃 token
      try { await updateUserSession(user.id, token); } catch {}
      return sendJson(res, 201, { ok: true, token, user: { id: user.id, username: user.username, brandName: user.brandName } });
    }

    // ===== 以下操作需要登录 =====
    const authUser = await requireAuth(req, res);
    if (!authUser) return;

    // ===== 获取当前用户信息（含套餐） =====
    if (action === 'me') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
      // 管理员特殊处理：返回默认企业版信息
      if (authUser.isAdmin || authUser.role === 'admin') {
        const planInfo = await getUserPlan(authUser.userId);
        return sendJson(res, 200, {
          ok: true,
          user: {
            id: authUser.userId,
            username: authUser.username || 'admin',
            brandName: 'GitShip',
            brandColor: '#111827',
            brandLogo: '',
            status: 'active',
            plan: planInfo
          }
        });
      }
      const profile = await findUserById(authUser.userId);
      if (!profile) return sendJson(res, 404, { error: '用户不存在' });
      const planInfo = await getUserPlan(authUser.userId);
      return sendJson(res, 200, {
        ok: true,
        user: {
          id: profile.id,
          username: profile.username,
          brandName: profile.brandName,
          brandColor: profile.brandColor,
          brandLogo: profile.brandLogo,
          status: profile.status,
          plan: planInfo
        }
      });
    }

    // ===== 获取套餐详情 =====
    if (action === 'plan') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
      const planInfo = await getUserPlan(authUser.userId);
      const subs = await getUserSubscriptions(authUser.userId);
      return sendJson(res, 200, { ok: true, plan: planInfo, subscriptions: subs });
    }

    // ===== 修改密码 / 更新品牌 =====
    if (action === 'update') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      const body = await readBody(req);

      if (body.oldPassword) {
        const profile = await findUserById(authUser.userId);
        if (!profile) return sendJson(res, 404, { error: '用户不存在' });
        const valid = await bcrypt.compare(body.oldPassword, profile.passwordHash);
        if (!valid) return sendJson(res, 401, { error: '旧密码不正确' });
        if (!body.newPassword || body.newPassword.length < 6) return sendJson(res, 400, { error: '新密码至少 6 位' });
        const hash = await bcrypt.hash(body.newPassword, 10);
        await updateUser(authUser.userId, { passwordHash: hash });
        return sendJson(res, 200, { ok: true, message: '密码已修改' });
      }

      const updates = {};
      if (body.brandName !== undefined) updates.brandName = String(body.brandName).slice(0, 50);
      if (body.brandColor !== undefined) updates.brandColor = String(body.brandColor).slice(0, 20);
      if (body.brandLogo !== undefined) updates.brandLogo = String(body.brandLogo).slice(0, 500);

      const updated = await updateUser(authUser.userId, updates);
      return sendJson(res, 200, { ok: true, user: { brandName: updated.brandName, brandColor: updated.brandColor, brandLogo: updated.brandLogo } });
    }

    // ===== 注销账号 =====
    if (action === 'delete-account') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      const body = await readBody(req);
      const password = String(body.password || '');
      if (!password) return sendJson(res, 400, { error: '请输入密码确认注销' });

      const profile = await findUserById(authUser.userId);
      if (!profile) return sendJson(res, 404, { error: '用户不存在' });

      const valid = await bcrypt.compare(password, profile.passwordHash);
      if (!valid) return sendJson(res, 401, { error: '密码不正确' });

      await deleteUser(authUser.userId);
      return sendJson(res, 200, { ok: true, message: '账号已注销，所有数据已删除' });
    }

    // ===== 第二阶段：通知消息 =====
    if (action === 'notifications') {
      if (req.method === 'GET') {
        const list = await getNotifications(authUser.userId);
        const unread = await getUnreadCount(authUser.userId);
        return sendJson(res, 200, { ok: true, notifications: list, unreadCount: unread });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (body.markAll) {
          await markAllNotificationsRead(authUser.userId);
          return sendJson(res, 200, { ok: true, message: '全部已读' });
        }
        if (body.id) {
          await markNotificationRead(authUser.userId, body.id);
          return sendJson(res, 200, { ok: true, message: '已标记为已读' });
        }
      }
      if (req.method === 'DELETE') {
        await clearNotifications(authUser.userId);
        return sendJson(res, 200, { ok: true, message: '通知已清除' });
      }
      return sendJson(res, 400, { error: '参数错误' });
    }

    // ===== 第二阶段：创建升级订单 =====
    if (action === 'create-order') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      const body = await readBody(req);
      if (!body.plan) return sendJson(res, 400, { error: '请选择套餐' });
      const period = body.period === 'yearly' ? 'yearly' : 'monthly';
      try {
        const order = await requestUpgrade(authUser.userId, body.plan, period);
        return sendJson(res, 200, { ok: true, order, message: '升级申请已提交，请联系管理员完成支付' });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    // ===== 第二阶段：获取我的订单 =====
    if (action === 'my-orders') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
      const orders = await getUserOrders(authUser.userId);
      return sendJson(res, 200, { ok: true, orders });
    }

    // ===== 第三阶段：用户标记订单已支付（填写付款备注） =====
    if (action === 'mark-order-paid') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      const body = await readBody(req);
      if (!body.orderId) return sendJson(res, 400, { error: '缺少订单 ID' });
      try {
        await markOrderPaid(body.orderId, authUser.userId, body.paymentNote || '');
        return sendJson(res, 200, { ok: true, message: '已标记为已支付，等待管理员确认开通' });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    // ===== 第二阶段：API 密钥管理 =====
    if (action === 'api-keys') {
      if (req.method === 'GET') {
        const keys = await listApiKeys(authUser.userId);
        return sendJson(res, 200, { ok: true, keys });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const key = await createApiKey(authUser.userId, body.keyName || 'default');
        return sendJson(res, 200, { ok: true, key, message: 'API 密钥已创建' });
      }
      if (req.method === 'DELETE') {
        const body = await readBody(req);
        if (!body.id) return sendJson(res, 400, { error: '缺少密钥 ID' });
        await deleteApiKey(authUser.userId, body.id);
        return sendJson(res, 200, { ok: true, message: '密钥已删除' });
      }
      return sendJson(res, 405, { error: '方法不支持' });
    }

    return sendJson(res, 404, { error: '未知的操作: ' + action });
  } catch (err) {
    return sendJson(res, 500, { error: err.message || '服务器错误' });
  }
};
