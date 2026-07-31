const https = require('https');

// Vercel API 基础请求函数
function vercelRequest(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    };
    let payload = null;
    if (body) {
      payload = JSON.stringify(body);
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request({
      hostname: 'api.vercel.com',
      path,
      method,
      headers,
      timeout: 15000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
        resolve({ status: res.statusCode, data, headers: res.headers });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Vercel API 超时')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// 获取项目信息
async function getProject(projectId, token) {
  const res = await vercelRequest('GET', `/v1/projects/${projectId}`, token);
  if (res.status === 404) throw new Error('Vercel 项目不存在');
  if (res.status === 401) throw new Error('Vercel Token 无效');
  if (res.status !== 200) throw new Error(`获取项目信息失败: ${res.data?.message || res.status}`);
  return res.data;
}

// 获取项目部署列表
async function getDeployments(projectId, token, limit = 20) {
  const query = projectId ? `?projectId=${projectId}&limit=${limit}` : `?limit=${limit}`;
  const res = await vercelRequest('GET', `/v6/deployments${query}`, token);
  if (res.status !== 200) throw new Error(`获取部署列表失败: ${res.data?.message || res.status}`);
  return res.data;
}

// 获取单个部署详情
async function getDeployment(deploymentId, token) {
  const res = await vercelRequest('GET', `/v13/deployments/${deploymentId}`, token);
  if (res.status !== 200) throw new Error(`获取部署详情失败: ${res.data?.message || res.status}`);
  return res.data;
}

// 获取部署的构建日志
async function getBuildLogs(deploymentId, token) {
  const res = await vercelRequest('GET', `/v2/deployments/${deploymentId}/events`, token);
  if (res.status !== 200) throw new Error(`获取构建日志失败: ${res.data?.message || res.status}`);
  return res.data;
}

// 获取项目环境变量
async function getEnvVars(projectId, token) {
  const res = await vercelRequest('GET', `/v8/projects/${projectId}/env`, token);
  if (res.status !== 200) throw new Error(`获取环境变量失败: ${res.data?.message || res.status}`);
  return res.data;
}

// 获取用户信息（验证 Token）
async function getUser(token) {
  const res = await vercelRequest('GET', '/v2/user', token);
  if (res.status === 401) throw new Error('Vercel Token 无效');
  if (res.status !== 200) throw new Error(`获取用户信息失败: ${res.data?.message || res.status}`);
  return res.data;
}

// 获取项目域名
async function getDomains(projectId, token) {
  const res = await vercelRequest('GET', `/v9/projects/${projectId}/domains`, token);
  if (res.status !== 200) return [];
  return res.data || [];
}

// 重新触发部署
async function redeploy(deploymentId, token) {
  const res = await vercelRequest('POST', `/v13/deployments/${deploymentId}/redeploy`, token, {});
  if (res.status < 200 || res.status >= 300) throw new Error(`重新部署失败: ${res.data?.message || res.status}`);
  return res.data;
}

// 获取所有项目的综合状态
async function getProjectStatus(token, projectId) {
  const result = {
    user: null,
    project: null,
    deployments: [],
    envVars: [],
    domains: [],
    latestDeployment: null
  };

  // 1. 获取用户信息（验证 Token）
  try {
    result.user = await getUser(token);
  } catch (e) {
    throw new Error('Vercel Token 验证失败: ' + e.message);
  }

  // 2. 获取项目信息
  if (projectId) {
    try {
      result.project = await getProject(projectId, token);
    } catch (e) {
      result.projectError = e.message;
    }

    // 3. 获取部署列表
    try {
      const depData = await getDeployments(projectId, token, 10);
      result.deployments = (depData.deployments || []).map(d => ({
        id: d.id,
        uid: d.uid,
        name: d.name,
        url: d.url,
        state: d.state,
        created: d.created,
        meta: d.meta || {},
        source: d.source || '',
        target: d.target || 'production',
        ready: d.readyState || '',
        errorMessage: d.errorMessage || '',
        alias: (d.alias || []).filter(a => a),
        inspectorUrl: d.inspectorUrl || '',
        createdAt: d.createdAt || ''
      }));
      result.latestDeployment = result.deployments[0] || null;
    } catch (e) {
      result.deploymentsError = e.message;
    }

    // 4. 获取环境变量（不返回值，只显示 key）
    try {
      const envData = await getEnvVars(projectId, token);
      result.envVars = (envData.envs || []).map(e => ({
        key: e.key,
        type: e.type,
        target: e.target,
        id: e.id
      }));
    } catch (e) {
      result.envVarsError = e.message;
    }

    // 5. 获取域名
    try {
      result.domains = await getDomains(projectId, token);
    } catch (e) {
      result.domainsError = e.message;
    }
  }

  return result;
}

module.exports = {
  vercelRequest,
  getProject,
  getDeployments,
  getDeployment,
  getBuildLogs,
  getEnvVars,
  getUser,
  getDomains,
  redeploy,
  getProjectStatus
};
