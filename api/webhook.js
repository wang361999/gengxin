const { sendJson, readBody } = require('../lib/helpers');
const { requireAuth, initSecret } = require('../lib/auth');
const { addWebhook, listWebhooks, deleteWebhook, testWebhook } = require('../lib/webhook');

module.exports = async (req, res) => {
  await initSecret();
  const segments = (req.url || '').split('?')[0].split('/').filter(Boolean);
  const urlAction = segments[segments.length - 1];

  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    // ===== 获取 Webhook 列表 =====
    if (req.method === 'GET' || urlAction === 'list') {
      const webhooks = await listWebhooks(user.userId);
      return sendJson(res, 200, { ok: true, webhooks });
    }

    // POST 请求：从 body 中提取 _action 来判断具体操作
    if (req.method === 'POST') {
      const body = await readBody(req);
      const action = body._action || urlAction;

      // 创建 Webhook
      if (action === 'create' || action === 'webhook') {
        const url = String(body.url || '').trim();
        const platform = String(body.platform || 'custom').trim();
        const events = Array.isArray(body.events) ? body.events : ['upload'];
        const secret = String(body.secret || '').trim();

        if (!url) return sendJson(res, 400, { error: 'Webhook URL 必填' });
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          return sendJson(res, 400, { error: 'URL 必须以 http:// 或 https:// 开头' });
        }

        const webhook = await addWebhook(user.userId, url, events, platform, secret);
        return sendJson(res, 200, { ok: true, message: 'Webhook 添加成功', webhook });
      }

      // 删除 Webhook
      if (action === 'delete') {
        if (!body.id) return sendJson(res, 400, { error: '缺少 Webhook ID' });
        await deleteWebhook(user.userId, body.id);
        return sendJson(res, 200, { ok: true, message: 'Webhook 已删除' });
      }

      // 测试 Webhook
      if (action === 'test') {
        if (!body.id) return sendJson(res, 400, { error: '缺少 Webhook ID' });
        try {
          const result = await testWebhook(user.userId, body.id);
          return sendJson(res, 200, { ok: true, message: '测试消息已发送', status: result.status });
        } catch (e) {
          return sendJson(res, 400, { error: '测试失败: ' + e.message });
        }
      }

      return sendJson(res, 404, { error: '未知的操作: ' + action });
    }

    // DELETE 请求：删除 Webhook
    if (req.method === 'DELETE') {
      const body = await readBody(req);
      if (!body.id) return sendJson(res, 400, { error: '缺少 Webhook ID' });
      await deleteWebhook(user.userId, body.id);
      return sendJson(res, 200, { ok: true, message: 'Webhook 已删除' });
    }

    return sendJson(res, 404, { error: '未知的操作: ' + urlAction });
  } catch (err) {
    return sendJson(res, 500, { error: err.message || 'Webhook 服务错误' });
  }
};
