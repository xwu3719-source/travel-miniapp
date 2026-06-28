const cloud = require('../../utils/cloud');
const theme = require('../../utils/theme');

const MOOD_ICON_NAMES = new Set(['飞机', '听歌识曲', '运动', '餐饮', '冥想', '难受']);
const MOOD_ICON_LABELS = {
  '飞机': '旅行中',
  '听歌识曲': '听歌',
  '运动': '运动中',
  '餐饮': '吃饭中',
  '冥想': '放空',
  '难受': '低落'
};
const LEGACY_MOOD_ICON_MAP = {
  '✈️': '飞机', '✈': '飞机', '🛫': '飞机',
  '🎵': '听歌识曲', '🎶': '听歌识曲', '🎧': '听歌识曲',
  '🏃': '运动', '💪': '运动',
  '🍜': '餐饮', '🍔': '餐饮', '🍕': '餐饮', '☕': '餐饮',
  '😢': '难受', '😴': '难受', '🌧️': '难受', '🌙': '难受'
};

function moodIconName(value) {
  const icon = String(value || '').trim();
  if (MOOD_ICON_NAMES.has(icon)) return icon;
  return LEGACY_MOOD_ICON_MAP[icon] || (icon ? '冥想' : '');
}

Page({
  data: {
    userInfo: { avatarUrl: '', nickName: '', signature: '', publicId: '' },
    hasUserInfo: false,
    tripCount: 0,
    historyTrips: [],
    totalTrips: 0,
    refreshing: false,
    showHistory: false,
    showIdEditor: false,
    idInput: '',
    savingId: false,
    followStats: { following: 0, followers: 0 },
    mood: null,
    // 旅行足迹 & 统计
    footprintCities: [],
    travelDays: 0,
    uniqueCityCount: 0,
    // 个人互动数据
    interactionStats: { momentCount: 0, totalLikes: 0, totalFavorites: 0, totalComments: 0 },
    // 资料完整度
    profileCompleteness: 0,
    completenessHint: '',
    // 徽章
    badges: [],
    earnedBadgeCount: 0,
    wornBadgeId: '',
    wornBadgeIcon: '',
    showBadge: true,
    isOfficial: false,

    // 行李清单摘要
    packingItems: [],
    packingChecked: 0,
    packingPercentText: '0%'
  },

  onShow() {
    theme.applyToPage(this);
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      const tabBar = this.getTabBar();
      tabBar.setData({ selected: 4 });
      if (tabBar.refreshUnread) tabBar.refreshUnread();
    }
    const app = getApp();
    if (app.globalData.userInfo) {
      this.setData({ userInfo: app.globalData.userInfo, hasUserInfo: true });
    }
    // 30 秒内切 tab 回来不重复加载，减少云函数调用
    const now = Date.now();
    if (this._lastLoadTime && now - this._lastLoadTime < 30000) {
      // 仅刷新本地计算
      this.computeProfileCompleteness();
      this.computeBadges();
      return;
    }
    this._lastLoadTime = now;
    this.loadCloudProfile();
    this.loadStats();
    this.loadFollowStats();
    this.loadInteractionStats();
    this.loadPackingList();
    this.computeProfileCompleteness();
    this.computeBadges();
  },

  onRefresh() {
    this.setData({ refreshing: true });
    Promise.all([
      this.loadCloudProfile(),
      this.loadStats(),
      this.loadFollowStats(),
      this.loadInteractionStats(),
      this.loadPackingList()
    ]).then(() => {
      this.computeProfileCompleteness();
      this.computeBadges();
      this.setData({ refreshing: false });
    });
  },

  async loadStats() {
    try {
      const { memberships, trips } = await cloud.getMyTrips();

      if (!memberships.length) {
        this.setData({
          tripCount: 0, historyTrips: [], totalTrips: 0,
          footprintCities: [], travelDays: 0, uniqueCityCount: 0
        });
        this.computeBadges();
        return;
      }

      const history = trips.filter(t => t.status === 'archived');
      const active = trips.filter(t => t.status !== 'archived');

      // 旅行足迹：去重城市名
      const citySet = new Set();
      trips.forEach(t => {
        if (t.city) String(t.city).split(/[,，、\s]+/).forEach(c => {
          const cleaned = c.trim();
          if (cleaned) citySet.add(cleaned);
        });
      });
      const footprintCities = [...citySet];

      // 旅行统计：累计天数
      let travelDays = 0;
      trips.forEach(t => {
        if (t.startDate && t.endDate) {
          const d = (new Date(t.endDate) - new Date(t.startDate)) / (1000 * 60 * 60 * 24) + 1;
          if (d > 0) travelDays += Math.round(d);
        } else if (t.totalDays) {
          travelDays += Number(t.totalDays) || 0;
        }
      });

      this.setData({
        tripCount: active.length,
        historyTrips: history,
        totalTrips: trips.length,
        footprintCities,
        travelDays,
        uniqueCityCount: footprintCities.length
      });
      this.computeBadges();
    } catch (e) {
      console.error('加载统计失败:', e);
    }
  },

  /* ══════ 头像昵称 ══════ */
  async loadCloudProfile() {
    try {
      const openid = await cloud.getOpenid();
      const user = await cloud.getUserProfile(openid);
      if (!user) { this.computeBadges(); return; }
      const userInfo = {
        nickName: user.nickName || this.data.userInfo.nickName || '',
        avatarUrl: user.avatarUrl || this.data.userInfo.avatarUrl || '',
        rawAvatarUrl: user.rawAvatarUrl || this.data.userInfo.rawAvatarUrl || '',
        avatarFileId: user.rawAvatarUrl || this.data.userInfo.avatarFileId || '',
        signature: typeof user.signature === 'string' ? user.signature : (this.data.userInfo.signature || ''),
        publicId: user.publicId || this.data.userInfo.publicId || ''
      };
      getApp().globalData.userInfo = userInfo;
      const mood = user.moodEmoji ? {
        emoji: user.moodEmoji,
        icon: moodIconName(user.moodEmoji),
        label: MOOD_ICON_LABELS[moodIconName(user.moodEmoji)] || '当前状态',
        text: user.moodText || ''
      } : null;
      const wornBadgeId = user.wornBadge || '';
      const showBadge = user.showBadge !== undefined ? user.showBadge : true;
      const wornBadge = cloud.getBadgeById(wornBadgeId);
      const wornBadgeIcon = wornBadge ? wornBadge.icon : '';
      const isOfficial = cloud.isOfficialByPublicId(userInfo.publicId);
      this.setData({
        userInfo,
        mood,
        wornBadgeId,
        wornBadgeIcon,
        showBadge,
        isOfficial,
        hasUserInfo: !!(userInfo.nickName || userInfo.avatarUrl || userInfo.signature || userInfo.publicId)
      });
      this.computeProfileCompleteness();
      this.computeBadges();
    } catch (e) {
      console.warn('恢复云端资料失败:', e);
    }
  },

  onStatTap(e) {
    const { action } = e.currentTarget.dataset;
    if (action === 'archived') {
      this.setData({ showHistory: !this.data.showHistory });
    } else {
      wx.switchTab({ url: '/pages/index/index' });
    }
  },

  onToggleHistory() {
    this.setData({ showHistory: !this.data.showHistory });
  },

  onTripTap(e) {
    const { id } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/trip-detail/trip-detail?tripId=${id}` });
  },

  onAvatarTap() {
    const avatarUrl = this.data.userInfo.avatarUrl;
    if (avatarUrl) {
      wx.previewImage({ urls: [avatarUrl], current: avatarUrl });
    } else {
      this.onEditProfile();
    }
  },

  onEditProfile() {
    wx.navigateTo({ url: '/pages/edit-profile/edit-profile' });
  },

  onCopyPublicId() {
    if (!this.data.userInfo.publicId) return;
    wx.setClipboardData({ data: this.data.userInfo.publicId });
  },

  onOpenIdEditor() {
    this.setData({ showIdEditor: true, idInput: this.data.userInfo.publicId || '' });
  },

  onCloseIdEditor() {
    if (this.data.savingId) return;
    this.setData({ showIdEditor: false, idInput: '' });
  },

  onIdInput(e) {
    const idInput = String(e.detail.value || '').replace(/\D/g, '').slice(0, 6);
    this.setData({ idInput });
  },

  async onSavePublicId() {
    const publicId = this.data.idInput.trim();
    if (!/^\d{6}$/.test(publicId)) {
      return wx.showToast({ title: '请输入 6 位数字', icon: 'none' });
    }
    if (publicId === this.data.userInfo.publicId) return this.onCloseIdEditor();
    this.setData({ savingId: true });
    try {
      const savedId = await cloud.updatePublicId(publicId);
      const userInfo = { ...this.data.userInfo, publicId: savedId };
      getApp().globalData.userInfo = userInfo;
      this.setData({ userInfo, showIdEditor: false, idInput: '' });
      this.computeProfileCompleteness();
      this.computeBadges();
      wx.showToast({ title: 'ID 已更新', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: e.message || '修改失败', icon: 'none' });
    } finally {
      this.setData({ savingId: false });
    }
  },

  async loadFollowStats() {
    try {
      const openid = await cloud.getOpenid();
      const stats = await cloud.getFollowStats(openid);
      this.setData({ followStats: stats });
      this.computeProfileCompleteness();
      this.computeBadges();
    } catch (e) {
      console.warn('加载关注统计失败:', e);
    }
  },

  onGoFollowList(e) {
    const { type } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/follow-list/follow-list?type=${type}` });
  },

  onGoSettings() {
    wx.navigateTo({ url: '/pages/settings/settings' });
  },

  /* ══════ 互动数据 ══════ */
  async loadInteractionStats() {
    try {
      const stats = await cloud.getMyMomentStats();
      this.setData({ interactionStats: stats });
      this.computeBadges();
    } catch (e) {
      console.warn('加载互动统计失败:', e);
    }
  },

  /* ══════ 资料完整度 ══════ */
  computeProfileCompleteness() {
    const u = this.data.userInfo;
    const items = [
      { filled: !!(u.avatarUrl), weight: 30, hint: '上传头像' },
      { filled: !!(u.nickName), weight: 30, hint: '设置昵称' },
      { filled: !!(u.signature), weight: 20, hint: '写一句个性签名' },
      { filled: !!(u.publicId), weight: 20, hint: '设置 6 位 ID' }
    ];
    const score = items.reduce((s, i) => s + (i.filled ? i.weight : 0), 0);
    const firstHint = items.find(i => !i.filled);
    this.setData({
      profileCompleteness: score,
      completenessHint: score >= 100 ? '资料完整 ✨' : `完善资料 +${100 - score}% · ${firstHint ? firstHint.hint : ''}`
    });
  },

  /* ══════ 徽章系统 ══════ */
  computeBadges() {
    const d = this.data;
    const defs = cloud.BADGE_DEFS;
    const badges = defs.map(b => ({
      ...b,
      earned: b.check(d),
      wearing: b.id === d.wornBadgeId
    }));
    const earnedBadgeCount = badges.filter(b => b.earned).length;
    const wornDef = defs.find(b => b.id === d.wornBadgeId);
    const wornBadgeIcon = wornDef ? wornDef.icon : '';
    this.setData({ badges, earnedBadgeCount, wornBadgeIcon });
  },

  async onBadgeTap(e) {
    const { id, earned } = e.currentTarget.dataset;
    if (!earned) {
      wx.showToast({ title: '尚未达成，继续努力吧', icon: 'none' });
      return;
    }
    const badge = await cloud.getBadgeById(id);
    if (!badge) return;
    // 如果已佩戴同一枚，取下
    const newBadgeId = this.data.wornBadgeId === id ? '' : id;
    try {
      await cloud.setWornBadge(newBadgeId);
      this.setData({ wornBadgeId: newBadgeId });
      this.computeBadges();
      const app = getApp();
      if (app.globalData.userInfo) {
        app.globalData.userInfo.wornBadge = newBadgeId;
      }
      wx.showToast({
        title: newBadgeId ? `已佩戴「${badge.name}」` : '已取下徽章',
        icon: 'success'
      });
    } catch (err) {
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  onGoMood() {
    const { mood } = this.data;
    const emoji = mood ? encodeURIComponent(mood.emoji) : '';
    const text = mood ? encodeURIComponent(mood.text) : '';
    wx.navigateTo({
      url: `/pages/mood-picker/mood-picker?emoji=${emoji}&text=${text}`,
      fail: (error) => {
        console.error('打开状态设置失败:', error);
        wx.showToast({ title: '暂时无法修改状态', icon: 'none' });
      }
    });
  },

  onGoMyMoments() {
    wx.navigateTo({ url: '/pages/my-moments/my-moments' });
  },

  preventBubble() {},

  /* ══════ 行李清单摘要 ══════ */
  packingStats(items) {
    const checked = items.filter(i => i.checked).length;
    const total = items.length;
    const pct = total > 0 ? Math.round(checked / total * 100) : 0;
    return { packingChecked: checked, packingPercentText: pct + '%' };
  },

  async loadPackingList() {
    try {
      const items = await cloud.getMyPacking();
      const catOrder = ['clothing', 'toiletries', 'electronics', 'documents', 'medicine', 'other'];
      items.sort((a, b) => {
        const ca = catOrder.indexOf(a.category || 'other');
        const cb = catOrder.indexOf(b.category || 'other');
        return ca - cb;
      });
      this.setData({ packingItems: items, ...this.packingStats(items) });
    } catch (e) { console.warn('加载行李清单失败:', e); }
  },

  onGoLedger() {
    wx.navigateTo({ url: '/pages/ledger/ledger' });
  },

  onGoPackingList() {
    wx.navigateTo({ url: '/pages/packing-list/packing-list' });
  },
});
