const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

function newPublicId() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function isSixDigitPublicId(value) {
  return /^\d{6}$/.test(String(value || ''));
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) {
    return { success: false, error: '无法获取用户标识' };
  }

  // --- Session 恢复：如果携带有效 token，直接返回账号信息，不创建设备主人记录 ---
  const _sessionToken = event._sessionToken || '';
  if (_sessionToken) {
    try {
      await ensureCollection('users');
      const { data: sessions } = await db.collection('users').where({ sessionToken: _sessionToken }).limit(1).get();
      if (sessions && sessions.length) {
        const u = sessions[0];
        if (u.sessionExpiresAt && u.sessionExpiresAt > Date.now()) {
          const publicId = isSixDigitPublicId(u.publicId) ? String(u.publicId) : await createUniquePublicId();
          return {
            success: true,
            openid: u.openid,
            publicId,
            nickName: u.nickName || '',
            avatarUrl: u.avatarUrl || '',
            username: u.username || ''
          };
        }
      }
    } catch (_) { /* 验证失败，走正常微信登录 */ }
  }
  // --- Session 恢复结束 ---

  function isCollectionNotReady(e) {
    const msg = (e && (e.message || e.errMsg || String(e))) || '';
    return msg.includes('DATABASE_COLLECTION_NOT_EXIST') ||
      msg.includes('collection not exists') ||
      msg.includes('Db or Table not exist') ||
      msg.includes('database request fail') ||
      msg.includes('-502001') ||
      msg.includes('-502005');
  }

  function isCollectionAlreadyExists(e) {
    const msg = (e && (e.message || e.errMsg || String(e))) || '';
    return msg.includes('already exists') ||
      msg.includes('collection exists') ||
      msg.includes('Table exist') ||
      msg.includes('ResourceExist') ||
      msg.includes('DATABASE_COLLECTION_ALREADY_EXIST') ||
      msg.includes('-501001');
  }

  async function ensureCollection(collectionName) {
    try {
      await db.createCollection(collectionName);
    } catch (e) {
      if (!isCollectionAlreadyExists(e)) {
        const msg = (e && (e.message || e.errMsg || String(e))) || '';
        console.warn(`ensureCollection ${collectionName} failed:`, msg);
        throw e;
      }
    }
  }

  async function getUserByIdentity(openid) {
    const openidRes = await db.collection('users').where({ openid }).limit(1).get();
    if (openidRes.data && openidRes.data.length > 0) return openidRes.data[0];
    const uidRes = await db.collection('users').where({ uid: openid }).limit(1).get();
    return uidRes.data && uidRes.data.length > 0 ? uidRes.data[0] : null;
  }

  async function createUniquePublicId() {
    for (let i = 0; i < 12; i++) {
      const candidate = newPublicId();
      const { data } = await db.collection('users').where({ publicId: candidate }).limit(1).get();
      if (!data.length) return candidate;
    }
    throw new Error('生成 ID 失败，请重试');
  }

  // 同步写入 users 表（不存在则创建）并返回用户信息
  let nickName = '';
  let avatarUrl = '';
  let username = '';
  let publicId = '';
  try {
    await ensureCollection('users');
    const user = await getUserByIdentity(OPENID);
    if (!user) {
      publicId = await createUniquePublicId();
      await db.collection('users').add({
        data: {
          uid: OPENID,
          openid: OPENID,
          publicId,
          nickName: '',
          avatarUrl: '',
          updatedAt: new Date().toISOString()
        }
      });
    } else {
      publicId = isSixDigitPublicId(user.publicId)
        ? String(user.publicId)
        : await createUniquePublicId();
      await db.collection('users').doc(user._id).update({
        data: { uid: OPENID, openid: OPENID, publicId, updatedAt: new Date().toISOString() }
      });
      nickName = user.nickName || '';
      avatarUrl = user.avatarUrl || '';
      username = user.username || '';
    }
  } catch (e) {
    console.warn('users 集合操作失败:', e.message);
    if (!isCollectionNotReady(e)) {
      return { success: false, error: e.message || '用户资料初始化失败' };
    }
  }

  return { success: true, openid: OPENID, publicId, nickName, avatarUrl, username };
};
