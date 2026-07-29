const bcrypt = require('bcryptjs');
const { sendJson, readBody } = require('../../lib/helpers');
const { requireAdmin, initSecret } = require('../../lib/auth');
const {
  listAllUsers, ensureDefaultAdmin, deleteUser, getStats, getAllHistory,
  findAdminById, updateAdminPassword, getUserDetail, getUploadTrend,
  getAllSettings, updateSetting, updateUser, setUserPlan, getPlans,
  getAllOrders, confirmOrder, clearPendingOrders, addNotification,
  getAnalyticsData, getSetting, getAppVersion, updateAppVersion, healthCheck
} = require('../../lib/db');

module.exports = async (req, res) => {
  await initSecret();
  const segments = (req.url || '').split('?')[0].split('/').filter(Boolean);
  const action = segments[segments.length - 1];

  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    // ===== 获取所有用户 =====
    if (action === 'users') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
      await ensureDefaultAdmin();
      const users = await listAllUsers();
      return sendJson(res, 200, { ok: true, users, count: users.length });
    }

    // ===== 用户详情 =====
    if (action === 'user-detail') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      const body = await readBody(req);
      if (!body.userId) return sendJson(res, 400, { error: '缺少 userId' });
      const detail = await getUserDetail(body.userId);
      if (!detail) return sendJson(res, 404, { error: '用户不存在' });
      return sendJson(res, 200, { ok: true, user: detail });
    }

    // ===== 删除用户 =====
    if (action === 'delete-user') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      const body = await readBody(req);
      if (!body.userId) return sendJson(res, 400, { error: '缺少 userId' });
      const ok = await deleteUser(body.userId);
      if (!ok) return sendJson(res, 404, { error: '用户不存在' });
      return sendJson(res, 200, { ok: true, message: '用户已删除' });
    }

    // ===== 禁用/启用用户 =====
    if (action === 'toggle-user-status') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      const body = await readBody(req);
      if (!body.userId) return sendJson(res, 400, { error: '缺少 userId' });
      const detail = await getUserDetail(body.userId);
      if (!detail) return sendJson(res, 404, { error: '用户不存在' });
      const newStatus = detail.status === 'disabled' ? 'active' : 'disabled';
      await updateUser(body.userId, { status: newStatus });
      return sendJson(res, 200, { ok: true, status: newStatus, message: newStatus === 'disabled' ? '用户已禁用' : '用户已启用' });
    }

    // ===== 设置用户套餐 =====
    if (action === 'set-user-plan') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      const body = await readBody(req);
      if (!body.userId) return sendJson(res, 400, { error: '缺少 userId' });
      if (!body.plan) return sendJson(res, 400, { error: '缺少 plan' });
      const period = body.period === 'yearly' ? 'yearly' : 'monthly';
      const result = await setUserPlan(body.userId, body.plan, period);
      return sendJson(res, 200, { ok: true, message: '套餐已设置', plan: result.plan, expiresAt: result.expiresAt });
    }

    // ===== 统计 =====
    if (action === 'stats') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
      const stats = await getStats();
      return sendJson(res, 200, { ok: true, stats });
    }

    // ===== 上传趋势（最近30天） =====
    if (action === 'trend') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
      const trend = await getUploadTrend(30);
      return sendJson(res, 200, { ok: true, trend });
    }

    // ===== 全局历史记录 =====
    if (action === 'history') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
      const records = await getAllHistory(100);
      return sendJson(res, 200, { ok: true, records });
    }

    // ===== 获取系统设置 =====
    if (action === 'settings') {
      if (req.method === 'GET') {
        const settings = await getAllSettings();
        return sendJson(res, 200, { ok: true, settings });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const allowedKeys = ['site_name', 'allow_register', 'announcement', 'free_upload_limit', 'pro_price', 'enterprise_price', 'alipay_qrcode', 'wechat_qrcode', 'payment_instructions', 'contact_email', 'contact_wechat'];
        for (const key of allowedKeys) {
          if (body[key] !== undefined) {
            await updateSetting(key, body[key]);
          }
        }
        return sendJson(res, 200, { ok: true, message: '设置已保存' });
      }
      return sendJson(res, 405, { error: '只支持 GET 和 POST' });
    }

    // ===== 获取套餐配置 =====
    if (action === 'plans') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
      const all = await getAllSettings();
      const plans = getPlans();
      const planList = Object.values(plans).map(p => ({
        ...p,
        price: p.id === 'pro' ? (parseFloat(all.pro_price) || p.price) :
               p.id === 'enterprise' ? (parseFloat(all.enterprise_price) || p.price) :
               p.price
      }));
      return sendJson(res, 200, { ok: true, plans: planList });
    }

    // ===== 修改管理员密码 =====
    if (action === 'change-password') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      const body = await readBody(req);
      const oldPassword = String(body.oldPassword || '');
      const newPassword = String(body.newPassword || '');

      if (!oldPassword || !newPassword) {
        return sendJson(res, 400, { error: '请填写旧密码和新密码' });
      }
      if (newPassword.length < 6) {
        return sendJson(res, 400, { error: '新密码至少 6 位' });
      }

      const adminUser = await findAdminById(admin.adminId);
      if (!adminUser) return sendJson(res, 404, { error: '管理员不存在' });

      const valid = await bcrypt.compare(oldPassword, adminUser.passwordHash);
      if (!valid) return sendJson(res, 401, { error: '旧密码不正确' });

      const hash = await bcrypt.hash(newPassword, 10);
      await updateAdminPassword(admin.adminId, hash);
      // 标记管理员密码已修改
      await updateSetting('admin_password_changed', 'true');

      return sendJson(res, 200, { ok: true, message: '密码已修改，请重新登录' });
    }

    // ===== 第二阶段：订单管理 =====
    if (action === 'orders') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
      const orders = await getAllOrders();
      return sendJson(res, 200, { ok: true, orders });
    }

    // ===== 第二阶段：确认订单支付 =====
    if (action === 'confirm-order') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      const body = await readBody(req);
      if (!body.orderId) return sendJson(res, 400, { error: '缺少订单 ID' });
      try {
        const result = await confirmOrder(body.orderId);
        return sendJson(res, 200, { ok: true, message: '订单已确认，套餐已开通', ...result });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    // ===== 清除未支付订单 =====
    if (action === 'clear-pending-orders') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      const result = await clearPendingOrders();
      return sendJson(res, 200, { ok: true, message: `已清除 ${result.deletedCount} 笔未支付订单`, deletedCount: result.deletedCount });
    }

    // ===== 第二阶段：广播通知 =====
    if (action === 'broadcast') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      const body = await readBody(req);
      if (!body.title) return sendJson(res, 400, { error: '请输入通知标题' });

      const users = await listAllUsers();
      for (const u of users) {
        if (u.status === 'active') {
          await addNotification(u.id, body.type || 'info', body.title, body.content || '');
        }
      }
      return sendJson(res, 200, { ok: true, message: `已向 ${users.filter(u => u.status === 'active').length} 位用户发送通知` });
    }

    // ===== 数据分析 =====
    if (action === 'analytics') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
      const data = await getAnalyticsData();
      return sendJson(res, 200, { ok: true, analytics: data });
    }

    // ===== 版本管理：获取 / 更新动态版本号 =====
    if (action === 'version') {
      if (req.method === 'GET') {
        const version = await getAppVersion();
        return sendJson(res, 200, { ok: true, version });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const newVersion = String(body.version || '').trim();
        if (!newVersion) return sendJson(res, 400, { error: '版本号不能为空' });
        await updateAppVersion(newVersion);
        return sendJson(res, 200, { ok: true, message: '版本号已更新，所有用户将在下次访问时自动刷新', version: newVersion });
      }
      return sendJson(res, 405, { error: '只支持 GET 和 POST' });
    }

    // ===== 系统健康检查 =====
    if (action === 'health') {
      const dbHealth = await healthCheck();
      const all = await getAllSettings();
      const envStatus = {
        hasDbUrl: !!(process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.POSTGRES_POOL_URL),
        hasJwtSecret: !!process.env.JWT_SECRET,
        nodeVersion: process.version || 'unknown',
        vercelRegion: process.env.VERCEL_REGION || 'unknown'
      };
      return sendJson(res, 200, {
        ok: true,
        db: dbHealth,
        env: envStatus,
        settings: {
          siteName: all.site_name || 'GitUpload',
          allowRegister: all.allow_register !== 'false',
          appVersion: all.app_version || 'unknown'
        }
      });
    }

    return sendJson(res, 404, { error: '未知的操作: ' + action });
  } catch (err) {
    return sendJson(res, 500, { error: err.message || '服务器错误' });
  }
};
