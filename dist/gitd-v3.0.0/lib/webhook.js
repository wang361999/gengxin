const https = require('https');
const http = require('http');
const { URL } = require('url');
const { query, ensureDB } = require('./db');

// Webhook 配置表（存储在 settings 中，key 格式: webhook_{userId}_{type}）
// 也支持用独立的 webhook_configs 表

async function ensureWebhookTable() {
  try {
    await ensureDB();
    await query(`
      CREATE TABLE IF NOT EXISTS webhook_configs (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        url TEXT NOT NULL,
        events TEXT[] DEFAULT '{}',
        platform TEXT DEFAULT 'custom',
        secret TEXT DEFAULT '',
        status TEXT DEFAULT 'active',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_webhook_user ON webhook_configs(user_id)`);
  } catch (e) {
    // 静默忽略
  }
}

// 发送 HTTP 请求
function sendRequest(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const body = JSON.stringify(data);

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'git-upload-webhook/1.0',
        ...headers
      },
      timeout: 10000
    };

    const req = lib.request(options, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve({ status: res.statusCode }));
    });

    req.on('timeout', () => req.destroy(new Error('Webhook 超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// 飞书消息格式
function formatFeishuMessage(event, data) {
  const color = data.success ? 'green' : 'red';
  const status = data.success ? '✅ 成功' : '❌ 失败';

  let content = `**gitd 通知**\n\n**事件**: ${event}\n**状态**: ${status}\n`;
  if (data.repo) content += `**仓库**: ${data.repo}\n`;
  if (data.branch) content += `**分支**: ${data.branch}\n`;
  if (data.fileName) content += `**文件**: ${data.fileName}\n`;
  if (data.fileCount) content += `**文件数**: ${data.fileCount}\n`;
  if (data.commitSha) content += `**Commit**: ${data.commitSha.substring(0, 7)}\n`;
  if (data.format) content += `**格式**: ${data.format.toUpperCase()}\n`;
  if (data.timestamp) content += `**时间**: ${data.timestamp}\n`;
  if (data.error) content += `**错误**: ${data.error}\n`;

  return {
    msg_type: 'interactive',
    card: {
      header: { template: color, title: { tag: 'plain_text', content: 'gitd 上传通知' } },
      elements: [{ tag: 'div', text: { tag: 'lark_md', content } }]
    }
  };
}

// 钉钉消息格式
function formatDingtalkMessage(event, data) {
  const status = data.success ? '✅ 成功' : '❌ 失败';
  let text = `### gitd 通知\n\n**事件**: ${event}\n**状态**: ${status}\n`;
  if (data.repo) text += `**仓库**: ${data.repo}\n`;
  if (data.branch) text += `**分支**: ${data.branch}\n`;
  if (data.fileName) text += `**文件**: ${data.fileName}\n`;
  if (data.fileCount) text += `**文件数**: ${data.fileCount}\n`;
  if (data.commitSha) text += `**Commit**: ${data.commitSha.substring(0, 7)}\n`;
  if (data.timestamp) text += `**时间**: ${data.timestamp}\n`;
  if (data.error) text += `**错误**: ${data.error}\n`;

  return {
    msgtype: 'markdown',
    markdown: { title: 'gitd 通知', text }
  };
}

// 企业微信消息格式
function formatWechatWorkMessage(event, data) {
  const status = data.success ? '✅ 成功' : '❌ 失败';
  let content = `gitd 通知\n\n事件: ${event}\n状态: ${status}\n`;
  if (data.repo) content += `仓库: ${data.repo}\n`;
  if (data.branch) content += `分支: ${data.branch}\n`;
  if (data.fileName) content += `文件: ${data.fileName}\n`;
  if (data.fileCount) content += `文件数: ${data.fileCount}\n`;
  if (data.commitSha) content += `Commit: ${data.commitSha.substring(0, 7)}\n`;
  if (data.timestamp) content += `时间: ${data.timestamp}\n`;
  if (data.error) content += `错误: ${data.error}\n`;

  return {
    msgtype: 'text',
    text: { content }
  };
}

// Discord 消息格式
function formatDiscordMessage(event, data) {
  const color = data.success ? 3066993 : 15158332; // green / red
  const fields = [];
  if (data.repo) fields.push({ name: '仓库', value: data.repo, inline: true });
  if (data.branch) fields.push({ name: '分支', value: data.branch, inline: true });
  if (data.fileName) fields.push({ name: '文件', value: data.fileName, inline: true });
  if (data.fileCount) fields.push({ name: '文件数', value: String(data.fileCount), inline: true });
  if (data.commitSha) fields.push({ name: 'Commit', value: data.commitSha.substring(0, 7), inline: true });
  if (data.format) fields.push({ name: '格式', value: data.format.toUpperCase(), inline: true });
  if (data.timestamp) fields.push({ name: '时间', value: data.timestamp, inline: true });
  if (data.error) fields.push({ name: '错误', value: data.error, inline: false });

  return {
    embeds: [{
      title: `gitd 通知 - ${event}`,
      color,
      fields,
      footer: { text: 'gitd SaaS' },
      timestamp: data.timestamp || new Date().toISOString()
    }]
  };
}

// 根据平台格式化消息
function formatMessage(platform, event, data) {
  switch (platform) {
    case 'feishu': return formatFeishuMessage(event, data);
    case 'dingtalk': return formatDingtalkMessage(event, data);
    case 'wechat_work': return formatWechatWorkMessage(event, data);
    case 'discord': return formatDiscordMessage(event, data);
    default: return data; // custom: 原始 JSON
  }
}

// 触发 Webhook
async function triggerWebhook(userId, event, data) {
  try {
    await ensureWebhookTable();
    const res = await query(
      `SELECT * FROM webhook_configs WHERE user_id = $1 AND status = 'active' AND ($2 = ANY(events) OR 'all' = ANY(events))`,
      [userId, event]
    );

    if (res.rows.length === 0) return;

    const promises = res.rows.map(async (config) => {
      try {
        const message = formatMessage(config.platform, event, data);
        const headers = {};
        if (config.secret) {
          headers['X-Webhook-Secret'] = config.secret;
        }
        await sendRequest(config.url, message, headers);
      } catch (e) {
        // 单个 webhook 失败不影响其他
        console.error('Webhook 发送失败:', e.message);
      }
    });

    await Promise.allSettled(promises);
  } catch (e) {
    // webhook 失败不影响主流程
  }
}

// Webhook 配置管理
async function addWebhook(userId, url, events, platform, secret) {
  await ensureWebhookTable();
  const res = await query(
    `INSERT INTO webhook_configs (user_id, url, events, platform, secret)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [userId, url, events || ['upload'], platform || 'custom', secret || '']
  );
  return res.rows[0];
}

async function listWebhooks(userId) {
  await ensureWebhookTable();
  const res = await query(`SELECT * FROM webhook_configs WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return res.rows;
}

async function deleteWebhook(userId, id) {
  await ensureWebhookTable();
  await query(`DELETE FROM webhook_configs WHERE id = $1 AND user_id = $2`, [id, userId]);
  return true;
}

async function testWebhook(userId, id) {
  await ensureWebhookTable();
  const res = await query(`SELECT * FROM webhook_configs WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (res.rows.length === 0) throw new Error('Webhook 配置不存在');
  const config = res.rows[0];
  const testData = {
    success: true,
    event: 'test',
    message: '这是一条测试消息',
    timestamp: new Date().toISOString()
  };
  const message = formatMessage(config.platform, 'test', testData);
  const headers = {};
  if (config.secret) headers['X-Webhook-Secret'] = config.secret;
  return await sendRequest(config.url, message, headers);
}

module.exports = { triggerWebhook, addWebhook, listWebhooks, deleteWebhook, testWebhook, ensureWebhookTable };
