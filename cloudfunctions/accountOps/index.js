const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const crypto = require('crypto');
const CLOUD_VERSION = '2026.06.21.3';

/**
 * 账号操作云函数
 * - register：用户名 + 密码注册
 * - login：用户名 + 密码登录
 * - checkUsername：检查用户名是否可用
 */
exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) {
    return { success: false, error: '未登录' };
  }

  const { action } = event;

  /**
   * 确保集合存在
   */
  async function ensureCollection(name) {
    try {
      await db.createCollection(name);
    } catch (e) {
      if (!isCollectionAlreadyExists(e)) throw e;
    }
  }

  function isCollectionAlreadyExists(e) {
    const msg = String(e.message || e.errMsg || '');
    return /-501001|already exists|collection exists/i.test(msg);
  }

  /**
   * 通过 openid 查找用户
   */
  async function getUserByOpenid(openid) {
    const { data } = await db.collection('users').where({ openid }).limit(1).get();
    return data && data.length ? data[0] : null;
  }

  /**
   * 通过 username 查找用户
   */
  async function getUserByUsername(username) {
    const { data } = await db.collection('users').where({ username }).limit(1).get();
    return data && data.length ? data[0] : null;
  }

  /**
   * 通过 publicId 查找用户
   */
  async function getUserByPublicId(publicId) {
    const { data } = await db.collection('users').where({ publicId }).limit(1).get();
    return data && data.length ? data[0] : null;
  }

  /**
   * 生成唯一 6 位数字 ID
   */
  async function createUniquePublicId() {
    for (let i = 0; i < 12; i++) {
      const id = String(Math.floor(100000 + Math.random() * 900000));
      const { data } = await db.collection('users').where({ publicId: id }).limit(1).get();
      if (!data || !data.length) return id;
    }
    throw new Error('ID 生成失败，请重试');
  }

  /**
   * 密码哈希
   */
  function hashPassword(username, password) {
    return crypto.createHash('sha256').update(username + ':' + password).digest('hex');
  }

  /**
   * 校验用户名格式
   */
  function validateUsername(username) {
    if (!username || typeof username !== 'string') return '请输入用户名';
    const trimmed = username.trim();
    if (trimmed.length < 3) return '用户名至少 3 位';
    if (trimmed.length > 20) return '用户名最多 20 位';
    if (!/^[a-zA-Z0-9_一-龥]+$/.test(trimmed)) return '用户名只能包含字母、数字、下划线和中文';
    return null;
  }

  /**
   * 校验密码格式
   */
  function validatePassword(password) {
    if (!password || typeof password !== 'string') return '请输入密码';
    if (password.length < 6) return '密码至少 6 位';
    if (password.length > 30) return '密码最多 30 位';
    return null;
  }

  function normalizeDeviceInfo(value = {}) {
    return {
      name: String(value.name || value.model || '未知设备').slice(0, 60),
      model: String(value.model || '').slice(0, 60),
      platform: String(value.platform || '').slice(0, 30),
      system: String(value.system || '').slice(0, 60),
      appVersion: String(value.appVersion || '').slice(0, 30)
    };
  }

  async function issueSession(ownerOpenid, deviceInfo = {}) {
    await ensureCollection('account_sessions');
    const token = crypto.randomBytes(32).toString('hex');
    const now = new Date().toISOString();
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const session = {
      token,
      ownerOpenid,
      wxOpenid: OPENID,
      device: normalizeDeviceInfo(deviceInfo),
      createdAt: now,
      lastActiveAt: now,
      expiresAt
    };
    await db.collection('account_sessions').add({ data: session });
    const user = await getUserByOpenid(ownerOpenid);
    if (user) await db.collection('users').doc(user._id).update({ data: { sessionToken: token, sessionExpiresAt: expiresAt } });
    return { sessionToken: token, sessionExpiresAt: expiresAt };
  }

  async function resolveSession(token) {
    if (!token) return null;
    await ensureCollection('account_sessions');
    const { data: sessions } = await db.collection('account_sessions').where({ token }).limit(1).get();
    if (sessions && sessions.length) {
      const session = sessions[0];
      if (!session.expiresAt || session.expiresAt > Date.now()) return session;
      await db.collection('account_sessions').doc(session._id).remove().catch(() => {});
      return null;
    }
    const { data: users } = await db.collection('users').where({ sessionToken: token }).limit(1).get();
    if (!users || !users.length) return null;
    const user = users[0];
    if (user.sessionExpiresAt && user.sessionExpiresAt < Date.now()) return null;
    return { _id: '', token, ownerOpenid: user.openid, createdAt: user.updatedAt || '', lastActiveAt: user.updatedAt || '', expiresAt: user.sessionExpiresAt || 0, device: { name: '旧版登录设备' } };
  }

  switch (action) {
    case 'healthCheck':
      return { success: true, functionName: 'accountOps', version: CLOUD_VERSION };

    case 'register': {
      const username = (event.username || '').trim();
      const password = event.password || '';

      const userErr = validateUsername(username);
      if (userErr) return { success: false, error: userErr };

      const passErr = validatePassword(password);
      if (passErr) return { success: false, error: passErr };

      try {
        await ensureCollection('users');

        // 查重用户名
        const existingUsername = await getUserByUsername(username);
        if (existingUsername) return { success: false, error: '用户名已被占用' };

        const publicId = await createUniquePublicId();
        const passwordHash = hashPassword(username, password);
        const now = new Date().toISOString();

        const userData = {
          username,
          passwordHash,
          publicId,
          accountType: 'password',
          updatedAt: now
        };

        // 已有微信记录 → 升级；否则 → 新建
        const existingUser = await getUserByOpenid(OPENID);
        if (existingUser) {
          // 已经是密码账号 → 不允许重复注册
          if (existingUser.accountType === 'password' && existingUser.username) {
            return { success: false, error: '该微信已绑定账号 ' + existingUser.username };
          }
          // 微信用户升级为账号密码用户
          await db.collection('users').doc(existingUser._id).update({ data: userData });
        } else {
          await db.collection('users').add({
            data: {
              openid: OPENID,
              uid: OPENID,
              nickName: '',
              avatarUrl: '',
              createdAt: now,
              ...userData
            }
          });
        }

        // 取更新后的用户信息
        const saved = await getUserByOpenid(OPENID);

        // 注册后自动签发 session token，立即可用
        const { sessionToken, sessionExpiresAt } = await issueSession(OPENID, event.deviceInfo || {});

        return {
          success: true,
          sessionToken,
          sessionExpiresAt,
          user: {
            openid: OPENID,
            publicId,
            username,
            nickName: (saved && saved.nickName) || '',
            avatarUrl: (saved && saved.avatarUrl) || ''
          }
        };
      } catch (e) {
        console.error('register error:', e);
        const detail = e.message || e.errMsg || JSON.stringify(e);
        return { success: false, error: '注册失败：' + detail };
      }
    }

    case 'login': {
      const publicId = (event.publicId || '').trim();
      const password = event.password || '';

      if (!publicId) return { success: false, error: '请输入ID' };
      if (!password) return { success: false, error: '请输入密码' };

      try {
        await ensureCollection('users');

        const user = await getUserByPublicId(publicId);
        if (!user) return { success: false, error: '账号不存在，请检查ID' };

        // 哈希时使用用户名作为盐，需从查到的用户记录中取
        const passwordHash = hashPassword(user.username || '', password);
        if (user.passwordHash !== passwordHash) {
          return { success: false, error: '密码错误' };
        }

        // 生成 session token，支持多设备登录
        const { sessionToken, sessionExpiresAt } = await issueSession(user.openid, event.deviceInfo || {});
        await db.collection('users').doc(user._id).update({ data: { updatedAt: new Date().toISOString() } });

        return {
          success: true,
          sessionToken,
          sessionExpiresAt,
          user: {
            openid: user.openid,
            publicId: user.publicId || '',
            username: user.username || '',
            nickName: user.nickName || '',
            avatarUrl: user.avatarUrl || ''
          }
        };
      } catch (e) {
        console.error('login error:', e);
        return { success: false, error: '登录失败，请稍后重试' };
      }
    }

    case 'checkUsername': {
      const username = (event.username || '').trim();
      if (!username) return { success: false, error: '请输入用户名' };

      try {
        await ensureCollection('users');
        const existing = await getUserByUsername(username);
        return { success: true, available: !existing };
      } catch (e) {
        console.error('checkUsername error:', e);
        return { success: false, error: '检查失败' };
      }
    }

    // ══════ 验证身份（忘记密码：ID + 用户名） ══════
    case 'verifyIdentity': {
      const publicId = (event.publicId || '').trim();
      const username = (event.username || '').trim();
      if (!publicId) return { success: false, error: '请输入ID' };
      if (!username) return { success: false, error: '请输入用户名' };

      try {
        await ensureCollection('users');
        const user = await getUserByPublicId(publicId);
        if (!user) return { success: false, error: '账号不存在' };
        if (!user.username || user.username !== username) {
          return { success: false, error: '用户名不匹配，无法验证身份' };
        }

        return { success: true, username: user.username, publicId: user.publicId };
      } catch (e) {
        console.error('verifyIdentity error:', e);
        return { success: false, error: '验证失败，请稍后重试' };
      }
    }

    // ══════ 重置密码（忘记密码：ID + 用户名） ══════
    case 'resetPassword': {
      const publicId = (event.publicId || '').trim();
      const username = (event.username || '').trim();
      const newPassword = event.newPassword || '';

      if (!publicId) return { success: false, error: '请输入ID' };
      if (!username) return { success: false, error: '请输入用户名' };

      const passErr = validatePassword(newPassword);
      if (passErr) return { success: false, error: passErr };

      try {
        await ensureCollection('users');
        const user = await getUserByPublicId(publicId);
        if (!user) return { success: false, error: '账号不存在' };
        if (!user.username || user.username !== username) {
          return { success: false, error: '用户名不匹配，无法重置密码' };
        }

        const passwordHash = hashPassword(user.username, newPassword);
        await db.collection('users').doc(user._id).update({
          data: {
            passwordHash,
            updatedAt: new Date().toISOString(),
            sessionToken: db.command.remove(),
            sessionExpiresAt: db.command.remove()
          }
        });

        await ensureCollection('account_sessions');
        const { data: sessions } = await db.collection('account_sessions').where({ ownerOpenid: user.openid }).limit(50).get();
        await Promise.all((sessions || []).map(session => db.collection('account_sessions').doc(session._id).remove()));

        return { success: true };
      } catch (e) {
        console.error('resetPassword error:', e);
        return { success: false, error: '重置失败，请稍后重试' };
      }
    }

    // ══════ 修改密码 ══════
    case 'changePassword': {
      const oldPassword = event.oldPassword || '';
      const newPassword = event.newPassword || '';

      if (!oldPassword) return { success: false, error: '请输入旧密码' };

      const passErr = validatePassword(newPassword);
      if (passErr) return { success: false, error: passErr };

      try {
        await ensureCollection('users');
        // 通过 session token 解析身份，支持多设备修改密码
        let effectiveOpenid = OPENID;
        if (event._sessionToken) {
          const session = await resolveSession(event._sessionToken);
          if (session) effectiveOpenid = session.ownerOpenid;
        }
        const user = await getUserByOpenid(effectiveOpenid);
        if (!user) return { success: false, error: '用户不存在' };
        if (user.accountType !== 'password' || !user.username) {
          return { success: false, error: '仅账号密码用户可修改密码' };
        }

        const oldHash = hashPassword(user.username, oldPassword);
        if (user.passwordHash !== oldHash) return { success: false, error: '旧密码错误' };

        if (oldPassword === newPassword) return { success: false, error: '新密码不能与旧密码相同' };

        const passwordHash = hashPassword(user.username, newPassword);
        await db.collection('users').doc(user._id).update({
          data: { passwordHash, updatedAt: new Date().toISOString() }
        });

        await ensureCollection('account_sessions');
        const { data: sessions } = await db.collection('account_sessions').where({ ownerOpenid: user.openid }).limit(50).get();
        const currentToken = event._sessionToken || '';
        await Promise.all((sessions || []).filter(session => session.token !== currentToken).map(session => db.collection('account_sessions').doc(session._id).remove()));

        return { success: true };
      } catch (e) {
        console.error('changePassword error:', e);
        return { success: false, error: '修改失败，请稍后重试' };
      }
    }

    // ══════ 验证会话（App 重启时恢复登录态） ══════
    case 'validateSession': {
      const token = event._sessionToken || '';
      if (!token) return { success: false, error: '缺少会话令牌' };

      try {
        await ensureCollection('users');
        const session = await resolveSession(token);
        if (!session) return { success: false, error: '会话无效或已过期，请重新登录' };
        if (session._id) await db.collection('account_sessions').doc(session._id).update({ data: { lastActiveAt: new Date().toISOString() } });
        const u = await getUserByOpenid(session.ownerOpenid);
        if (!u) return { success: false, error: '账号不存在' };
        return {
          success: true,
          user: {
            openid: u.openid,
            publicId: u.publicId || '',
            username: u.username || '',
            nickName: u.nickName || '',
            avatarUrl: u.avatarUrl || ''
          }
        };
      } catch (e) {
        console.error('validateSession error:', e);
        return { success: false, error: '会话验证失败' };
      }
    }

    // ══════ 注销会话 ══════
    case 'logout': {
      const token = event._sessionToken || '';
      if (token) {
        try {
          await ensureCollection('account_sessions');
          const { data: sessions } = await db.collection('account_sessions').where({ token }).limit(1).get();
          if (sessions && sessions.length) await db.collection('account_sessions').doc(sessions[0]._id).remove();
          const { data } = await db.collection('users').where({ sessionToken: token }).limit(1).get();
          if (data && data.length) {
            await db.collection('users').doc(data[0]._id).update({
              data: { sessionToken: db.command.remove(), sessionExpiresAt: db.command.remove() }
            });
          }
        } catch (_) { /* best effort */ }
      }
      return { success: true };
    }

    case 'listSessions': {
      const token = event._sessionToken || '';
      try {
        const current = await resolveSession(token);
        if (!current) return { success: false, error: '会话已失效，请重新登录' };
        const { data } = await db.collection('account_sessions').where({ ownerOpenid: current.ownerOpenid }).limit(50).get();
        const sessions = (data || [])
          .filter(item => !item.expiresAt || item.expiresAt > Date.now())
          .sort((a, b) => String(b.lastActiveAt || '').localeCompare(String(a.lastActiveAt || '')))
          .map(item => ({
            _id: item._id,
            device: item.device || { name: '未知设备' },
            createdAt: item.createdAt || '',
            lastActiveAt: item.lastActiveAt || '',
            expiresAt: item.expiresAt || 0,
            current: item.token === token
          }));
        if (!sessions.some(item => item.current)) {
          sessions.unshift({
            _id: '',
            device: current.device || { name: '当前设备' },
            createdAt: current.createdAt || '',
            lastActiveAt: current.lastActiveAt || '',
            expiresAt: current.expiresAt || 0,
            current: true,
            legacy: true
          });
        }
        return { success: true, sessions };
      } catch (error) {
        return { success: false, error: error.message || '登录设备加载失败' };
      }
    }

    case 'revokeSession': {
      const token = event._sessionToken || '';
      const sessionId = String(event.sessionId || '');
      try {
        const current = await resolveSession(token);
        if (!current) return { success: false, error: '会话已失效，请重新登录' };
        const { data: target } = await db.collection('account_sessions').doc(sessionId).get();
        if (!target || target.ownerOpenid !== current.ownerOpenid) return { success: false, error: '登录设备不存在' };
        if (target.token === token) return { success: false, error: '不能在这里退出当前设备' };
        await db.collection('account_sessions').doc(sessionId).remove();
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message || '退出设备失败' };
      }
    }

    case 'revokeOtherSessions': {
      const token = event._sessionToken || '';
      try {
        const current = await resolveSession(token);
        if (!current) return { success: false, error: '会话已失效，请重新登录' };
        const { data } = await db.collection('account_sessions').where({ ownerOpenid: current.ownerOpenid }).limit(50).get();
        const others = (data || []).filter(item => item.token !== token);
        await Promise.all(others.map(item => db.collection('account_sessions').doc(item._id).remove()));
        return { success: true, revoked: others.length };
      } catch (error) {
        return { success: false, error: error.message || '退出其他设备失败' };
      }
    }

    // ⚠️ 一键清空所有数据（需确认码）
    case 'nukeAll': {
      const confirmKey = event.confirmKey || '';
      if (confirmKey !== 'YES_DELETE_ALL_DATA') {
        return { success: false, error: '请提供确认码 confirmKey: "YES_DELETE_ALL_DATA"' };
      }

      const collections = [
        'users', 'trips', 'trip_members', 'moments',
        'follows', 'friend_requests', 'private_messages',
        'group_chats', 'group_members', 'group_messages'
      ];

      const results = {};
      for (const name of collections) {
        try {
          const { data } = await db.collection(name).limit(100).get();
          results[name] = data.length;
        } catch (_) {
          results[name] = 'skipped';
        }
      }

      // 实际删除：逐集合逐条删除（云开发不支持 dropCollection）
      for (const name of collections) {
        try {
          let deleted = 0;
          while (true) {
            const { data } = await db.collection(name).limit(100).get();
            if (!data.length) break;
            const ids = data.map(d => d._id);
            await Promise.all(ids.map(_id => db.collection(name).doc(_id).remove()));
            deleted += ids.length;
          }
          results[name + '_deleted'] = deleted;
        } catch (e) {
          results[name + '_error'] = (e && (e.message || e.errMsg || String(e))) || 'unknown';
        }
      }

      return { success: true, results };
    }

    default:
      return { success: false, error: `未知操作: ${action}` };
  }
};
