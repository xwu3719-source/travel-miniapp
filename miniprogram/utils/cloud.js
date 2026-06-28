/**
 * 云开发数据库 + 存储工具
 * 所有操作必须经过云开发，无本地回退
 */

const _ = wx.cloud.database().command;

const db = wx.cloud.database();

/**
 * 获取用户 openid（带缓存）
 * 优先使用账号登录存入的 openid，再走微信登录
 */
let _openid = '';
let _openidPromise = null;
let _accountUser = null; // 账号登录存入的用户信息
let _sessionToken = '';  // session token for multi-device login
const _memoryCache = Object.create(null);
const _inflightRequests = Object.create(null);
const _tempUrlCache = Object.create(null);
let _cacheEpoch = 0;

function cachedRequest(key, ttl, loader, force = false) {
  const now = Date.now();
  const cached = _memoryCache[key];
  if (!force && cached && now - cached.savedAt < ttl) {
    return Promise.resolve(cached.value);
  }
  if (_inflightRequests[key]) return _inflightRequests[key];
  const requestEpoch = _cacheEpoch;
  const request = Promise.resolve().then(loader).then(value => {
    if (requestEpoch === _cacheEpoch) {
      _memoryCache[key] = { value, savedAt: Date.now() };
    }
    return value;
  }).finally(() => {
    if (_inflightRequests[key] === request) delete _inflightRequests[key];
  });
  _inflightRequests[key] = request;
  return request;
}

function invalidateCache(...prefixes) {
  Object.keys(_memoryCache).forEach(key => {
    if (prefixes.some(prefix => key.startsWith(prefix))) delete _memoryCache[key];
  });
}

function clearMemoryCache() {
  _cacheEpoch += 1;
  Object.keys(_memoryCache).forEach(key => delete _memoryCache[key]);
  Object.keys(_inflightRequests).forEach(key => delete _inflightRequests[key]);
}

function setOpenid(openid) {
  if (_openid && openid && _openid !== openid) clearMemoryCache();
  _openid = openid;
  _openidPromise = null;
  if (openid) {
    wx.setStorageSync('_cachedAccountOpenid', openid);
  }
  const app = getApp();
  if (app && app.globalData) {
    app.globalData.openid = openid;
    app.globalData.loggedIn = true;
  }
}

// --- Session token 管理 ---
function setSessionToken(token) {
  _sessionToken = token;
  if (token) {
    wx.setStorageSync('_sessionToken', token);
  } else {
    wx.removeStorageSync('_sessionToken');
  }
  const app = getApp();
  if (app && app.globalData) {
    app.globalData.sessionToken = token;
  }
}

function getSessionToken() {
  if (_sessionToken) return _sessionToken;
  const stored = wx.getStorageSync('_sessionToken') || '';
  if (stored) {
    _sessionToken = stored;
    return stored;
  }
  const app = getApp();
  if (app && app.globalData && app.globalData.sessionToken) {
    _sessionToken = app.globalData.sessionToken;
    return _sessionToken;
  }
  return '';
}

function clearSessionToken() {
  _sessionToken = '';
  clearMemoryCache();
  wx.removeStorageSync('_sessionToken');
  const app = getApp();
  if (app && app.globalData) {
    app.globalData.sessionToken = '';
  }
}
// --- Session token 管理结束 ---

async function getOpenid() {
  // 已有真实 openid 直接返回
  if (_openid) return _openid;

  // 从持久存储恢复
  const stored = wx.getStorageSync('_cachedAccountOpenid');
  if (stored) {
    _openid = stored;
    return _openid;
  }

  // 从 globalData 读取
  const app = getApp();
  if (app && app.globalData && app.globalData.openid) {
    _openid = app.globalData.openid;
    return _openid;
  }

  // 防止并发重复调用
  if (_openidPromise) {
    try { return await _openidPromise; } catch (_) { /* 重试 */ }
  }

  _openidPromise = (async () => {
    const res = await wx.cloud.callFunction({ name: 'login' });
    if (res && res.result && res.result.openid) {
      _openid = res.result.openid;
      if (app && app.globalData) {
        app.globalData.openid = _openid;
        app.globalData.loggedIn = true;
      }
      _openidPromise = null;
      return _openid;
    }
    throw new Error('登录失败，请检查网络后重试');
  })();

  try {
    return await _openidPromise;
  } catch (e) {
    _openidPromise = null;
    throw e;
  }
}

/**
 * 上传文件到云存储
 */
async function uploadFile(filePath, ext = 'mp3', prefix = 'files') {
  const cloudPath = `${prefix}/${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
  const res = await wx.cloud.uploadFile({ cloudPath, filePath });
  return res.fileID;
}

async function downloadCloudFile(fileId) {
  if (!fileId || typeof fileId !== 'string') throw new Error('文件链接无效');
  if (fileId.startsWith('cloud://')) {
    const result = await wx.cloud.downloadFile({ fileID: fileId });
    if (!result || !result.tempFilePath) throw new Error('文件下载失败');
    return result.tempFilePath;
  }
  const result = await wx.downloadFile({ url: fileId });
  if (result.statusCode && result.statusCode !== 200) throw new Error('文件下载失败');
  if (!result.tempFilePath) throw new Error('文件下载失败');
  return result.tempFilePath;
}

/**
 * 上传图片到云存储
 */
async function uploadImage(filePath, prefix = 'images') {
  const cleanPath = String(filePath || '').split('?')[0];
  const matched = cleanPath.match(/\.([a-zA-Z0-9]+)$/);
  const rawExt = matched ? matched[1].toLowerCase() : 'jpg';
  const supportedExts = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'heic', 'heif'];
  const ext = supportedExts.includes(rawExt) ? rawExt : 'jpg';
  return uploadFile(filePath, ext, prefix);
}

async function createImageThumbnail(filePath, quality = 65) {
  return new Promise(resolve => {
    wx.compressImage({
      src: filePath,
      quality,
      compressedWidth: 720,
      success: result => resolve(result.tempFilePath || filePath),
      fail: () => resolve(filePath)
    });
  });
}

async function uploadImageWithThumbnail(filePath, prefix = 'images') {
  const thumbPath = await createImageThumbnail(filePath);
  const [original, thumbnail] = await Promise.all([
    uploadImage(filePath, prefix),
    uploadImage(thumbPath, `${prefix}-thumbs`)
  ]);
  return { original, thumbnail };
}

/**
 * 生成 6 位邀请码
 */
function genInviteCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
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
  const pad = n => String(n).padStart(2, '0');
  const time = pad(d.getHours()) + ':' + pad(d.getMinutes());
  // 今天：显示时间
  if (d.toDateString() === now.toDateString()) return time;
  // 昨天
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return '昨天 ' + time;
  // 今年
  if (d.getFullYear() === now.getFullYear()) {
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + time;
  }
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

const CATEGORY_ICONS = {
  transport: '/images/icons/category-transport.png',
  hotel: '/images/icons/category-hotel.png',
  food: '/images/icons/category-food.png',
  tickets: '/images/icons/category-tickets.png',
  shopping: '/images/icons/category-shopping.png',
  other: '/images/icons/category-other.png'
};

function categoryIcon(cat) {
  return CATEGORY_ICONS[cat] || CATEGORY_ICONS.other;
}

function userProfileUrl(openid, profile = {}) {
  if (!openid) return '';
  let url = `/pages/user-profile/user-profile?openid=${encodeURIComponent(openid)}`;
  if (profile.nickName) url += `&nickName=${encodeURIComponent(profile.nickName)}`;
  if (profile.avatarUrl) url += `&avatarUrl=${encodeURIComponent(profile.avatarUrl)}`;
  return url;
}

function navigateToUserProfile(openid, profile = {}) {
  const url = userProfileUrl(openid, profile);
  if (url) wx.navigateTo({ url });
}

/**
 * doc().get() 兼容
 */
function getDoc(result) {
  const data = result.data;
  if (!data) return null;
  return Array.isArray(data) ? data[0] : data;
}

/**
 * ══════ 用户关注系统 ══════
 * users 集合读写直接操作数据库（权限由云控制台安全规则控制）
 * follows 集合写操作走 dbOps 云函数做服务端校验
 */

function usersColl() {
  return db.collection('users');
}

function followsColl() {
  return db.collection('follows');
}

async function callDbOps(action, payload = {}) {
  const res = await wx.cloud.callFunction({
    name: 'dbOps',
    data: { action, payload, _sessionToken: getSessionToken() }
  });
  if (!res || !res.result) throw new Error('云函数调用失败');
  if (!res.result.success) throw new Error(res.result.error || '操作失败');
  return res.result;
}

async function upsertUser(openid, nickName, avatarUrl, signature, avatarThumbUrl = '') {
  if (!openid) return;
  try {
    const payload = {};
    if (typeof nickName === 'string' && nickName.trim()) payload.nickName = nickName.trim();
    if (typeof avatarUrl === 'string' && avatarUrl) payload.avatarUrl = avatarUrl;
    if (typeof avatarThumbUrl === 'string' && avatarThumbUrl) payload.avatarThumbUrl = avatarThumbUrl;
    if (typeof signature === 'string') payload.signature = signature.trim().slice(0, 60);
    if (Object.keys(payload).length === 0) return;
    // 通过云函数写入 users 集合（绕过客户端权限限制）
    const result = await callDbOps('upsertUser', payload);
    invalidateCache('profile:');
    return result;
  } catch (e) {
    console.warn('upsertUser failed:', e);
    throw e;
  }
}

async function updateUserSettings(settings) {
  const result = await callDbOps('updateUserSettings', settings || {});
  invalidateCache('profile:', 'socialPreferences');
  return result;
}

async function updateShowBadge(showBadge) {
  return updateUserSettings({ showBadge });
}

// ══════ 官方认证 ══════
// 把你的 6 位数字 ID 填在这里
const OFFICIAL_PUBLIC_IDS = new Set(['221116']);

function isOfficialByPublicId(publicId) {
  return publicId && OFFICIAL_PUBLIC_IDS.has(String(publicId));
}

// ══════ 徽章系统 ══════
const BADGE_DEFS = [
  { id: 'traveler',      icon: '旅行家.png',       name: '旅行家',     condition: '完成 5 次旅行',       check: d => d.totalTrips >= 5 },
  { id: 'city_explorer', icon: '城市探索家.png',   name: '城市探索家', condition: '探索 5 座城市',       check: d => d.uniqueCityCount >= 5 },
  { id: 'global_diplo',  icon: '环球外交家.png',   name: '环球外交家', condition: '探索 10 座城市',      check: d => d.uniqueCityCount >= 10 },
  { id: 'popular',       icon: '人气王.png',       name: '人气王',     condition: '获得 50 个赞',        check: d => d.interactionStats.totalLikes >= 50 },
  { id: 'chatter',       icon: '话唠.png',         name: '话唠',       condition: '发布 10 条动态',      check: d => d.interactionStats.momentCount >= 10 },
  { id: 'perfectionist', icon: '强迫症患者.png',   name: '强迫症患者', condition: '资料完整度 100%',     check: d => d.profileCompleteness >= 100 }
];

function getBadgeById(id) {
  return BADGE_DEFS.find(b => b.id === id) || null;
}

function getBadgeIcon(badgeId) {
  const badge = getBadgeById(badgeId);
  return badge ? badge.icon : '';
}

async function setWornBadge(badgeId) {
  return callDbOps('setWornBadge', { wornBadge: badgeId || '' });
}

// 将最新头像昵称同步到该用户的所有 trip_members 记录（通过云函数绕过权限）
async function syncProfileToTripMembers(openid, nickName, avatarUrl) {
  try {
    await callDbOps('syncProfile', { nickName, avatarUrl });
  } catch (e) {
    console.warn('syncProfileToTripMembers failed:', e);
  }
}

async function getUserProfile(openid) {
  if (!openid) return null;
  return cachedRequest(`profile:${openid}`, 30000, async () => {
   try {
    const result = await callDbOps('getUserProfile', { openid });
    const user = result.user || null;
    if (user) {
      user.rawAvatarUrl = user.avatarUrl || '';
      user.rawAvatarThumbUrl = user.avatarThumbUrl || '';
      await resolveUserAvatars([user]);
    }
    return user;
  } catch (e) {
    console.warn('getUserProfile failed:', e);
    return null;
   }
  });
}

async function getFollowStats(openid) {
  try {
    const result = await callDbOps('getFollowStats', { openid });
    return result.stats || { following: 0, followers: 0 };
  } catch (e) {
    console.warn('getFollowStats failed:', e);
    return { following: 0, followers: 0 };
  }
}

async function isFollowing(follower, following) {
  try {
    const result = await callDbOps('isFollowing', { target: following });
    return result.following || false;
  } catch (e) {
    return false;
  }
}

async function toggleFollow(follower, following) {
  const result = await callDbOps('toggleFollow', { following });
  return result.followed;
}

async function getSocialRelationship(targetOpenid) {
  return callDbOps('getSocialRelationship', { targetOpenid });
}

async function searchUserByPublicId(publicId) {
  const result = await callDbOps('searchUserByPublicId', { publicId });
  if (result.user) await resolveUserAvatars([result.user]);
  return result;
}

async function updatePublicId(publicId) {
  const result = await callDbOps('updatePublicId', { publicId });
  invalidateCache('profile:');
  return result.publicId;
}

async function sendFriendRequest(targetOpenid) {
  const result = await callDbOps('sendFriendRequest', { targetOpenid });
  invalidateCache('friendCenter', 'unread');
  return result.friend;
}

async function respondFriendRequest(requestId, accept) {
  const result = await callDbOps('respondFriendRequest', { requestId, accept });
  invalidateCache('friendCenter', 'unread');
  return result;
}

async function getFriendCenter() {
  return cachedRequest('friendCenter', 10000, async () => {
    const result = await callDbOps('getFriendCenter');
    const users = [
      ...(result.friends || []),
      ...(result.incoming || []).map(item => item.user).filter(Boolean)
    ];
    await resolveUserAvatars(users);
    return result;
  });
}

async function getSocialPreferences() {
  return cachedRequest('socialPreferences', 15000, () => callDbOps('getSocialPreferences'));
}

async function updateSocialPreference(targetOpenid, preference, enabled) {
  const result = await callDbOps('updateSocialPreference', { targetOpenid, preference, enabled });
  invalidateCache('socialPreferences');
  return result;
}

async function setMood(emoji, text) {
  const result = await callDbOps('setMood', { emoji, text });
  invalidateCache('profile');
  return result;
}

async function clearMood() {
  const result = await callDbOps('clearMood');
  invalidateCache('profile');
  return result;
}

async function deleteFriend(targetOpenid) {
  const result = await callDbOps('deleteFriend', { targetOpenid });
  invalidateCache('friendCenter', 'privateConversations', 'unread');
  return result;
}

async function setTripStatus(tripId, status) {
  const result = await callDbOps('setTripStatus', { tripId, status });
  invalidateCache('myTrips');
  return result.status;
}

async function deleteTrip(tripId) {
  await callDbOps('deleteTrip', { tripId });
  invalidateCache('myTrips');
}

async function deleteTrips(tripIds) {
  const result = await callDbOps('deleteTrips', { tripIds });
  invalidateCache('myTrips');
  return result;
}

async function leaveTrip(tripId) {
  const result = await callDbOps('leaveTrip', { tripId });
  invalidateCache('myTrips');
  return result;
}

async function removeTripMember(memberId) {
  await callDbOps('removeTripMember', { memberId });
  invalidateCache('myTrips');
}

async function createTrip(trip) {
  const result = await callDbOps('createTrip', { trip });
  invalidateCache('myTrips');
  return result;
}

async function createTripFromSource(trip, options = {}) {
  const result = await callDbOps('createTripFromSource', {
    trip,
    sourceTripId: options.sourceTripId || '',
    templateId: options.templateId || ''
  });
  invalidateCache('myTrips');
  return result;
}

async function saveTripTemplate(tripId, name) {
  const result = await callDbOps('saveTripTemplate', { tripId, name });
  invalidateCache('tripTemplates');
  return result.template || null;
}

async function getTripTemplates() {
  return cachedRequest('tripTemplates', 30000, async () => {
    const result = await callDbOps('getTripTemplates', {});
    return result.templates || [];
  });
}

async function getTripTemplate(templateId) {
  const result = await callDbOps('getTripTemplate', { templateId });
  return result.template || null;
}

async function deleteTripTemplate(templateId) {
  const result = await callDbOps('deleteTripTemplate', { templateId });
  invalidateCache('tripTemplates');
  return result;
}

async function updateTrip(tripId, trip) {
  await callDbOps('updateTrip', { tripId, trip });
  invalidateCache('myTrips');
}

/**
 * 获取我的行程（memberships + trips），通过云函数避免跨设备 openid 不匹配
 */
async function getMyTrips() {
  return cachedRequest('myTrips', 15000, async () => {
    const result = await callDbOps('getMyTrips');
    return { memberships: result.memberships || [], trips: result.trips || [], currentTripId: result.currentTripId || '' };
  });
}

async function setCurrentTrip(tripId) {
  const result = await callDbOps('setCurrentTrip', { tripId });
  invalidateCache('myTrips');
  return result;
}

async function getTripDetail(tripId) {
  const result = await callDbOps('getTripDetail', { tripId });
  return {
    trip: result.trip || null,
    members: result.members || [],
    dayPlans: result.dayPlans || []
  };
}

async function getTripSnapshot(tripId, include = []) {
  return callDbOps('getTripSnapshot', { tripId, include });
}

async function getTripDashboard(tripId) {
  const result = await callDbOps('getTripDashboard', { tripId });
  return result.dashboard || null;
}

async function getTripVotes(tripId) {
  const result = await callDbOps('getTripVotes', { tripId });
  return result.votes || [];
}

async function createTripVote(tripId, vote) {
  const result = await callDbOps('createTripVote', { tripId, vote });
  return result.voteId || '';
}

async function voteTripPoll(voteId, optionIndex) {
  return callDbOps('voteTripPoll', { voteId, optionIndex });
}

async function closeTripVote(voteId) {
  return callDbOps('closeTripVote', { voteId });
}

async function getTripTasks(tripId) {
  const result = await callDbOps('getTripTasks', { tripId });
  return result.tasks || [];
}

async function createTripTask(tripId, task) {
  const result = await callDbOps('createTripTask', { tripId, task });
  return result.taskId || '';
}

async function toggleTripTask(taskId) {
  return callDbOps('toggleTripTask', { taskId });
}

async function deleteTripTask(taskId) {
  return callDbOps('deleteTripTask', { taskId });
}

async function getMomentFeed(options = {}) {
  const result = await callDbOps('getMomentFeed', options);
  return { moments: result.moments || [], totalRead: result.totalRead || 0 };
}

async function getMomentById(momentId) {
  const result = await callDbOps('getMomentById', { momentId });
  return result.moment || null;
}
/**
 * 获取城市天气预报
 */
async function getWeather(city) {
  const result = await callDbOps('getWeather', { city });
  return result.weather || [];
}

/**
 * AI 生成行程
 */
async function generateTripPlan(tripId, city, totalDays, preferences = '') {
  const result = await callDbOps('generateTripPlan', { tripId, city, totalDays, preferences });
  return result.plan;
}

async function tripLedgerAssistant(tripId, text) {
  const result = await callDbOps('tripLedgerAssistant', { tripId, text });
  return result.result || null;
}

async function globalTravelAssistant(text, tripId = '') {
  const result = await callDbOps('globalTravelAssistant', { text, tripId });
  return result.answer || '';
}

async function aiChat(text, history = [], conversationId = '') {
  const result = await callDbOps('aiChat', { text, history, conversationId });
  if (!(result && result.success)) throw new Error((result && result.error) || '拾途 AI 请求失败');
  return {
    text: result.text,
    actions: result.actions || [],
    conversationId: result.conversationId || '',
    title: result.title || '',
    userMessage: result.userMessage || null,
    assistantMessage: result.assistantMessage || null
  };
}

async function confirmAiAction(tool, args = {}, metadata = {}) {
  const result = await callDbOps('confirmAiAction', { tool, args, ...metadata });
  if (!(result && result.success)) throw new Error((result && (result.error || (result.result && result.result.msg))) || '操作执行失败');
  if (['create_trip', 'update_trip', 'delete_trip', 'set_current_trip'].includes(tool)) {
    invalidateCache('myTrips');
  }
  return { ...result.result, assistantMessage: result.assistantMessage || null };
}

async function listAiConversations() {
  const result = await callDbOps('listAiConversations');
  return result.conversations || [];
}

async function getAiConversation(conversationId) {
  const result = await callDbOps('getAiConversation', { conversationId });
  return result.conversation || null;
}

async function deleteAiConversation(conversationId) {
  return callDbOps('deleteAiConversation', { conversationId });
}

async function updateAiConversationAction(conversationId, messageId, actionId, status) {
  return callDbOps('updateAiConversationAction', { conversationId, messageId, actionId, status });
}

async function updateAiConversation(conversationId, updates = {}) {
  const result = await callDbOps('updateAiConversation', { conversationId, ...updates });
  return result.conversation || null;
}

async function globalSearch(keyword) {
  const result = await callDbOps('globalSearch', { keyword });
  return result.results || { contacts: [], chats: [], groups: [], ai: [], trips: [] };
}

async function getChatMedia(options = {}) {
  const result = await callDbOps('getChatMedia', options);
  const media = result.media || [];
  media.forEach(item => {
    if (item && typeof item.fileId === 'string' && item.fileId.startsWith('cloud://')) item.rawFileId = item.fileId;
  });
  await resolveCloudFileFields(media, ['imageFileId', 'voiceFileId', 'fileId', 'cardAvatar', 'momentImage']);
  return media;
}

/**
 * 个人默认打包清单（我的页面）
 */
async function getMyPacking() {
  const result = await callDbOps('getMyPacking', {});
  return result.items || [];
}

async function getPackingContext() {
  const result = await callDbOps('getMyPacking', {});
  return {
    items: result.items || [],
    currentTrip: result.currentTrip || null,
    requiresCurrentTrip: !!result.requiresCurrentTrip
  };
}

async function addMyPackingItem(name, category = 'other') {
  return callDbOps('addMyPackingItem', { name, category });
}

async function toggleMyPackingItem(itemId) {
  return callDbOps('toggleMyPackingItem', { itemId });
}

async function removeMyPackingItem(itemId) {
  return callDbOps('removeMyPackingItem', { itemId });
}

async function getPackingHistories() {
  const result = await callDbOps('getPackingHistories', {});
  return result.histories || [];
}

async function savePackingHistory(name) {
  const result = await callDbOps('savePackingHistory', { name });
  return result.history;
}

async function applyPackingHistory(historyId) {
  return callDbOps('applyPackingHistory', { historyId });
}

async function deletePackingHistory(historyId) {
  return callDbOps('deletePackingHistory', { historyId });
}

async function generatePackingSuggestions() {
  const result = await callDbOps('generatePackingSuggestions', {});
  return {
    suggestions: result.suggestions || [],
    currentTrip: result.currentTrip || null
  };
}

async function addGeneratedPackingItems(items) {
  return callDbOps('addGeneratedPackingItems', { items });
}

/**
 * 添加支出（通过云函数）
 */
async function addExpense(expense) {
  return callDbOps('addExpense', { expense });
}

async function updateExpense(expenseId, updates) {
  return callDbOps('updateExpense', { expenseId, updates });
}

async function deleteExpense(expenseId) {
  return callDbOps('deleteExpense', { expenseId });
}

async function recordSettlement(tripId, settledExpenseIds, transfers) {
  return callDbOps('recordSettlement', { tripId, settledExpenseIds, transfers });
}

async function getSettlementHistory(tripId) {
  return callDbOps('getSettlementHistory', { tripId });
}

async function addRefund(expenseId, amount, description) {
  return callDbOps('addRefund', { expenseId, amount, description });
}

/**
 * 新增/更新日行程（通过云函数）
 */
async function upsertDayPlan(dpId, tripId, dayIndex, date, items) {
  return callDbOps('upsertDayPlan', { dpId, tripId, dayIndex, date, items });
}

/**
 * 删除日行程项（通过云函数）
 */
async function deleteDayPlanItem(dpId, items) {
  return callDbOps('deleteDayPlanItem', { dpId, items });
}

async function joinTrip(code) {
  const result = await callDbOps('joinTrip', { code });
  invalidateCache('myTrips');
  return result;
}

async function getPrivateMessages(targetOpenid) {
  const result = await callDbOps('getPrivateMessages', { targetOpenid });
  return result.messages || [];
}

async function getPrivateChat(targetOpenid) {
  const result = await callDbOps('getPrivateMessages', { targetOpenid });
  return {
    messages: result.messages || [],
    targetLastActiveAt: result.targetLastActiveAt || '',
    serverNow: result.serverNow || new Date().toISOString()
  };
}

async function watchPrivateConversation(targetOpenid, handlers = {}) {
  const openid = await getOpenid();
  const conversationId = [openid, targetOpenid].sort().join('__');
  return db.collection('private_messages').where({ conversationId }).watch({
    onChange: snapshot => {
      if (typeof handlers.onChange === 'function') handlers.onChange(snapshot);
    },
    onError: error => {
      if (typeof handlers.onError === 'function') handlers.onError(error);
    }
  });
}

/**
 * 实时监听我的私信（用于消息列表页，替代轮询）
 */
async function watchMyInbox(openid, handlers = {}) {
  const watcher1 = db.collection('private_messages')
    .where({ to: openid })
    .watch({
      onChange: snapshot => {
        if (snapshot.docChanges && snapshot.docChanges.length > 0) {
          if (typeof handlers.onChange === 'function') handlers.onChange(snapshot);
        }
      },
      onError: error => {
        if (typeof handlers.onError === 'function') handlers.onError(error);
      }
    });
  const watcher2 = db.collection('private_messages')
    .where({ from: openid })
    .watch({
      onChange: snapshot => {
        if (snapshot.docChanges && snapshot.docChanges.length > 0) {
          if (typeof handlers.onChange === 'function') handlers.onChange(snapshot);
        }
      },
      onError: error => {
        if (typeof handlers.onError === 'function') handlers.onError(error);
      }
    });
  return [watcher1, watcher2];
}

/**
 * 实时监听群聊消息（替代轮询）
 */
async function watchGroupMessages(groupId, handlers = {}) {
  return db.collection('group_messages')
    .where({ groupId })
    .watch({
      onChange: snapshot => {
        if (typeof handlers.onChange === 'function') handlers.onChange(snapshot);
      },
      onError: error => {
        if (typeof handlers.onError === 'function') handlers.onError(error);
      }
    });
}

async function getUnreadSummary() {
  return cachedRequest('unread', 5000, () => callDbOps('getUnreadSummary'));
}

async function getNotifications(force = false) {
  return cachedRequest('notifications', 8000, () => callDbOps('getNotifications'), force);
}

async function markNotificationsRead() {
  const result = await callDbOps('markNotificationsRead');
  invalidateCache('notifications', 'unread');
  return result;
}

async function markNotificationRead(notificationId) {
  const result = await callDbOps('markNotificationRead', { notificationId });
  invalidateCache('notifications', 'unread');
  return result;
}

async function pollPrivateChat(targetOpenid, lastMessageCreatedAt, unreadMessageIds) {
  return callDbOps('pollPrivateChat', { targetOpenid, lastMessageCreatedAt, unreadMessageIds });
}

async function touchTyping(targetOpenid) {
  return callDbOps('touchTyping', { targetOpenid });
}

async function markMessagesRead(messageIds) {
  const result = await callDbOps('markMessagesRead', { messageIds });
  invalidateCache('unread', 'privateConversations');
  return result;
}

async function getPrivateConversations(force = false) {
  return cachedRequest('privateConversations', 5000, async () => {
    const result = await callDbOps('getPrivateConversations');
    const conversations = result.conversations || [];
    await resolveUserAvatars(conversations);
    return {
      conversations,
      serverNow: result.serverNow || new Date().toISOString()
    };
  }, force);
}

async function sendPrivateMessage(targetOpenid, text, quoteMessageId = '') {
  const result = await callDbOps('sendPrivateMessage', { targetOpenid, text, quoteMessageId });
  invalidateCache('privateConversations', 'unread');
  return result.message;
}

async function recallPrivateMessage(messageId) {
  return callDbOps('recallPrivateMessage', { messageId });
}

async function hidePrivateMessage(messageId) {
  const result = await callDbOps('hidePrivateMessage', { messageId });
  invalidateCache('privateConversations', 'unread');
  return result;
}

async function sendRichPrivateMessage(targetOpenid, type, data) {
  const result = await callDbOps('sendRichPrivateMessage', { targetOpenid, type, data });
  invalidateCache('privateConversations', 'unread');
  return result.message;
}

async function shareMomentToFriend(momentId) {
  const center = await getFriendCenter();
  const friends = center.friends || [];
  if (!friends.length) throw new Error('还没有可分享的好友');
  const action = await wx.showActionSheet({
    alertText: '分享动态给好友',
    itemList: friends.slice(0, 20).map(item => item.nickName || item.publicId || '好友')
  });
  const friend = friends[action.tapIndex];
  if (!friend) return null;
  await sendRichPrivateMessage(friend.openid, 'moment_share', { momentId });
  return friend;
}

async function getInvitableTrips(targetOpenid) {
  const result = await callDbOps('getInvitableTrips', { targetOpenid });
  return result.trips || [];
}

async function sendTripInvitation(targetOpenid, tripId) {
  return callDbOps('sendTripInvitation', { targetOpenid, tripId });
}

async function respondTripInvitation(messageId, accept) {
  return callDbOps('respondTripInvitation', { messageId, accept });
}

async function createGroupChat(name, memberOpenids) {
  const result = await callDbOps('createGroupChat', { name, memberOpenids });
  invalidateCache('groupConversations');
  return result.groupId;
}

async function getGroupConversations(force = false) {
  return cachedRequest('groupConversations', 5000, async () => {
    const result = await callDbOps('getGroupConversations');
    return result.groups || [];
  }, force);
}

async function getGroupMessages(groupId, since = '') {
  return callDbOps('getGroupMessages', { groupId, since });
}

async function sendGroupMessage(groupId, text, quoteMessageId = '') {
  const result = await callDbOps('sendGroupMessage', { groupId, text, quoteMessageId });
  invalidateCache('groupConversations');
  return result.message;
}

async function sendRichGroupMessage(groupId, type, data) {
  const result = await callDbOps('sendRichGroupMessage', { groupId, type, data });
  invalidateCache('groupConversations');
  return result.message;
}

async function recallGroupMessage(messageId) {
  return callDbOps('recallGroupMessage', { messageId });
}

async function hideGroupMessage(messageId) {
  const result = await callDbOps('hideGroupMessage', { messageId });
  invalidateCache('groupConversations');
  return result;
}

async function leaveGroup(groupId) {
  const result = await callDbOps('leaveGroup', { groupId });
  invalidateCache('groupConversations');
  return result;
}

async function toggleGroupNotifications(groupId) {
  const result = await callDbOps('toggleGroupNotifications', { groupId });
  invalidateCache('groupConversations');
  return result;
}

async function muteGroupMember(groupId, memberOpenid) {
  return callDbOps('muteGroupMember', { groupId, memberOpenid });
}

async function unmuteGroupMember(groupId, memberOpenid) {
  return callDbOps('unmuteGroupMember', { groupId, memberOpenid });
}

async function dissolveGroup(groupId) {
  const result = await callDbOps('dissolveGroup', { groupId });
  invalidateCache('groupConversations');
  return result;
}

async function getFollowList(openid, type) {
  try {
    const result = await callDbOps('getFollowList', { openid, type });
    return result.openids || [];
  } catch (e) {
    console.warn('getFollowList failed:', e);
    return [];
  }
}

async function batchGetUsers(openids) {
  if (!openids.length) return {};
  try {
    const result = await callDbOps('batchGetUsers', { openids });
    const users = result.users || {};
    await resolveUserAvatars(Object.keys(users).map(openid => users[openid]));
    return users;
  } catch (e) {
    console.warn('batchGetUsers failed:', e);
    return {};
  }
}

const STATUS_ICON_NAMES = new Set(['飞机', '听歌识曲', '运动', '餐饮', '冥想', '难受']);
const LEGACY_STATUS_ICON_MAP = {
  '✈️': '飞机', '✈': '飞机', '🛫': '飞机',
  '🎵': '听歌识曲', '🎶': '听歌识曲', '🎧': '听歌识曲',
  '🏃': '运动', '💪': '运动',
  '🍜': '餐饮', '🍔': '餐饮', '🍕': '餐饮', '☕': '餐饮',
  '😢': '难受', '😴': '难受', '🌧️': '难受', '🌙': '难受'
};

function resolveStatusIcon(value) {
  const icon = String(value || '').trim();
  if (STATUS_ICON_NAMES.has(icon)) return icon;
  return LEGACY_STATUS_ICON_MAP[icon] || (icon ? '冥想' : '');
}

/**
 * 批量获取云文件临时链接（通过云函数绕过存储权限限制）
 */
async function _batchGetTempUrls(idList) {
  const map = {};
  const now = Date.now();
  const cloudIds = [...new Set(idList.filter(id => typeof id === 'string' && id.startsWith('cloud://')))];
  const missingIds = [];
  cloudIds.forEach(id => {
    const cached = _tempUrlCache[id];
    if (cached && now < cached.expiresAt) map[id] = cached.url;
    else missingIds.push(id);
  });
  if (cloudIds.length === 0) return map;
  const batchSize = 50;
  for (let i = 0; i < missingIds.length; i += batchSize) {
    const batch = missingIds.slice(i, i + batchSize);
    try {
      const result = await callDbOps('getTempUrls', { fileList: batch });
      const urls = result.urls || {};
      Object.assign(map, urls);
      Object.keys(urls).forEach(id => {
        _tempUrlCache[id] = { url: urls[id], expiresAt: Date.now() + 50 * 60 * 1000 };
      });
    } catch (e) {
      console.warn('_batchGetTempUrls failed:', e);
    }
  }
  return map;
}

async function resolveCloudFileFields(items, fields) {
  if (!items || items.length === 0 || !fields || fields.length === 0) return;
  const ids = new Set();
  items.forEach(item => {
    fields.forEach(field => {
      const value = item && item[field];
      if (typeof value === 'string' && value.startsWith('cloud://')) ids.add(value);
    });
  });
  const map = await _batchGetTempUrls([...ids]);
  items.forEach(item => {
    fields.forEach(field => {
      if (item && item[field] && map[item[field]]) item[field] = map[item[field]];
    });
  });
}

async function getTempFileUrl(fileID) {
  if (!fileID || typeof fileID !== 'string') return '';
  if (!fileID.startsWith('cloud://')) return fileID;
  const map = await _batchGetTempUrls([fileID]);
  return map[fileID] || '';
}

async function resolveUserAvatars(users) {
  if (!users || users.length === 0) return;
  await resolveCloudFileFields(users, ['avatarUrl', 'avatarThumbUrl']);
}

/**
 * 批量解析语音云文件ID为临时链接
 */
async function resolveVoiceUrls(items, key) {
  const ids = [...new Set(items.map(i => i[key]).filter(Boolean))];
  if (ids.length === 0) return;
  const map = await _batchGetTempUrls(ids);
  items.forEach(i => {
    if (i[key] && map[i[key]]) i[key] = map[i[key]];
  });
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
  const map = await _batchGetTempUrls(ids);
  moments.forEach(m => {
    (m.comments || []).forEach(c => {
      if (c.voice && map[c.voice]) c.voice = map[c.voice];
    });
  });
}

/**
 * 批量解析动态中的所有图片/视频/头像为临时链接（绕过云存储权限限制）
 */
async function resolveMomentImages(moments) {
  const ids = new Set();
  moments.forEach(m => {
    if (m.authorAvatar && m.authorAvatar.startsWith('cloud://')) ids.add(m.authorAvatar);
    if (m.authorAvatarThumb && m.authorAvatarThumb.startsWith('cloud://')) ids.add(m.authorAvatarThumb);
    (m.images || []).forEach(img => { if (img && img.startsWith('cloud://')) ids.add(img); });
    (m.imageThumbs || []).forEach(img => { if (img && img.startsWith('cloud://')) ids.add(img); });
    (m.comments || []).forEach(c => {
      if (c.image && c.image.startsWith('cloud://')) ids.add(c.image);
    });
  });
  const idList = [...ids];
  if (idList.length === 0) return;
  const map = await _batchGetTempUrls(idList);
  moments.forEach(m => {
    if (m.authorAvatar && map[m.authorAvatar]) m.authorAvatar = map[m.authorAvatar];
    if (m.authorAvatarThumb && map[m.authorAvatarThumb]) m.authorAvatarThumb = map[m.authorAvatarThumb];
    (m.images || []).forEach((img, i) => { if (map[img]) m.images[i] = map[img]; });
    (m.imageThumbs || []).forEach((img, i) => { if (map[img]) m.imageThumbs[i] = map[img]; });
    (m.comments || []).forEach(c => {
      if (c.image && map[c.image]) c.image = map[c.image];
    });
  });
}

async function resolveMoments(moments) {
  if (!moments || moments.length === 0) return;
  await resolveMomentAuthors(moments);
  await Promise.all([
    resolveCommentVoices(moments),
    resolveMomentImages(moments)
  ]);
}

/**
 * 批量解析动态的作者和评论者信息（从 users 集合获取最新头像昵称）
 */
async function resolveMomentAuthors(moments) {
  if (!moments || !moments.length) return;
  const openids = new Set();
  moments.forEach(m => {
    if (m.authorId) openids.add(m.authorId);
    (m.comments || []).forEach(c => {
      if (c.openid) openids.add(c.openid);
      if (c.replyTo && c.replyTo.openid) openids.add(c.replyTo.openid);
    });
    // 解析点赞者
    (m.likes || []).forEach(openid => openids.add(openid));
  });
  const idList = [...openids];
  if (idList.length === 0) return;
  const userMap = await batchGetUsers(idList);
  moments.forEach(m => {
    const author = userMap[m.authorId];
    if (author) {
      if (author.avatarUrl) m.authorAvatar = author.avatarUrl;
      if (author.avatarThumbUrl) m.authorAvatarThumb = author.avatarThumbUrl;
      if (author.nickName) m.authorName = author.nickName;
      m.authorMoodIcon = resolveStatusIcon(author.moodEmoji);
      m.authorMoodText = author.moodText || '';
      // 徽章：佩戴中且未隐藏才显示
      if (author.wornBadge && (author.showBadge === undefined || author.showBadge)) {
        m.authorBadgeIcon = getBadgeIcon(author.wornBadge);
      }
      // 官方认证
      if (isOfficialByPublicId(author.publicId)) {
        m.authorVerified = true;
      }
    }
    (m.comments || []).forEach(c => {
      const commenter = userMap[c.openid];
      if (commenter) {
        if (commenter.nickName) c.nickName = commenter.nickName;
        if (commenter.avatarUrl) c.avatarUrl = commenter.avatarUrl;
      }
      if (c.replyTo && c.replyTo.openid) {
        const target = userMap[c.replyTo.openid];
        if (target) {
          if (target.nickName) c.replyTo.nickName = target.nickName;
          if (target.avatarUrl) c.replyTo.avatarUrl = target.avatarUrl;
        }
      }
    });
    // 解析点赞者列表
    if (m.likes && m.likes.length) {
      m.likers = m.likes.map(openid => {
        const u = userMap[openid];
        return u ? { openid, nickName: u.nickName || '', avatarUrl: u.avatarUrl || '' } : { openid, nickName: '', avatarUrl: '' };
      });
    }
  });
}

/**
 * ══════ 动态操作（通过云函数） ══════
 * 点赞/收藏/评论操作走 momentOps 云函数，避免客户端集合权限限制
 */

async function callMomentOps(action, payload = {}) {
  const res = await wx.cloud.callFunction({
    name: 'momentOps',
    data: { action, ...payload, _sessionToken: getSessionToken() }
  });
  if (!res || !res.result) throw new Error('云函数调用失败');
  if (!res.result.success) throw new Error(res.result.error || '操作失败');
  if (['create', 'update', 'delete', 'togglePrivate', 'like', 'favorite', 'share', 'comment', 'editComment', 'deleteComment'].includes(action)) {
    wx.setStorageSync('_momentsNeedsRefresh', true);
  }
  return res.result;
}

async function toggleLike(momentId) {
  return callMomentOps('like', { momentId });
}

async function toggleFavoriteMoment(momentId) {
  return callMomentOps('favorite', { momentId });
}

async function recordMomentShare(momentId, count = 1) {
  const result = await callMomentOps('share', { momentId, count });
  return Number(result.shareCount) || 0;
}

async function addComment(momentId, comment) {
  return callMomentOps('comment', { momentId, comment });
}

async function deleteComment(momentId, commentId) {
  return callMomentOps('deleteComment', { momentId, commentId });
}

async function editComment(momentId, commentId, text) {
  return callMomentOps('editComment', { momentId, commentId, text });
}

async function createMoment(moment) {
  const result = await callMomentOps('create', { moment });
  return result.moment;
}

async function updateMoment(momentId, data) {
  return callMomentOps('update', { momentId, ...data });
}

async function toggleMomentPrivate(momentId) {
  const result = await callMomentOps('togglePrivate', { momentId });
  return result.isPrivate;
}

async function deleteMoment(momentId) {
  return callMomentOps('delete', { momentId });
}

/**
 * 获取用户动态互动统计（获赞/收藏/评论总数）
 */
async function getMyMomentStats() {
  try {
    const result = await callMomentOps('getMyMomentStats');
    return result.stats || { momentCount: 0, totalLikes: 0, totalFavorites: 0, totalComments: 0 };
  } catch (e) {
    console.warn('getMyMomentStats failed:', e);
    return { momentCount: 0, totalLikes: 0, totalFavorites: 0, totalComments: 0 };
  }
}

/**
 * ══════ 账号系统（accountOps 云函数） ══════
 */

function getDeviceInfoForSession() {
  try {
    const device = typeof wx.getDeviceInfo === 'function' ? wx.getDeviceInfo() : wx.getSystemInfoSync();
    const app = typeof wx.getAppBaseInfo === 'function' ? wx.getAppBaseInfo() : {};
    return {
      name: device.model || `${device.brand || ''} ${device.platform || ''}`.trim() || '微信设备',
      model: device.model || '',
      platform: device.platform || '',
      system: device.system || '',
      appVersion: app.version || ''
    };
  } catch (_) {
    return { name: '微信设备' };
  }
}

async function loginWithPassword(publicId, password) {
  const res = await wx.cloud.callFunction({
    name: 'accountOps',
    data: { action: 'login', publicId, password, deviceInfo: getDeviceInfoForSession() }
  });
  if (!res || !res.result) throw new Error('云函数调用失败');
  if (!res.result.success) throw new Error(res.result.error || '登录失败');

  const user = res.result.user;
  // 将账号登录返回的 openid 存入缓存，后续所有页面用 getOpenid() 获取
  setOpenid(user.openid);
  _accountUser = user;

  // 保存 session token（支持多设备切换）
  if (res.result.sessionToken) {
    setSessionToken(res.result.sessionToken);
  }

  const app = getApp();
  if (app && app.globalData) {
    app.globalData.userInfo = {
      nickName: user.nickName || '',
      avatarUrl: user.avatarUrl || '',
      publicId: user.publicId || '',
      username: user.username || ''
    };
    app.globalData.accountType = 'password';
  }

  return user;
}

async function registerWithPassword(username, password) {
  const res = await wx.cloud.callFunction({
    name: 'accountOps',
    data: { action: 'register', username, password, deviceInfo: getDeviceInfoForSession() }
  });
  if (!res || !res.result) throw new Error('云函数调用失败');
  if (!res.result.success) throw new Error(res.result.error || '注册失败');

  const user = res.result.user;
  // 注册成功自动登录：存入 openid 缓存
  setOpenid(user.openid);
  _accountUser = user;

  // 保存 session token（支持多设备）
  if (res.result.sessionToken) {
    setSessionToken(res.result.sessionToken);
  }

  const app = getApp();
  if (app && app.globalData) {
    app.globalData.userInfo = {
      nickName: '',
      avatarUrl: '',
      publicId: user.publicId || '',
      username: user.username || ''
    };
    app.globalData.accountType = 'password';
  }

  return user;
}

async function checkUsername(username) {
  const res = await wx.cloud.callFunction({
    name: 'accountOps',
    data: { action: 'checkUsername', username }
  });
  if (!res || !res.result) throw new Error('云函数调用失败');
  if (!res.result.success) throw new Error(res.result.error || '检查失败');
  return res.result.available;
}

/**
 * 验证 ID 身份（忘记密码 step1：校验微信是否绑定该账号）
 */
async function verifyIdentity(publicId, username) {
  const res = await wx.cloud.callFunction({
    name: 'accountOps',
    data: { action: 'verifyIdentity', publicId, username }
  });
  if (!res || !res.result) throw new Error('云函数调用失败');
  if (!res.result.success) throw new Error(res.result.error || '验证失败');
  return res.result;
}

/**
 * 重置密码（忘记密码 step2）
 */
async function resetPassword(publicId, username, newPassword) {
  const res = await wx.cloud.callFunction({
    name: 'accountOps',
    data: { action: 'resetPassword', publicId, username, newPassword }
  });
  if (!res || !res.result) throw new Error('云函数调用失败');
  if (!res.result.success) throw new Error(res.result.error || '重置失败');
  return true;
}

/**
 * 修改密码
 */
async function changePassword(oldPassword, newPassword) {
  const res = await wx.cloud.callFunction({
    name: 'accountOps',
    data: { action: 'changePassword', oldPassword, newPassword, _sessionToken: getSessionToken() }
  });
  if (!res || !res.result) throw new Error('云函数调用失败');
  if (!res.result.success) throw new Error(res.result.error || '修改失败');
  return true;
}

async function listAccountSessions() {
  const res = await wx.cloud.callFunction({
    name: 'accountOps',
    data: { action: 'listSessions', _sessionToken: getSessionToken() }
  });
  if (!res || !res.result || !res.result.success) throw new Error((res && res.result && res.result.error) || '登录设备加载失败');
  return res.result.sessions || [];
}

async function revokeAccountSession(sessionId) {
  const res = await wx.cloud.callFunction({
    name: 'accountOps',
    data: { action: 'revokeSession', sessionId, _sessionToken: getSessionToken() }
  });
  if (!res || !res.result || !res.result.success) throw new Error((res && res.result && res.result.error) || '退出设备失败');
  return true;
}

async function revokeOtherAccountSessions() {
  const res = await wx.cloud.callFunction({
    name: 'accountOps',
    data: { action: 'revokeOtherSessions', _sessionToken: getSessionToken() }
  });
  if (!res || !res.result || !res.result.success) throw new Error((res && res.result && res.result.error) || '退出其他设备失败');
  return Number(res.result.revoked) || 0;
}

// ---- 主题配置 ----
async function updateThemeConfig(config) {
  return callDbOps('updateThemeConfig', { themeConfig: config });
}

async function getThemeConfig() {
  const res = await callDbOps('getThemeConfig', {});
  return (res && res.result) || null;
}

module.exports = {
  db,
  collection: db.collection.bind(db),
  _,
  getOpenid,
  setOpenid,
  genInviteCode,
  uploadImage,
  createImageThumbnail,
  uploadImageWithThumbnail,
  uploadFile,
  downloadCloudFile,
  daysBetween,
  dateRange,
  formatDate,
  categoryIcon,
  userProfileUrl,
  navigateToUserProfile,
  getDoc,
  upsertUser,
  updateUserSettings,
  getUserProfile,
  getFollowStats,
  isFollowing,
  toggleFollow,
  getSocialRelationship,
  searchUserByPublicId,
  updatePublicId,
  sendFriendRequest,
  respondFriendRequest,
  getFriendCenter,
  getSocialPreferences,
  updateSocialPreference,
  deleteFriend,
  setMood,
  clearMood,
  setTripStatus,
  deleteTrip,
  deleteTrips,
  leaveTrip,
  removeTripMember,
  createTrip,
  createTripFromSource,
  saveTripTemplate,
  getTripTemplates,
  getTripTemplate,
  deleteTripTemplate,
  updateTrip,
  joinTrip,
  getMyTrips,
  setCurrentTrip,
  getTripDetail,
  getTripSnapshot,
  getTripDashboard,
  getTripVotes,
  createTripVote,
  voteTripPoll,
  closeTripVote,
  getTripTasks,
  createTripTask,
  toggleTripTask,
  deleteTripTask,
  getMomentFeed,
  getMomentById,
  getWeather,
  generateTripPlan,
  tripLedgerAssistant,
  globalTravelAssistant,
  aiChat,
  confirmAiAction,
  listAiConversations,
  getAiConversation,
  deleteAiConversation,
  updateAiConversationAction,
  updateAiConversation,
  globalSearch,
  getChatMedia,
  getMyPacking,
  getPackingContext,
  addMyPackingItem,
  toggleMyPackingItem,
  removeMyPackingItem,
  getPackingHistories,
  savePackingHistory,
  applyPackingHistory,
  deletePackingHistory,
  generatePackingSuggestions,
  addGeneratedPackingItems,
  addExpense,
  updateExpense,
  deleteExpense,
  recordSettlement,
  getSettlementHistory,
  addRefund,
  upsertDayPlan,
  deleteDayPlanItem,

  getPrivateMessages,
  getPrivateChat,
  watchPrivateConversation,
  watchMyInbox,
  watchGroupMessages,
  pollPrivateChat,
  touchTyping,
  markMessagesRead,
  getUnreadSummary,
  getNotifications,
  markNotificationsRead,
  markNotificationRead,
  getPrivateConversations,
  sendPrivateMessage,
  recallPrivateMessage,
  hidePrivateMessage,
  sendRichPrivateMessage,
  shareMomentToFriend,
  getInvitableTrips,
  sendTripInvitation,
  respondTripInvitation,
  createGroupChat,
  getGroupConversations,
  getGroupMessages,
  sendGroupMessage,
  sendRichGroupMessage,
  recallGroupMessage,
  hideGroupMessage,
  leaveGroup,
  toggleGroupNotifications,
  muteGroupMember,
  unmuteGroupMember,
  dissolveGroup,
  getFollowList,
  batchGetUsers,
  resolveVoiceUrls,
  resolveCommentVoices,
  resolveMomentAuthors,
  resolveMomentImages,
  resolveMoments,
  resolveUserAvatars,
  resolveCloudFileFields,
  getTempFileUrl,
  toggleLike,
  toggleFavoriteMoment,
  recordMomentShare,
  addComment,
  deleteComment,
  editComment,
  createMoment,
  updateMoment,
  toggleMomentPrivate,
  deleteMoment,
  getMyMomentStats,
  loginWithPassword,
  registerWithPassword,
  checkUsername,
  verifyIdentity,
  resetPassword,
  changePassword,
  listAccountSessions,
  revokeAccountSession,
  revokeOtherAccountSessions,
  getSessionToken,
  setSessionToken,
  clearSessionToken,
  BADGE_DEFS,
  getBadgeById,
  getBadgeIcon,
  setWornBadge,
  updateShowBadge,
  isOfficialByPublicId,
  updateThemeConfig,
  getThemeConfig
};
