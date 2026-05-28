/**
 * 云开发数据库 + 存储工具
 * 根据 app.js 启动检测结果，自动选择云存储或本地存储
 */
const localDb = require('./db');

const cloudDb = wx.cloud.database();
const _ = cloudDb.command;

function isCloudReady() {
  const app = getApp();
  return app && app.globalData && app.globalData.cloudReady === true;
}

// 对外暴露的 db
const db = {
  get command() { return cloudDb.command; },
  collection(name) {
    if (isCloudReady()) return cloudDb.collection(name);
    return localDb.collection(name);
  }
};

/**
 * 获取用户 openid（带缓存，自行调云函数确保拿到真实值）
 */
let _openid = '';
let _openidPromise = null;

async function getOpenid() {
  if (_openid) return _openid;

  // 防止并发重复调用
  if (_openidPromise) return _openidPromise;

  _openidPromise = (async () => {
    if (isCloudReady()) {
      try {
        const timeout = new Promise(resolve => setTimeout(() => resolve(null), 8000));
        const res = await Promise.race([wx.cloud.callFunction({ name: 'getOpenid' }), timeout]);
        if (res && res.result && res.result.openid) {
          _openid = res.result.openid;
          getApp().globalData.openid = _openid;
          return _openid;
        }
      } catch (e) {
        console.warn('获取 openid 失败，使用本地模式:', e);
      }
    }
    _openid = 'local_user';
    return _openid;
  })();

  return _openidPromise;
}

/**
 * 生成 6 位邀请码
 */
function genInviteCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

/**
 * 上传图片到云存储
 */
async function uploadImage(filePath, prefix = 'images') {
  return uploadFile(filePath, 'jpg', prefix);
}

/**
 * 上传文件到云存储
 */
async function uploadFile(filePath, ext = 'mp3', prefix = 'files') {
  if (!isCloudReady()) return filePath;
  try {
    const cloudPath = `${prefix}/${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
    const res = await wx.cloud.uploadFile({ cloudPath, filePath });
    return res.fileID;
  } catch (e) {
    console.warn('上传失败，使用本地路径:', e);
    return filePath;
  }
}

/**
 * 计算日期差（天数）
 */
function daysBetween(start, end) {
  const s = new Date(start);
  const e = new Date(end);
  return Math.ceil((e - s) / (1000 * 60 * 60 * 24)) + 1;
}

/**
 * 生成日期范围数组
 */
function dateRange(start, end) {
  const days = [];
  const s = new Date(start);
  const e = new Date(end);
  const cur = new Date(s);
  while (cur <= e) {
    days.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

/**
 * 格式化时间（简略）
 */
function formatDate(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return m + '/' + day + ' ' + d.toTimeString().slice(0, 5);
}

const CATEGORY_ICONS = {
  transport: '✈️',
  hotel: '🏡',
  food: '🍣',
  tickets: '🎪',
  shopping: '🛒',
  other: '💫'
};

function categoryIcon(cat) {
  return CATEGORY_ICONS[cat] || '💰';
}

/**
 * doc().get() 兼容：
 * 云开发返回 {data: {...}}，本地存储返回 {data: [{...}]}
 */
function getDoc(result) {
  const data = result.data;
  if (!data) return null;
  return Array.isArray(data) ? data[0] : data;
}

/**
 * ══════ 用户关注系统 ══════
 */

function usersColl() {
  return db.collection('users');
}

function followsColl() {
  return db.collection('follows');
}

async function upsertUser(openid, nickName, avatarUrl) {
  if (!openid) return;
  try {
    const { data } = await usersColl().where({ openid }).get();
    if (data.length > 0) {
      await usersColl().doc(data[0]._id).update({
        data: { nickName, avatarUrl, updatedAt: new Date().toISOString() }
      });
    } else {
      await usersColl().add({
        data: { openid, nickName, avatarUrl, updatedAt: new Date().toISOString() }
      });
    }
  } catch (e) {
    console.warn('upsertUser failed:', e);
  }
}

async function getUserProfile(openid) {
  if (!openid) return null;
  try {
    const { data } = await usersColl().where({ openid }).get();
    return data.length > 0 ? data[0] : null;
  } catch (e) {
    console.warn('getUserProfile failed:', e);
    return null;
  }
}

async function getFollowStats(openid) {
  try {
    const [{ data: following }, { data: followers }] = await Promise.all([
      followsColl().where({ follower: openid }).get(),
      followsColl().where({ following: openid }).get()
    ]);
    return { following: following.length, followers: followers.length };
  } catch (e) {
    console.warn('getFollowStats failed:', e);
    return { following: 0, followers: 0 };
  }
}

async function isFollowing(follower, following) {
  try {
    const { data } = await followsColl().where({ follower, following }).get();
    return data.length > 0;
  } catch (e) {
    return false;
  }
}

async function toggleFollow(follower, following) {
  try {
    const { data } = await followsColl().where({ follower, following }).get();
    if (data.length > 0) {
      await followsColl().doc(data[0]._id).remove();
      return false; // unfollowed
    } else {
      await followsColl().add({
        data: { follower, following, createdAt: new Date().toISOString() }
      });
      return true; // followed
    }
  } catch (e) {
    console.warn('toggleFollow failed:', e);
    throw e;
  }
}

async function getFollowList(openid, type) {
  try {
    if (type === 'following') {
      const { data } = await followsColl().where({ follower: openid }).orderBy('createdAt', 'desc').limit(200).get();
      const userIds = data.map(d => d.following);
      return userIds;
    } else {
      const { data } = await followsColl().where({ following: openid }).orderBy('createdAt', 'desc').limit(200).get();
      const userIds = data.map(d => d.follower);
      return userIds;
    }
  } catch (e) {
    console.warn('getFollowList failed:', e);
    return [];
  }
}

async function batchGetUsers(openids) {
  if (!openids.length) return [];
  try {
    const _ = db.command;
    const { data } = await usersColl().where({ openid: _.in(openids) }).get();
    const map = {};
    data.forEach(u => { map[u.openid] = u; });
    return map;
  } catch (e) {
    console.warn('batchGetUsers failed:', e);
    return {};
  }
}

/**
 * 批量解析语音云文件ID为临时链接（替换原字段）
 */
async function resolveVoiceUrls(items, key) {
  const ids = [...new Set(items.map(i => i[key]).filter(Boolean))];
  if (ids.length === 0) return;
  try {
    const res = await wx.cloud.getTempFileURL({ fileList: ids });
    const map = {};
    res.fileList.forEach(item => {
      if (item.tempFileURL) map[item.fileID] = item.tempFileURL;
    });
    items.forEach(i => {
      if (i[key] && map[i[key]]) i[key] = map[i[key]];
    });
  } catch (e) {
    console.warn('resolveVoiceUrls failed:', e);
  }
}

/**
 * 批量解析动态评论中的语音链接
 */
async function resolveCommentVoices(moments) {
  const ids = [];
  moments.forEach(m => {
    (m.comments || []).forEach(c => {
      if (c.voice) ids.push(c.voice);
    });
  });
  if (ids.length === 0) return;
  try {
    const res = await wx.cloud.getTempFileURL({ fileList: ids });
    const map = {};
    res.fileList.forEach(item => {
      if (item.tempFileURL) map[item.fileID] = item.tempFileURL;
    });
    moments.forEach(m => {
      (m.comments || []).forEach(c => {
        if (c.voice && map[c.voice]) c.voice = map[c.voice];
      });
    });
  } catch (e) {
    console.warn('resolveCommentVoices failed:', e);
  }
}

module.exports = {
  db,
  collection: db.collection.bind(db),
  _,
  getOpenid,
  genInviteCode,
  uploadImage,
  uploadFile,
  daysBetween,
  dateRange,
  formatDate,
  categoryIcon,
  getDoc,
  upsertUser,
  getUserProfile,
  getFollowStats,
  isFollowing,
  toggleFollow,
  getFollowList,
  batchGetUsers,
  resolveVoiceUrls,
  resolveCommentVoices
};
