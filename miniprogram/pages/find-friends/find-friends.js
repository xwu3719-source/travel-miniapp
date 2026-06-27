const cloud = require('../../utils/cloud');

Page({
  data: {
    activeTab: 'search',
    myPublicId: '',
    query: '',
    result: null,
    resultFriend: { status: 'none', requestId: '' },
    incoming: [],
    friends: [],
    loading: true,
    searching: false
  },

  onLoad(options) {
    const tab = ['search', 'requests', 'friends'].includes(options.tab) ? options.tab : 'search';
    this.setData({ activeTab: tab });
  },

  onShow() {
    this.loadAll();
  },

  async loadAll() {
    try {
      const openid = await cloud.getOpenid();
      const [profile, center] = await Promise.all([
        cloud.getUserProfile(openid),
        cloud.getFriendCenter()
      ]);
      this.setData({
        myPublicId: (profile && profile.publicId) || '',
        incoming: center.incoming || [],
        friends: center.friends || [],
        loading: false
      });
    } catch (e) {
      console.error('加载好友中心失败:', e);
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  onInput(e) {
    this.setData({ query: String(e.detail.value || '').replace(/\D/g, '').slice(0, 6) });
  },

  onTabSelect(e) {
    const activeTab = e.currentTarget.dataset.tab;
    if (['search', 'requests', 'friends'].includes(activeTab)) this.setData({ activeTab });
  },

  async onSearch() {
    const query = this.data.query.trim();
    if (!/^\d{6}$/.test(query)) return wx.showToast({ title: '请输入 6 位数字 ID', icon: 'none' });
    this.setData({ searching: true, result: null });
    try {
      const result = await cloud.searchUserByPublicId(query);
      this.setData({ result: result.user || null, resultFriend: result.friend || { status: 'none', requestId: '' } });
      if (!result.user) wx.showToast({ title: '没有找到该用户', icon: 'none' });
    } catch (e) {
      wx.showToast({ title: e.message || '搜索失败', icon: 'none' });
    } finally {
      this.setData({ searching: false });
    }
  },

  async onAddResult() {
    const { result, resultFriend } = this.data;
    if (!result || resultFriend.status === 'self' || resultFriend.status === 'friends' || resultFriend.status === 'outgoing') return;
    try {
      const friend = await cloud.sendFriendRequest(result.openid);
      this.setData({ resultFriend: friend });
      wx.showToast({ title: friend.status === 'friends' ? '已成为好友' : '申请已发送', icon: 'success' });
      this.loadAll();
    } catch (e) {
      wx.showToast({ title: e.message || '发送失败', icon: 'none' });
    }
  },

  async onRespond(e) {
    const { requestId, accept } = e.currentTarget.dataset;
    try {
      await cloud.respondFriendRequest(requestId, accept === true || accept === 'true');
      wx.showToast({ title: accept === true || accept === 'true' ? '已添加好友' : '已拒绝', icon: 'success' });
      await this.loadAll();
    } catch (err) {
      wx.showToast({ title: err.message || '操作失败', icon: 'none' });
    }
  },

  onCopyMyId() {
    if (!this.data.myPublicId) return;
    wx.setClipboardData({ data: this.data.myPublicId });
  },

  onOpenProfile(e) {
    const { openid, nickname, avatar } = e.currentTarget.dataset;
    cloud.navigateToUserProfile(openid, { nickName: nickname || '', avatarUrl: avatar || '' });
  },

  onOpenChat(e) {
    const { openid, nickname, avatar } = e.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/private-chat/private-chat?openid=${encodeURIComponent(openid)}&nickName=${encodeURIComponent(nickname || '')}&avatarUrl=${encodeURIComponent(avatar || '')}`
    });
  }
});
