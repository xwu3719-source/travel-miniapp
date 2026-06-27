const PREFIX = '_shituDraft:';

function key(scope, id = '') {
  const app = typeof getApp === 'function' ? getApp() : null;
  const openid = app && app.globalData && app.globalData.openid ? app.globalData.openid : 'guest';
  return `${PREFIX}${openid}:${scope}:${id || 'default'}`;
}

function getDraft(scope, id = '') {
  try {
    const draft = wx.getStorageSync(key(scope, id));
    return draft && typeof draft === 'object' ? draft : null;
  } catch (_) {
    return null;
  }
}

function saveDraft(scope, id = '', data = {}) {
  try {
    const empty = !data || Object.values(data).every(value => value === '' || value == null || (Array.isArray(value) && !value.length));
    if (empty) return clearDraft(scope, id);
    wx.setStorageSync(key(scope, id), { ...data, savedAt: new Date().toISOString() });
  } catch (_) {}
}

function clearDraft(scope, id = '') {
  try { wx.removeStorageSync(key(scope, id)); } catch (_) {}
}

module.exports = { getDraft, saveDraft, clearDraft };
