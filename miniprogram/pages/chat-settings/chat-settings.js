const cloud = require('../../utils/cloud');

const STORAGE_KEY = '_privateChatSettings';

Page({
  data: {
    targetOpenid: '',
    profile: { nickName: '', avatarUrl: '', publicId: '' },
    following: false,
    friendStatus: 'none',
    friendStatusText: '',
    blocked: false,
    hiddenMoments: false,
    pinned: false,
    muted: false,
    showReadReceipts: true,
    loading: true,
    clearing: false
  },

  onLoad(options) {
    const safeDecode = value => {
      try { return decodeURIComponent(value || ''); } catch (_) { return value || ''; }
    };
    const targetOpenid = safeDecode(options.openid);
    const local = (wx.getStorageSync(STORAGE_KEY) || {})[targetOpenid] || {};
    this.setData({
      targetOpenid,
      profile: { nickName: safeDecode(options.nickName), avatarUrl: safeDecode(options.avatarUrl), publicId: '' },
      pinned: local.pinned === true,
      muted: local.muted === true
    });
    this.loadAll();
  },

  onUnload() {
    const pages = getCurrentPages();
    const privatePage = pages[pages.length - 2];
    if (privatePage && privatePage.setData) {
      privatePage.setData({
        blocked: this.data.blocked,
        hiddenMoments: this.data.hiddenMoments,
        friendStatus: this.data.friendStatus,
        showReadReceipts: this.data.showReadReceipts
      });
    }
  },

  async loadAll() {
    const { targetOpenid } = this.data;
    try {
      const [profile, relationship, preferences] = await Promise.all([
        cloud.getUserProfile(targetOpenid).catch(() => null),
        cloud.getSocialRelationship(targetOpenid).catch(() => ({ following: false, friend: { status: 'none' } })),
        cloud.getSocialPreferences().catch(() => ({ blockedOpenids: [], hiddenMomentOpenids: [], hiddenReadReceiptOpenids: [], visibleReadReceiptOpenids: [], hideReadReceipts: false }))
      ]);
      const friendStatus = (relationship.friend && relationship.friend.status) || 'none';
      const visibleReceiptOpenids = preferences.visibleReadReceiptOpenids || [];
      const hiddenReceiptOpenids = preferences.hiddenReadReceiptOpenids || [];
      const showReadReceipts = visibleReceiptOpenids.includes(targetOpenid)
        ? true
        : hiddenReceiptOpenids.includes(targetOpenid) ? false : preferences.hideReadReceipts !== true;
      const statusTextMap = { friends: '已是好友', outgoing: '好友申请已发送', incoming: '对方申请加你为好友' };
      this.setData({
        profile: {
          ...this.data.profile,
          nickName: (profile && profile.nickName) || this.data.profile.nickName,
          avatarUrl: (profile && profile.avatarUrl) || this.data.profile.avatarUrl,
          publicId: (profile && profile.publicId) || ''
        },
        following: relationship.following === true,
        friendStatus,
        friendStatusText: statusTextMap[friendStatus] || (relationship.following ? '已关注' : '未建立关系'),
        blocked: (preferences.blockedOpenids || []).includes(targetOpenid),
        hiddenMoments: (preferences.hiddenMomentOpenids || []).includes(targetOpenid),
        showReadReceipts,
        loading: false
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  saveLocalSetting(field, value) {
    const all = wx.getStorageSync(STORAGE_KEY) || {};
    all[this.data.targetOpenid] = { ...(all[this.data.targetOpenid] || {}), [field]: value };
    wx.setStorageSync(STORAGE_KEY, all);
    this.setData({ [field]: value });
  },

  onOpenProfile() {
    cloud.navigateToUserProfile(this.data.targetOpenid, this.data.profile);
  },

  onStartGroup() {
    if (this.data.friendStatus !== 'friends') return wx.showToast({ title: '成为好友后才能发起群聊', icon: 'none' });
    wx.navigateTo({ url: `/pages/create-group/create-group?memberOpenid=${encodeURIComponent(this.data.targetOpenid)}` });
  },

  onSearchHistory() {
    const { targetOpenid, profile } = this.data;
    wx.navigateTo({
      url: `/pages/message-search/message-search?openid=${encodeURIComponent(targetOpenid)}&nickName=${encodeURIComponent(profile.nickName || '')}`
    });
  },

  onOpenMedia() {
    wx.navigateTo({ url: `/pages/chat-media/chat-media?openid=${encodeURIComponent(this.data.targetOpenid)}` });
  },

  onPinnedChange(e) {
    this.saveLocalSetting('pinned', e.detail.value === true);
  },

  onMutedChange(e) {
    this.saveLocalSetting('muted', e.detail.value === true);
  },

  async onReadReceiptsChange(e) {
    const enabled = e.detail.value === true;
    this.setData({ showReadReceipts: enabled });
    try {
      await cloud.updateSocialPreference(this.data.targetOpenid, 'readReceipts', enabled);
      wx.showToast({ title: enabled ? '对方可看到已读状态' : '已隐藏已读状态', icon: 'success' });
    } catch (err) {
      this.setData({ showReadReceipts: !enabled });
      wx.showToast({ title: err.message || '操作失败', icon: 'none' });
    }
  },

  async onHiddenMomentsChange(e) {
    const enabled = e.detail.value === true;
    this.setData({ hiddenMoments: enabled });
    try {
      await cloud.updateSocialPreference(this.data.targetOpenid, 'hiddenMoments', enabled);
      wx.showToast({ title: enabled ? '已设为不看动态' : '已恢复查看动态', icon: 'success' });
    } catch (err) {
      this.setData({ hiddenMoments: !enabled });
      wx.showToast({ title: err.message || '操作失败', icon: 'none' });
    }
  },

  async onBlockedChange(e) {
    const enabled = e.detail.value === true;
    if (enabled) {
      const modal = await wx.showModal({
        title: '屏蔽好友',
        content: '屏蔽后双方无法继续私信，同时解除好友关系。',
        confirmColor: '#ef4444'
      });
      if (!modal.confirm) return this.setData({ blocked: false });
    }
    this.setData({ blocked: enabled });
    try {
      await cloud.updateSocialPreference(this.data.targetOpenid, 'blocked', enabled);
      this.setData({ friendStatus: enabled ? 'none' : this.data.friendStatus, friendStatusText: enabled ? '已屏蔽' : this.data.friendStatusText });
      wx.showToast({ title: enabled ? '已屏蔽' : '已取消屏蔽', icon: 'success' });
    } catch (err) {
      this.setData({ blocked: !enabled });
      wx.showToast({ title: err.message || '操作失败', icon: 'none' });
    }
  },

  async onToggleFollow() {
    try {
      const following = await cloud.toggleFollow('', this.data.targetOpenid);
      this.setData({ following });
      wx.showToast({ title: following ? '已关注' : '已取消关注', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: e.message || '操作失败', icon: 'none' });
    }
  },

  async onFriendAction() {
    try {
      if (this.data.friendStatus === 'none') {
        const friend = await cloud.sendFriendRequest(this.data.targetOpenid);
        this.setData({ friendStatus: friend.status || 'outgoing', friendStatusText: '好友申请已发送' });
        return wx.showToast({ title: '好友申请已发送', icon: 'success' });
      }
      if (this.data.friendStatus === 'incoming') {
        const center = await cloud.getFriendCenter();
        const request = (center.incoming || []).find(item => item.openid === this.data.targetOpenid);
        if (!request) throw new Error('未找到好友申请');
        await cloud.respondFriendRequest(request.requestId || request._id, true);
        this.setData({ friendStatus: 'friends', friendStatusText: '已是好友' });
        return wx.showToast({ title: '已添加好友', icon: 'success' });
      }
    } catch (e) {
      wx.showToast({ title: e.message || '操作失败', icon: 'none' });
    }
  },

  async onClearHistory() {
    if (this.data.clearing) return;
    const modal = await wx.showModal({
      title: '清空聊天记录',
      content: '聊天记录将仅从你的消息列表中删除，无法恢复。',
      confirmColor: '#ef4444'
    });
    if (!modal.confirm) return;
    this.setData({ clearing: true });
    wx.showLoading({ title: '正在清空' });
    try {
      const chat = await cloud.getPrivateChat(this.data.targetOpenid);
      const ids = (chat.messages || []).map(item => item._id).filter(Boolean);
      for (let i = 0; i < ids.length; i += 10) {
        await Promise.all(ids.slice(i, i + 10).map(id => cloud.hidePrivateMessage(id)));
      }
      const pages = getCurrentPages();
      const privatePage = pages[pages.length - 2];
      if (privatePage && privatePage.setData) privatePage.setData({ messages: [], scrollIntoView: '' });
      wx.hideLoading();
      wx.showToast({ title: '聊天记录已清空', icon: 'success' });
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.message || '清空失败', icon: 'none' });
    } finally {
      this.setData({ clearing: false });
    }
  },

  async onDeleteFriend() {
    const modal = await wx.showModal({ title: '删除好友', content: '删除后仍会保留聊天记录。', confirmColor: '#ef4444' });
    if (!modal.confirm) return;
    try {
      await cloud.deleteFriend(this.data.targetOpenid);
      this.setData({ friendStatus: 'none', friendStatusText: '未建立关系' });
      wx.showToast({ title: '已删除好友', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: e.message || '删除失败', icon: 'none' });
    }
  }
});
