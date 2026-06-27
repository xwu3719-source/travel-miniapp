const cloud = require('../../utils/cloud');

const EMPTY_RESULTS = { contacts: [], chats: [], groups: [], ai: [], trips: [] };

Page({
  data: {
    keyword: '',
    searching: false,
    searched: false,
    results: EMPTY_RESULTS,
    total: 0
  },

  onUnload() {
    if (this._searchTimer) clearTimeout(this._searchTimer);
  },

  onInput(e) {
    const keyword = e.detail.value;
    this.setData({ keyword });
    if (this._searchTimer) clearTimeout(this._searchTimer);
    if (!keyword.trim()) {
      this.setData({ results: EMPTY_RESULTS, total: 0, searched: false, searching: false });
      return;
    }
    this._searchTimer = setTimeout(() => this.runSearch(), 280);
  },

  onClear() {
    this.setData({ keyword: '', results: EMPTY_RESULTS, total: 0, searched: false, searching: false });
  },

  async runSearch() {
    const keyword = this.data.keyword.trim();
    if (!keyword) return;
    this.setData({ searching: true });
    try {
      const results = await cloud.globalSearch(keyword);
      results.chats = (results.chats || []).map(item => ({ ...item, createdAt: cloud.formatDate(item.createdAt) }));
      results.groups = (results.groups || []).map(item => ({ ...item, createdAt: cloud.formatDate(item.createdAt) }));
      const total = Object.values(results).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
      this.setData({ results, total, searching: false, searched: true });
    } catch (error) {
      this.setData({ searching: false, searched: true });
      wx.showToast({ title: error.message || '搜索失败', icon: 'none' });
    }
  },

  onOpenContact(e) {
    const item = this.data.results.contacts[e.currentTarget.dataset.index];
    if (item) cloud.navigateToUserProfile(item.openid, { nickName: item.nickName, avatarUrl: item.avatarUrl });
  },

  onOpenChat(e) {
    const item = this.data.results.chats[e.currentTarget.dataset.index];
    if (!item) return;
    wx.navigateTo({
      url: `/pages/private-chat/private-chat?openid=${encodeURIComponent(item.targetOpenid)}&nickName=${encodeURIComponent(item.title || '')}&messageId=${encodeURIComponent(item.id || '')}`
    });
  },

  onOpenGroup(e) {
    const item = this.data.results.groups[e.currentTarget.dataset.index];
    if (!item) return;
    wx.navigateTo({ url: `/pages/group-chat/group-chat?groupId=${encodeURIComponent(item.groupId)}&name=${encodeURIComponent(item.title || '群聊')}` });
  },

  onOpenAi(e) {
    const item = this.data.results.ai[e.currentTarget.dataset.index];
    if (!item) return;
    wx.navigateTo({ url: `/pages/ai-search/ai-search?conversationId=${encodeURIComponent(item.id)}` });
  },

  onOpenTrip(e) {
    const item = this.data.results.trips[e.currentTarget.dataset.index];
    if (item) wx.navigateTo({ url: `/pages/trip-detail/trip-detail?tripId=${encodeURIComponent(item.id)}` });
  }
});
