const cloud = require('../../utils/cloud');

Page({
  data: {
    loading: true,
    conversations: [],
    groupConversations: [],
    filteredConversations: [],
    filteredGroupConversations: [],
    notifications: [],
    notificationCount: 0,
    searchKeyword: '',
    showMenu: false,
    friendRequestCount: 0,
    friendRequestText: ''
  },

  onLoad() {
    const snapshot = wx.getStorageSync('_conversationListSnapshot') || {};
    const openid = (getApp().globalData && getApp().globalData.openid) || wx.getStorageSync('_cachedAccountOpenid') || '';
    if (snapshot.openid && snapshot.openid === openid && (snapshot.conversations || snapshot.groupConversations)) {
      const conversations = snapshot.conversations || [];
      const groupConversations = snapshot.groupConversations || [];
      this._conversationSignature = snapshot.signature || '';
      this.setData({ conversations, groupConversations, loading: false }, () => this.applySearchFilter());
    }
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      const tabBar = this.getTabBar();
      tabBar.setData({ selected: 3 });
      if (tabBar.refreshUnread) tabBar.refreshUnread();
    }
    this.loadConversations(false);
    setTimeout(() => {
      this.loadFriendSummary();
      this.loadNotifications();
    }, 60);
    this.startWatch();
  },

  onHide() {
    this.stopWatch();
  },

  async onPullDownRefresh() {
    await this.loadConversations(true);
    wx.stopPullDownRefresh();
  },

  async loadConversations(force = false) {
    if (this._loadingConversations) {
      this._pendingConversationRefresh = this._pendingConversationRefresh || force;
      return;
    }
    this._loadingConversations = true;
    if (!this.data.conversations.length && !this.data.groupConversations.length) {
      this.setData({ loading: true });
    }
    try {
      const [result, groupResult] = await Promise.all([
        cloud.getPrivateConversations(force),
        cloud.getGroupConversations(force)
      ]);
      const localSettings = wx.getStorageSync('_privateChatSettings') || {};
      const conversations = (result.conversations || []).map(item => {
        const presence = this.formatPresence(item.lastActiveAt, result.serverNow);
        const settings = localSettings[item.targetOpenid] || {};
        return {
          ...item,
          displayName: item.nickName || '未设置',
          initials: (item.nickName || '?').slice(0, 1),
          previewText: item.lastText || '暂无消息',
          displayTime: cloud.formatDate(item.lastTime),
          statusText: presence.text,
          isOnline: presence.online,
          pinned: settings.pinned === true,
          muted: settings.muted === true,
          unreadText: item.unread > 99 ? '99+' : String(item.unread || '')
        };
      }).sort((a, b) => Number(b.pinned) - Number(a.pinned));
      const groupConversations = (groupResult || []).map(item => ({
        ...item,
        displayName: item.name || '群聊',
        previewText: item.lastMessage || '群聊已创建',
        displayTime: cloud.formatDate(item.lastMessageAt || item.updatedAt),
        unreadText: item.unread > 99 ? '99+' : String(item.unread || '')
      }));
      this.syncTabUnread();
      const signature = JSON.stringify({
        private: conversations.map(item => [item.conversationId, item.lastTime, item.unread, item.statusText, item.pinned, item.muted]),
        groups: groupConversations.map(item => [item._id, item.lastMessageAt, item.unread, item.myNotificationsMuted])
      });
      if (signature !== this._conversationSignature || this.data.loading) {
        this._conversationSignature = signature;
        this.setData({ conversations, groupConversations, loading: false }, () => this.applySearchFilter());
        const openid = (getApp().globalData && getApp().globalData.openid) || wx.getStorageSync('_cachedAccountOpenid') || '';
        wx.setStorage({
          key: '_conversationListSnapshot',
          data: { openid, conversations, groupConversations, signature, savedAt: Date.now() }
        });
      }
      this._lastConversationLoadAt = Date.now();
    } catch (e) {
      console.error('加载会话失败:', e);
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    } finally {
      this._loadingConversations = false;
      if (this._pendingConversationRefresh) {
        const pendingForce = this._pendingConversationRefresh;
        this._pendingConversationRefresh = false;
        this.loadConversations(pendingForce);
      }
    }
  },

  async startWatch() {
    this.stopWatch();
    try {
      const openid = await cloud.getOpenid();
      this._watchStartedAt = Date.now();
      this._messageWatchers = await cloud.watchMyInbox(openid, {
        onChange: () => {
          // 两个监听建立时都会返回初始快照；首屏已经主动加载，忽略这轮重复刷新。
          if (Date.now() - this._watchStartedAt < 700) return;
          if (this._conversationRefreshTimer) clearTimeout(this._conversationRefreshTimer);
          this._conversationRefreshTimer = setTimeout(() => this.loadConversations(true), 140);
        },
        onError: err => {
          console.warn('消息监听中断:', err);
          this.stopWatch();
        }
      });
    } catch (e) {
      console.warn('消息监听不可用:', e);
    }
  },

  stopWatch() {
    if (this._conversationRefreshTimer) {
      clearTimeout(this._conversationRefreshTimer);
      this._conversationRefreshTimer = null;
    }
    if (this._messageWatchers) {
      this._messageWatchers.forEach(w => {
        try { w.close(); } catch (_) {}
      });
      this._messageWatchers = null;
    }
  },

  async loadFriendSummary() {
    try {
      const center = await cloud.getFriendCenter();
      const friendRequestCount = (center.incoming || []).length;
      this.setData({
        friendRequestCount,
        friendRequestText: friendRequestCount > 99 ? '99+' : String(friendRequestCount || '')
      });
    } catch (e) {
      console.warn('加载好友申请数量失败:', e);
    }
  },

  async loadNotifications() {
    try {
      const result = await cloud.getNotifications();
      const notifications = (result.notifications || []).map(n => ({
        ...n,
        displayTime: cloud.formatDate(n.createdAt),
        previewText: n.type === 'like'
          ? `${n.fromNickName || '有人'} 赞了你的动态`
          : `${n.fromNickName || '有人'} 评论了你的动态：${n.text || ''}`
      }));
      this.setData({
        notifications,
        notificationCount: notifications.filter(n => !n.read).length
      });
    } catch (e) {
      console.warn('加载通知失败:', e);
    }
  },

  onOpenNotification(e) {
    const notif = this.data.notifications[e.currentTarget.dataset.index];
    if (!notif || !notif.momentId) return;
    // 标记已读
    cloud.markNotificationsRead().catch(() => {});
    wx.navigateTo({ url: `/pages/moment-detail/moment-detail?momentId=${notif.momentId}` });
  },

  onOpenGlobalSearch() {
    wx.navigateTo({ url: '/pages/global-search/global-search' });
  },

  onOpenNotificationCenter() {
    wx.navigateTo({ url: '/pages/notification-center/notification-center' });
  },

  onToggleMenu() {
    this.setData({ showMenu: !this.data.showMenu });
  },

  onCloseMenu() {
    this.setData({ showMenu: false });
  },

  preventBubble() {},

  onOpenFriendCenter(e) {
    const tab = e.currentTarget.dataset.tab || 'search';
    this.setData({ showMenu: false });
    wx.navigateTo({ url: `/pages/find-friends/find-friends?tab=${tab}` });
  },

  onCreateGroup() {
    this.setData({ showMenu: false });
    wx.navigateTo({ url: '/pages/create-group/create-group' });
  },

  onSearchInput(e) {
    this.setData({ searchKeyword: e.detail.value }, () => {
      this.applySearchFilter();
    });
  },

  onClearSearch() {
    this.setData({ searchKeyword: '' }, () => {
      this.applySearchFilter();
    });
  },

  applySearchFilter() {
    const keyword = (this.data.searchKeyword || '').trim().toLowerCase();
    const { conversations, groupConversations } = this.data;
    if (!keyword) {
      this.setData({
        filteredConversations: conversations,
        filteredGroupConversations: groupConversations
      });
      return;
    }
    this.setData({
      filteredConversations: conversations.filter(c =>
        (c.displayName || '').toLowerCase().includes(keyword) ||
        (c.previewText || '').toLowerCase().includes(keyword)
      ),
      filteredGroupConversations: groupConversations.filter(g =>
        (g.displayName || '').toLowerCase().includes(keyword) ||
        (g.previewText || '').toLowerCase().includes(keyword)
      )
    });
  },

  async syncTabUnread() {
    if (typeof this.getTabBar !== 'function' || !this.getTabBar()) return;
    try {
      const summary = await cloud.getUnreadSummary();
      const total = (summary.unreadMessages || 0) + (summary.unreadGroupMessages || 0) + (summary.pendingFriendRequests || 0) + (summary.unreadNotifications || 0);
      const tabBar = this.getTabBar();
      if (tabBar.setUnreadCount) tabBar.setUnreadCount(total);
    } catch (e) {
      console.warn('同步未读计数失败:', e);
    }
  },

  formatPresence(lastActiveAt, serverNow) {
    if (!lastActiveAt) return { text: '离线', online: false };
    const last = new Date(lastActiveAt).getTime();
    const now = new Date(serverNow || Date.now()).getTime();
    if (!last || !now) return { text: '离线', online: false };
    const diff = now - last;
    if (diff <= 5 * 60 * 1000) return { text: '在线', online: true };
    if (diff <= 60 * 60 * 1000) return { text: `${Math.max(1, Math.floor(diff / 60000))}分钟前在线`, online: false };
    if (diff <= 24 * 60 * 60 * 1000) return { text: `${Math.floor(diff / 3600000)}小时前在线`, online: false };
    return { text: '离线', online: false };
  },

  onOpenProfile(e) {
    const { openid, nickname, avatar } = e.currentTarget.dataset;
    if (!openid) return;
    cloud.navigateToUserProfile(openid, { nickName: nickname, avatarUrl: avatar });
  },

  onOpenGroupProfile(e) {
    const { groupId } = e.currentTarget.dataset;
    if (!groupId) return;
    const item = this.data.groupConversations.find(g => g._id === groupId);
    wx.navigateTo({
      url: `/pages/group-chat/group-chat?groupId=${encodeURIComponent(groupId)}&name=${encodeURIComponent(item && item.name || '群聊')}`
    });
  },

  onOpenChat(e) {
    const { openid, nickname, avatar } = e.currentTarget.dataset;
    if (!openid) return;
    const url = `/pages/private-chat/private-chat?openid=${encodeURIComponent(openid)}&nickName=${encodeURIComponent(nickname || '')}&avatarUrl=${encodeURIComponent(avatar || '')}`;
    wx.navigateTo({ url });
  },

  onOpenGroupChat(e) {
    const { groupId } = e.currentTarget.dataset;
    if (!groupId) return;
    // 从原始列表查找名称
    const item = this.data.groupConversations.find(g => g._id === groupId);
    wx.navigateTo({
      url: `/pages/group-chat/group-chat?groupId=${encodeURIComponent(groupId)}&name=${encodeURIComponent(item && item.name || '群聊')}`
    });
  }
});
