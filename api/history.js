const { sendJson, readBody } = require('../lib/helpers');
const { requireAuth, initSecret } = require('../lib/auth');
const { getHistory, clearHistory, getUserStats } = require('../lib/db');

module.exports = async (req, res) => {
  await initSecret();
  const user = await requireAuth(req, res);
  if (!user) return;

  // 解析 URL 和查询参数
  const urlParts = (req.url || '').split('?');
  const path = urlParts[0];
  const queryParams = {};
  if (urlParts[1]) {
    urlParts[1].split('&').forEach(function(pair) {
      var kv = pair.split('=');
      queryParams[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
    });
  }

  // ===== 用户统计（通过查询参数 ?mode=stats） =====
  if (queryParams.mode === 'stats') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
    try {
      const stats = await getUserStats(user.userId);
      return sendJson(res, 200, { ok: true, stats });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // ===== 历史记录 =====

  // GET: 获取历史记录
  if (req.method === 'GET') {
    try {
      const records = await getHistory(user.userId, 50);
      return sendJson(res, 200, { ok: true, records });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // DELETE: 清除历史记录
  if (req.method === 'DELETE') {
    try {
      await clearHistory(user.userId);
      return sendJson(res, 200, { ok: true, message: '历史记录已清除' });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  return sendJson(res, 405, { error: '只支持 GET 和 DELETE' });
};
