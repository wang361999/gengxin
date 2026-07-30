const https = require('https');
const http = require('http');
const { URL } = require('url');
const { getEmailConfig, getUserEmailNotify, findUserById } = require('./db');

// 通过 Resend API 发送邮件（需要配置 API Key）
async function sendEmailResend(to, subject, html, apiKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      from: 'GitUpload <noreply@resend.dev>',
      to: to,
      subject: subject,
      html: html
    });

    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 15000
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          const data = JSON.parse(raw);
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data });
        } catch {
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data: raw });
        }
      });
    });

    req.on('timeout', () => req.destroy(new Error('邮件发送超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// 通过自定义 SMTP 代理发送（用户可配置自己的 Webhook 邮件服务）
async function sendEmailWebhook(url, to, subject, html, secret) {
  const { triggerWebhook } = require('./webhook');
  // 通过 webhook 发送邮件通知（复用 webhook 系统）
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ to, subject, html, type: 'email' });
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;

    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Email-Secret': secret || ''
      },
      timeout: 15000
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300 }));
    });

    req.on('timeout', () => req.destroy(new Error('邮件 Webhook 超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// 生成上传结果邮件 HTML
function formatUploadEmail(success, data) {
  const statusColor = success ? '#059669' : '#dc2626';
  const statusText = success ? '上传成功' : '上传失败';
  const icon = success ? '✅' : '❌';

  let details = `
    <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#666;">仓库</td><td style="padding:8px 0;border-bottom:1px solid #eee;font-weight:600;">${data.repo || '-'}</td></tr>
    <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#666;">分支</td><td style="padding:8px 0;border-bottom:1px solid #eee;font-weight:600;">${data.branch || '-'}</td></tr>
    <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#666;">文件名</td><td style="padding:8px 0;border-bottom:1px solid #eee;font-weight:600;">${data.fileName || '-'}</td></tr>
    <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#666;">文件数</td><td style="padding:8px 0;border-bottom:1px solid #eee;font-weight:600;">${data.fileCount || 0}</td></tr>
  `;

  if (data.commitSha) {
    details += `<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#666;">Commit</td><td style="padding:8px 0;border-bottom:1px solid #eee;font-family:monospace;font-size:12px;">${data.commitSha.substring(0, 7)}</td></tr>`;
  }
  if (data.error) {
    details += `<tr><td style="padding:8px 0;color:#666;">错误信息</td><td style="padding:8px 0;color:#dc2626;">${data.error}</td></tr>`;
  }

  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif;">
  <div style="max-width:560px;margin:20px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
    <div style="background:${statusColor};padding:24px 32px;color:#fff;">
      <div style="font-size:24px;">${icon}</div>
      <div style="font-size:18px;font-weight:700;margin-top:8px;">${statusText}</div>
    </div>
    <div style="padding:24px 32px;">
      <table style="width:100%;font-size:14px;border-collapse:collapse;">
        ${details}
        <tr><td style="padding:8px 0;color:#666;">时间</td><td style="padding:8px 0;">${time}</td></tr>
      </table>
      <div style="margin-top:24px;padding:16px;background:#f9fafb;border-radius:8px;font-size:13px;color:#6b7280;">
        此邮件由 GitUpload 系统自动发送，请勿回复。
      </div>
    </div>
  </div>
</body></html>`;
}

// 发送上传通知邮件给用户
async function sendUploadEmail(userId, success, data) {
  try {
    // 获取用户的邮件通知配置
    const userNotify = await getUserEmailNotify(userId);
    if (!userNotify || !userNotify.enabled || !userNotify.email) return;

    // 获取邮件发送配置
    const emailConfig = await getEmailConfig();
    if (!emailConfig) return;

    const subject = success ? `GitUpload 上传成功 - ${data.repo || ''}` : `GitUpload 上传失败 - ${data.repo || ''}`;
    const html = formatUploadEmail(success, data);

    if (emailConfig.provider === 'resend' && emailConfig.apiKey) {
      await sendEmailResend(userNotify.email, subject, html, emailConfig.apiKey);
    } else if (emailConfig.provider === 'webhook' && emailConfig.webhookUrl) {
      await sendEmailWebhook(emailConfig.webhookUrl, userNotify.email, subject, html, emailConfig.secret);
    }
  } catch (e) {
    // 邮件发送失败不影响主流程
    console.error('邮件发送失败:', e.message);
  }
}

module.exports = { sendEmailResend, sendEmailWebhook, sendUploadEmail, formatUploadEmail };
