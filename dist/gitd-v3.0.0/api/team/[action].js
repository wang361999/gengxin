const { sendJson, readBody } = require('../../lib/helpers');
const { requireAuth, initSecret } = require('../../lib/auth');
const {
  getUserPlan, getUserTeams, createTeam, getTeam, getTeamMembers,
  getTeamMemberRole, addTeamMember, removeTeamMember, updateMemberRole,
  deleteTeam, shareRepoToTeam, unshareRepoFromTeam, getTeamRepos,
  getTeamHistory, findUserByUsername, listRepos, getRepo, addNotification
} = require('../../lib/db');

// 检查企业版权限
async function checkEnterprise(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return null;
  const plan = await getUserPlan(user.userId);
  if (plan.id !== 'enterprise') {
    sendJson(res, 403, {
      error: '团队协作是企业版功能，请升级到企业版后使用',
      needUpgrade: true,
      plan
    });
    return null;
  }
  return user;
}

module.exports = async (req, res) => {
  await initSecret();
  const segments = (req.url || '').split('?')[0].split('/').filter(Boolean);
  const action = segments[segments.length - 1];

  try {
    // ===== 获取用户的团队列表 =====
    if (action === 'list') {
      const user = await checkEnterprise(req, res);
      if (!user) return;
      const teams = await getUserTeams(user.userId);
      return sendJson(res, 200, { ok: true, teams });
    }

    // ===== 创建团队 =====
    if (action === 'create') {
      const user = await checkEnterprise(req, res);
      if (!user) return;
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      const description = String(body.description || '').trim();
      if (!name) return sendJson(res, 400, { error: '团队名称必填' });
      if (name.length > 50) return sendJson(res, 400, { error: '团队名称不能超过50个字符' });

      const team = await createTeam(user.userId, name, description);
      return sendJson(res, 200, { ok: true, message: '团队创建成功', team });
    }

    // ===== 获取团队详情（含成员和共享仓库） =====
    if (action === 'detail') {
      const user = await checkEnterprise(req, res);
      if (!user) return;
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      const body = await readBody(req);
      if (!body.teamId) return sendJson(res, 400, { error: '缺少 teamId' });

      const team = await getTeam(body.teamId);
      if (!team) return sendJson(res, 404, { error: '团队不存在' });

      const role = await getTeamMemberRole(body.teamId, user.userId);
      if (!role) return sendJson(res, 403, { error: '你不是该团队成员' });

      const members = await getTeamMembers(body.teamId);
      const repos = await getTeamRepos(body.teamId);
      const history = await getTeamHistory(body.teamId, 30);

      return sendJson(res, 200, {
        ok: true,
        team,
        members,
        repos,
        history,
        myRole: role,
        isAdmin: role === 'admin'
      });
    }

    // ===== 邀请成员 =====
    if (action === 'invite') {
      const user = await checkEnterprise(req, res);
      if (!user) return;
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      const body = await readBody(req);
      if (!body.teamId) return sendJson(res, 400, { error: '缺少 teamId' });
      const username = String(body.username || '').trim().toLowerCase();
      if (!username) return sendJson(res, 400, { error: '请输入用户名' });

      // 检查权限
      const role = await getTeamMemberRole(body.teamId, user.userId);
      if (!role || role !== 'admin') return sendJson(res, 403, { error: '只有团队管理员才能邀请成员' });

      // 查找用户
      const targetUser = await findUserByUsername(username);
      if (!targetUser) return sendJson(res, 404, { error: `用户 "${username}" 不存在` });
      if (targetUser.status !== 'active') return sendJson(res, 400, { error: '该用户已被禁用' });

      const result = await addTeamMember(body.teamId, targetUser.id, body.role || 'member');

      // 给被邀请的用户发通知
      await addNotification(targetUser.id, 'info', '加入团队通知',
        `你已被 ${user.username || '管理员'} 邀请加入团队。`);

      return sendJson(res, 200, {
        ok: true,
        message: `已邀请 ${username} 加入团队`,
        reactivated: result.reactivated
      });
    }

    // ===== 移除成员 =====
    if (action === 'remove-member') {
      const user = await checkEnterprise(req, res);
      if (!user) return;
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      const body = await readBody(req);
      if (!body.teamId || !body.userId) return sendJson(res, 400, { error: '缺少参数' });

      const role = await getTeamMemberRole(body.teamId, user.userId);
      if (!role || role !== 'admin') return sendJson(res, 403, { error: '只有团队管理员才能移除成员' });

      const team = await getTeam(body.teamId);
      if (team && team.ownerId === body.userId) return sendJson(res, 400, { error: '不能移除团队创建者' });

      await removeTeamMember(body.teamId, body.userId);
      return sendJson(res, 200, { ok: true, message: '成员已移除' });
    }

    // ===== 更新成员角色 =====
    if (action === 'update-role') {
      const user = await checkEnterprise(req, res);
      if (!user) return;
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      const body = await readBody(req);
      if (!body.teamId || !body.userId || !body.role) return sendJson(res, 400, { error: '缺少参数' });
      if (body.role !== 'admin' && body.role !== 'member') return sendJson(res, 400, { error: '角色只能是 admin 或 member' });

      const myRole = await getTeamMemberRole(body.teamId, user.userId);
      if (!myRole || myRole !== 'admin') return sendJson(res, 403, { error: '只有团队管理员才能修改角色' });

      await updateMemberRole(body.teamId, body.userId, body.role);
      return sendJson(res, 200, { ok: true, message: '角色已更新' });
    }

    // ===== 删除团队 =====
    if (action === 'delete') {
      const user = await checkEnterprise(req, res);
      if (!user) return;
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      const body = await readBody(req);
      if (!body.teamId) return sendJson(res, 400, { error: '缺少 teamId' });

      const team = await getTeam(body.teamId);
      if (!team) return sendJson(res, 404, { error: '团队不存在' });
      if (team.ownerId !== user.userId) return sendJson(res, 403, { error: '只有团队创建者才能删除团队' });

      await deleteTeam(body.teamId);
      return sendJson(res, 200, { ok: true, message: '团队已删除' });
    }

    // ===== 共享仓库到团队 =====
    if (action === 'share-repo') {
      const user = await checkEnterprise(req, res);
      if (!user) return;
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      const body = await readBody(req);
      if (!body.teamId || !body.repoId) return sendJson(res, 400, { error: '缺少参数' });

      const role = await getTeamMemberRole(body.teamId, user.userId);
      if (!role) return sendJson(res, 403, { error: '你不是该团队成员' });

      // 验证仓库属于当前用户
      const repo = await getRepo(user.userId, body.repoId);
      if (!repo) return sendJson(res, 404, { error: '仓库不存在或不属于你' });

      await shareRepoToTeam(body.teamId, body.repoId, user.userId);
      return sendJson(res, 200, { ok: true, message: '仓库已共享到团队' });
    }

    // ===== 取消共享仓库 =====
    if (action === 'unshare-repo') {
      const user = await checkEnterprise(req, res);
      if (!user) return;
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      const body = await readBody(req);
      if (!body.teamId || !body.repoId) return sendJson(res, 400, { error: '缺少参数' });

      const role = await getTeamMemberRole(body.teamId, user.userId);
      if (!role || role !== 'admin') return sendJson(res, 403, { error: '只有管理员才能取消共享' });

      await unshareRepoFromTeam(body.teamId, body.repoId);
      return sendJson(res, 200, { ok: true, message: '已取消共享' });
    }

    // ===== 获取用户仓库列表（用于共享选择） =====
    if (action === 'my-repos') {
      const user = await checkEnterprise(req, res);
      if (!user) return;
      const repos = await listRepos(user.userId);
      return sendJson(res, 200, {
        ok: true,
        repos: repos.map(r => ({ id: r.id, name: r.name, repo: r.repo, branch: r.branch }))
      });
    }

    return sendJson(res, 404, { error: '未知操作: ' + action });
  } catch (err) {
    return sendJson(res, 500, { error: err.message || '服务器错误' });
  }
};
