const cloud = require('./cloud');

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    return value;
  }
}

function parseQuery(text) {
  const query = {};
  const source = String(text || '');
  const queryText = source.includes('?') ? source.split('?').slice(1).join('?') : source;
  queryText.split('&').forEach(part => {
    const [rawKey, ...rest] = part.split('=');
    if (!rawKey || !rest.length) return;
    const key = safeDecode(rawKey).trim();
    const value = safeDecode(rest.join('=')).trim();
    query[key] = value;
  });
  return query;
}

function pickInviteCode(text) {
  const source = String(text || '').trim();
  const query = parseQuery(source);
  const fromQuery = query.code || query.inviteCode || query.tripCode || query.invite || '';
  if (fromQuery) return String(fromQuery).trim().toUpperCase().slice(0, 12);
  const tagged = source.match(/(?:STTRIP|TRIP|INVITE)[:：\s-]*([A-Za-z0-9]{4,12})/i);
  if (tagged) return tagged[1].toUpperCase();
  const plain = source.match(/^[A-Za-z0-9]{4,8}$/);
  return plain ? source.toUpperCase() : '';
}

function pickUserId(text) {
  const source = String(text || '').trim();
  const query = parseQuery(source);
  const openid = query.openid || query.uid || '';
  const publicId = query.publicId || query.userId || query.id || '';
  const tagged = source.match(/(?:STUSER|USER|PUBLICID)[:：\s-]*([A-Za-z0-9_-]{4,32})/i);
  return {
    openid: String(openid || '').trim(),
    publicId: String(publicId || (tagged && tagged[1]) || '').trim()
  };
}

function parseAmount(text) {
  const match = String(text || '').match(/(?:¥|￥)?\s*(\d+(?:\.\d{1,2})?)\s*(?:元|块|RMB|rmb)?/);
  return match ? match[1] : '';
}

function isUrl(text) {
  return /^https?:\/\//i.test(String(text || '').trim());
}

function parseScanResult(raw) {
  const text = String((raw && (raw.result || raw.path || raw.rawData)) || raw || '').trim();
  const query = parseQuery(text);
  const inviteCode = pickInviteCode(text);
  const user = pickUserId(text);
  if ((query.code || query.inviteCode || query.tripCode || query.invite) && inviteCode) {
    return { type: 'trip_invite', text, code: inviteCode };
  }
  if (/trip|invite|join|行程/i.test(text) && inviteCode) {
    return { type: 'trip_invite', text, code: inviteCode };
  }
  if (inviteCode && /^[A-Z0-9]{4,8}$/.test(inviteCode) && !isUrl(text)) {
    return { type: 'trip_invite', text, code: inviteCode };
  }
  if (user.openid || user.publicId) {
    return { type: 'user', text, ...user };
  }
  if (isUrl(text)) {
    return { type: 'link', text, url: text };
  }
  return { type: 'text', text, amount: parseAmount(text) };
}

function scanCode() {
  return new Promise((resolve, reject) => {
    wx.scanCode({
      onlyFromCamera: false,
      scanType: ['qrCode', 'barCode'],
      success: res => resolve(parseScanResult(res)),
      fail: reject
    });
  });
}

async function handleParsedResult(parsed, options = {}) {
  if (!parsed || !parsed.text) return null;
  if (parsed.type === 'trip_invite' && parsed.code) {
    wx.navigateTo({ url: `/pages/join/join?code=${encodeURIComponent(parsed.code)}&auto=1` });
    return parsed;
  }
  if (parsed.type === 'user') {
    if (parsed.openid) {
      cloud.navigateToUserProfile(parsed.openid);
      return parsed;
    }
    if (parsed.publicId) {
      const user = await cloud.searchUserByPublicId(parsed.publicId);
      if (!user) throw new Error('没有找到这个用户');
      cloud.navigateToUserProfile(user.openid || user.uid, user);
      return parsed;
    }
  }
  if (typeof options.onText === 'function') {
    options.onText(parsed);
    return parsed;
  }
  wx.showModal({
    title: parsed.type === 'link' ? '识别到链接' : '扫码内容',
    content: parsed.text.slice(0, 500),
    confirmText: '复制',
    confirmColor: '#5b9ff5',
    success: res => {
      if (res.confirm) wx.setClipboardData({ data: parsed.text });
    }
  });
  return parsed;
}

async function scanAndHandle(options = {}) {
  const parsed = await scanCode();
  return handleParsedResult(parsed, options);
}

module.exports = {
  scanCode,
  parseScanResult,
  handleParsedResult,
  scanAndHandle
};
