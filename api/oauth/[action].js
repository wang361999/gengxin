const https = require('https');
const bcrypt = require('bcryptjs');
const { sendJson, readBody } = require('../../lib/helpers');
const { requireAuth, initSecret, signToken } = require('../../lib/auth');
const { addRepo, listRepos, getSetting, findUserByUsername, createUser, updateUserSession } = require('../../lib/db');
const { encrypt } = require('../../lib/crypto');

// GitHub OAuth 配置（异步：getSetting 是异步函数）
async function getOAuthConfig() {
  return {
    clientId: process.env.GITHUB_OAUTH_CLIENT_ID || await getSetting('github_oauth_client_id') || '',
    clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET || await getSetting('github_oauth_client_secret') || ''
  };
}

// 交换 code 获取 access_token
function exchangeCode(code, clientId, clientSecret, redirectUri) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri
    });

    const req = https.request({
      hostname: 'github.com',
      path: '/login/oauth/access_token',
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'git-upload-saas'
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(data);
        } catch (e) {
          reject(new Error('解析 OAuth 响应失败'));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// 获取 GitHub 用户信息
function getGithubUser(token) {
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
          reject(new Error('解析用户信息失败'));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// 获取用户的仓库列表
function getUserRepos(token, page = 1, perPage = 100) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: `/user/repos?sort=updated&per_page=${perPage}&page=${page}&affiliation=owner,collaborator`,
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
          reject(new Error('解析仓库列表失败'));
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
    // ===== 获取 OAuth 授权 URL =====
    if (action === 'auth-url' || (req.method === 'GET' && !action)) {
      if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
      const clientId = process.env.GITHUB_OAUTH_CLIENT_ID || await getSetting('github_oauth_client_id');
      if (!clientId) {
        return sendJson(res, 200, { ok: true, enabled: false, message: 'GitHub OAuth 未配置' });
      }
      const urlObj = new URL(req.url, 'http://localhost');
      const isLogin = urlObj.searchParams.get('login') === '1';
      const redirectUri = req.headers.origin + '/api/oauth/callback' + (isLogin ? '?login=1' : '');
      const scope = 'repo,read:user';
      const state = Math.random().toString(36).substring(2);
      const authUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&state=${state}`;
      return sendJson(res, 200, { ok: true, enabled: true, authUrl, state });
    }

    // ===== OAuth 回调（GitHub 授权后回调，自动登录/注册） =====
    if (action === 'callback') {
      const url = new URL(req.url, req.headers.origin);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');
      // login=1 表示从登录页发起的 OAuth（用于自动登录）
      const isLogin = url.searchParams.get('login') === '1';

      if (error) {
        const redirectPage = isLogin ? '/login' : '/dashboard';
        res.setHeader('Location', redirectPage + '?oauth_error=' + encodeURIComponent(error));
        res.statusCode = 302;
        return res.end();
      }
      if (!code) return sendJson(res, 400, { error: '缺少 code 参数' });

      const clientId = process.env.GITHUB_OAUTH_CLIENT_ID || await getSetting('github_oauth_client_id');
      const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET || await getSetting('github_oauth_client_secret');
      if (!clientId || !clientSecret) return sendJson(res, 500, { error: 'OAuth 未配置' });

      const redirectUri = req.headers.origin + '/api/oauth/callback';
      const tokenData = await exchangeCode(code, clientId, clientSecret, redirectUri);

      if (tokenData.error) {
        const redirectPage = isLogin ? '/login' : '/dashboard';
        res.setHeader('Location', redirectPage + '?oauth_error=' + encodeURIComponent(tokenData.error_description || tokenData.error));
        res.statusCode = 302;
        return res.end();
      }

      const ghToken = tokenData.access_token;
      if (!ghToken) return sendJson(res, 400, { error: '获取 Token 失败' });

      // 获取 GitHub 用户信息
      let ghUser;
      try {
        ghUser = await getGithubUser(ghToken);
      } catch (e) {
        return sendJson(res, 500, { error: '获取 GitHub 用户信息失败' });
      }
      if (!ghUser || !ghUser.login) return sendJson(res, 400, { error: 'GitHub 用户信息无效' });

      // ===== 自动登录/注册 =====
      const ghUsername = 'github_' + ghUser.login.toLowerCase();
      let user = await findUserByUsername(ghUsername);

      if (user) {
        // 已有账号，检查是否被禁用
        if (user.status === 'disabled') {
          res.setHeader('Location', '/login?oauth_error=' + encodeURIComponent('账号已被禁用'));
          res.statusCode = 302;
          return res.end();
        }
        // 签发系统 JWT 并更新会话
        const jwtToken = await signToken({ userId: user.id, username: user.username });
        try { await updateUserSession(user.id, jwtToken); } catch {}
        // 重定向到前端，带上 JWT token
        const redirectPage = user.role === 'admin' ? '/admin' : '/dashboard';
        res.setHeader('Location', redirectPage + '?token=' + encodeURIComponent(jwtToken) + '&oauth_token=' + encodeURIComponent(ghToken));
        res.statusCode = 302;
        return res.end();
      }

      // 没有账号则自动注册
      const allowRegister = await getSetting('allow_register');
      if (allowRegister === 'false') {
        res.setHeader('Location', '/login?oauth_error=' + encodeURIComponent('系统已关闭注册'));
        res.statusCode = 302;
        return res.end();
      }

      const randomPwd = Math.random().toString(36).slice(2) + Date.now().toString(36);
      const hash = await bcrypt.hash(randomPwd, 10);
      user = await createUser(ghUsername, hash, ghUser.name || ghUser.login);
      const jwtToken = await signToken({ userId: user.id, username: user.username });
      try { await updateUserSession(user.id, jwtToken); } catch {}

      // 重定向到前端，带上 JWT token 和 GitHub token
      res.setHeader('Location', '/dashboard?token=' + encodeURIComponent(jwtToken) + '&oauth_token=' + encodeURIComponent(ghToken));
      res.statusCode = 302;
      return res.end();
    }

    // ===== 以下需要登录 =====
    const user = await requireAuth(req, res);
    if (!user) return;

    // ===== 导入 OAuth Token 为仓库 =====
    if (action === 'import-token') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      const body = await readBody(req);
      const ghToken = String(body.token || body.oauthToken || '');
      if (!ghToken) return sendJson(res, 400, { error: '缺少 Token' });

      // 获取用户信息
      const ghUser = await getGithubUser(ghToken);
      if (!ghUser || !ghUser.login) return sendJson(res, 400, { error: 'Token 无效' });

      // 获取仓库列表
      const repos = await getUserRepos(ghToken);
      const repoList = (Array.isArray(repos) ? repos : []).map(function(r) {
        return {
          id: r.id,
          name: r.name,
          fullName: r.full_name,
          url: r.html_url,
          cloneUrl: r.clone_url,
          defaultBranch: r.default_branch,
          private: r.private,
          description: r.description || '',
          updatedAt: r.updated_at
        };
      });

      return sendJson(res, 200, {
        ok: true,
        githubUser: { login: ghUser.login, avatar: ghUser.avatar_url, name: ghUser.name || ghUser.login },
        repos: repoList
      });
    }

    // ===== 一键导入仓库（加密存储 Token） =====
    if (action === 'import-repo') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      const body = await readBody(req);
      const ghToken = String(body.token || body.oauthToken || '');
      const repoUrl = String(body.repoUrl || body.cloneUrl || '');
      const repoName = String(body.repoName || body.fullName || body.name || '');
      const branch = String(body.branch || body.defaultBranch || 'main');
      const targetDir = String(body.targetDir || '.');

      if (!ghToken || !repoUrl) return sendJson(res, 400, { error: '缺少 Token 或仓库地址' });

      const encToken = encrypt(ghToken);
      const repo = await addRepo(user.userId, {
        name: repoName,
        repo: repoUrl,
        encToken,
        branch,
        targetDir
      });

      return sendJson(res, 200, { ok: true, message: '仓库导入成功', repo });
    }

    return sendJson(res, 404, { error: '未知的操作: ' + action });
  } catch (err) {
    return sendJson(res, 500, { error: err.message || 'OAuth 服务错误' });
  }
};
