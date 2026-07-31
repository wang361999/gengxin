const bcrypt = require('bcryptjs');
const { sendJson, readBody } = require('../../lib/helpers');
const { requireAdmin, initSecret } = require('../../lib/auth');
const {
  listAllUsers, ensureDefaultAdmin, deleteUser, getStats, getAllHistory,
  findAdminById, updateAdminPassword, getUserDetail, getUploadTrend,
  getAllSettings, updateSetting, updateUser, setUserPlan, getPlans,
  getAllOrders, confirmOrder, clearPendingOrders, addNotification,
  getAnalyticsData, getSetting, getAppVersion, updateAppVersion, healthCheck,
  getOnlineCount, getOnlineUsers, cleanOnlineSessions,
  getErrorLogs, getErrorStats, clearErrorLogs
} = require('../../lib/db');
const vercel = require('../../lib/vercel');

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
      const onlineCount = await getOnlineCount();
      return sendJson(res, 200, { ok: true, stats, onlineCount });
    }

    // ===== 在线用户列表（管理员） =====
    if (action === 'online-users') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
      const onlineCount = await getOnlineCount();
      const onlineUsers = await getOnlineUsers();
      // 顺便清理过期记录
      cleanOnlineSessions().catch(() => {});
      return sendJson(res, 200, { ok: true, onlineCount, users: onlineUsers });
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
        const allowedKeys = ['site_name', 'allow_register', 'announcement', 'free_upload_limit', 'pro_price', 'enterprise_price', 'alipay_qrcode', 'wechat_qrcode', 'payment_instructions', 'contact_email', 'contact_wechat', 'github_oauth_client_id', 'github_oauth_client_secret', 'vercel_token', 'vercel_project_id', 'plans_enabled', 'donation_enabled', 'donation_title', 'donation_message', 'legal_enabled', 'complaint_email', 'user_agreement', 'privacy_policy', 'license_key', 'license_verify_url', 'license_domain', 'license_enabled', 'license_product_slug', 'license_version_api_url'];
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
          siteName: all.site_name || 'gitd',
          allowRegister: all.allow_register !== 'false',
          appVersion: all.app_version || 'unknown'
        }
      });
    }

    // ===== Vercel 项目状态 =====
    if (action === 'vercel-status') {
      if (req.method === 'GET') {
        // 读取 Vercel Token 和 Project ID（从环境变量或数据库设置）
        const vercelToken = process.env.VERCEL_TOKEN || await getSetting('vercel_token') || '';
        const vercelProjectId = process.env.VERCEL_PROJECT_ID || await getSetting('vercel_project_id') || '';

        if (!vercelToken) {
          return sendJson(res, 200, { ok: false, error: '未配置 Vercel Token，请在设置中配置', configured: false });
        }

        try {
          const status = await vercel.getProjectStatus(vercelToken, vercelProjectId);
          return sendJson(res, 200, {
            ok: true,
            configured: true,
            hasProjectId: !!vercelProjectId,
            ...status
          });
        } catch (e) {
          return sendJson(res, 200, { ok: false, configured: true, error: e.message });
        }
      }
      if (req.method === 'POST') {
        // 保存 Vercel 配置
        const body = await readBody(req);
        if (body.vercelToken !== undefined) {
          await updateSetting('vercel_token', body.vercelToken);
        }
        if (body.vercelProjectId !== undefined) {
          await updateSetting('vercel_project_id', body.vercelProjectId);
        }
        return sendJson(res, 200, { ok: true, message: 'Vercel 配置已保存' });
      }
      return sendJson(res, 405, { error: '只支持 GET 和 POST' });
    }

    // ===== Vercel 部署列表 =====
    if (action === 'vercel-deployments') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
      const vercelToken = process.env.VERCEL_TOKEN || await getSetting('vercel_token') || '';
      const vercelProjectId = process.env.VERCEL_PROJECT_ID || await getSetting('vercel_project_id') || '';
      if (!vercelToken) return sendJson(res, 400, { error: '未配置 Vercel Token' });
      try {
        const data = await vercel.getDeployments(vercelProjectId, vercelToken, 20);
        return sendJson(res, 200, { ok: true, ...data });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // ===== Vercel 构建日志 =====
    if (action === 'vercel-logs') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      const body = await readBody(req);
      if (!body.deploymentId) return sendJson(res, 400, { error: '缺少 deploymentId' });
      const vercelToken = process.env.VERCEL_TOKEN || await getSetting('vercel_token') || '';
      if (!vercelToken) return sendJson(res, 400, { error: '未配置 Vercel Token' });
      try {
        const logs = await vercel.getBuildLogs(body.deploymentId, vercelToken);
        return sendJson(res, 200, { ok: true, logs });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // ===== Vercel 重新部署 =====
    if (action === 'vercel-redeploy') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      const body = await readBody(req);
      if (!body.deploymentId) return sendJson(res, 400, { error: '缺少 deploymentId' });
      const vercelToken = process.env.VERCEL_TOKEN || await getSetting('vercel_token') || '';
      if (!vercelToken) return sendJson(res, 400, { error: '未配置 Vercel Token' });
      try {
        const result = await vercel.redeploy(body.deploymentId, vercelToken);
        return sendJson(res, 200, { ok: true, message: '已触发重新部署', ...result });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // ===== 错误监控：获取错误日志列表 =====
    if (action === 'error-logs') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
      // 解析查询参数 ?limit=50&type=api
      const queryStr = (req.url || '').split('?')[1] || '';
      const params = new URLSearchParams(queryStr);
      const limit = parseInt(params.get('limit')) || 50;
      const type = params.get('type') || '';
      const statusCode = params.get('statusCode');
      const filter = {};
      if (type) filter.type = type;
      if (statusCode != null && statusCode !== '') filter.statusCode = statusCode;
      const logs = await getErrorLogs(limit, filter);
      return sendJson(res, 200, { ok: true, logs, count: logs.length });
    }

    // ===== 错误监控：获取错误统计 =====
    if (action === 'error-stats') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
      const stats = await getErrorStats();
      return sendJson(res, 200, { ok: true, stats });
    }

    // ===== 错误监控：清空所有错误日志 =====
    if (action === 'clear-errors') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      const result = await clearErrorLogs();
      return sendJson(res, 200, { ok: true, message: `已清除 ${result.deletedCount} 条错误日志`, deletedCount: result.deletedCount });
    }

    // ===== 授权验证：测试授权码 =====
    if (action === 'license-test') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      const body = await readBody(req);
      const licenseKey = String(body.license_key || '').trim();
      const verifyUrl = String(body.verify_url || 'https://gitd.cn/api/license/verify').trim();
      const domain = String(body.domain || '').trim();

      if (!licenseKey) return sendJson(res, 400, { error: '请填写授权码' });

      try {
        const { verifyLicense } = require('../../lib/license-verifier');
        const result = await verifyLicense({ licenseKey, verifyUrl, domain });
        return sendJson(res, 200, { ok: true, valid: !!result.valid, message: result.message || '', info: result });
      } catch (err) {
        return sendJson(res, 200, { ok: true, valid: false, message: err.message || '验证失败' });
      }
    }

    // ===== 授权验证：获取当前授权状态 =====
    if (action === 'license-status') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
      const { getLicenseStatus } = require('../../lib/license-verifier');
      const status = getLicenseStatus();
      const licenseEnabled = await getSetting('license_enabled');
      const licenseKey = await getSetting('license_key');
      const verifyUrl = await getSetting('license_verify_url');
      const licenseDomain = await getSetting('license_domain');
      return sendJson(res, 200, {
        ok: true,
        enabled: licenseEnabled === 'true',
        configured: !!(licenseKey && verifyUrl),
        status: {
          isVerified: status.isVerified,
          lastCheckTime: status.lastCheckTime,
          licenseInfo: status.licenseInfo
        },
        config: {
          licenseKey: licenseKey ? licenseKey.substring(0, 8) + '****' : '',
          verifyUrl: verifyUrl || 'https://gitd.cn/api/license/verify',
          domain: licenseDomain || ''
        }
      });
    }

    // ===== 授权验证：强制重新验证（清除缓存） =====
    if (action === 'license-recheck') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      const licenseKey = await getSetting('license_key');
      const verifyUrl = await getSetting('license_verify_url') || 'https://gitd.cn/api/license/verify';
      const licenseDomain = await getSetting('license_domain');

      if (!licenseKey) return sendJson(res, 400, { error: '未配置授权码' });

      try {
        // 清除缓存
        const { verifyLicense } = require('../../lib/license-verifier');
        const result = await verifyLicense({ licenseKey, verifyUrl, domain: licenseDomain || undefined });
        return sendJson(res, 200, {
          ok: true,
          valid: !!result.valid,
          message: result.message || '',
          info: result
        });
      } catch (err) {
        return sendJson(res, 200, { ok: true, valid: false, message: err.message || '验证失败' });
      }
    }

    // ===== 版本更新检查 =====
    if (action === 'version-check') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      const productSlug = await getSetting('license_product_slug');
      const versionApiUrl = await getSetting('license_version_api_url') || 'https://gitd.cn/api';
      const currentVersion = await getAppVersion();

      if (!productSlug) return sendJson(res, 400, { error: '未配置产品标识（product slug），请先在后台配置' });

      try {
        const { checkVersion } = require('../../lib/license-verifier');
        const result = await checkVersion(versionApiUrl, productSlug, currentVersion);
        return sendJson(res, 200, { ok: true, result });
      } catch (err) {
        return sendJson(res, 200, { ok: true, result: { hasUpdate: false, message: err.message || '检查失败' } });
      }
    }

    return sendJson(res, 404, { error: '未知的操作: ' + action });
  } catch (err) {
    return sendJson(res, 500, { error: err.message || '服务器错误' });
  }
};
