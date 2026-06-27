/**
 * 身份解析 — 通过 session token 解析出账号绑定的 openid
 * 用于 dbOps / momentOps 等云函数在服务端统一身份识别
 *
 * @param {object} db      - 云数据库实例
 * @param {string} wxOpenid - WXContext 的 OPENID（兜底）
 * @param {string} sessionToken - 客户端传来的 _sessionToken
 * @param {object} [options]
 * @param {function} [options.ensureCollection] - 可选：查询前确保集合存在
 * @returns {Promise<string>} 解析后的 effective openid
 */
async function resolveOpenid(db, wxOpenid, sessionToken, options = {}) {
  if (!sessionToken) return wxOpenid;

  try {
    if (typeof options.ensureCollection === 'function') {
      await options.ensureCollection();
    }
    let accountSessions = [];
    try {
      const result = await db.collection('account_sessions').where({ token: sessionToken }).limit(1).get();
      accountSessions = result.data || [];
    } catch (_) {}

    if (accountSessions && accountSessions.length) {
      const session = accountSessions[0];
      if (!session.expiresAt || session.expiresAt > Date.now()) return session.ownerOpenid || wxOpenid;
    }

    const { data: sessions } = await db.collection('users').where({ sessionToken })
      .limit(1).get();

    if (sessions && sessions.length) {
      const sessionUser = sessions[0];
      if (!sessionUser.sessionExpiresAt || sessionUser.sessionExpiresAt > Date.now()) {
        return sessionUser.openid; // 使用账号绑定的 openid
      }
    }
  } catch (_) {
    // collection not ready 等异常，退回 WXContext openid
  }

  return wxOpenid;
}

module.exports = resolveOpenid;
