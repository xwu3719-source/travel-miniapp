const cloud = require('../../utils/cloud');
const theme = require('../../utils/theme');

const TABS = [
  { key: 'all', label: '全部' },
  { key: 'unread', label: '未读' },
  { key: 'like', label: '赞' },
  { key: 'comment', label: '评论' }
];

Page({
  data: {
    themeStyle: '',
    themeClass: 'theme-blue',
    tabs: TABS,
    activeTab: 'all',
    notifications: [],
    filtered: [],
    loading: true,
    unreadCount: 0,
    unreadSummary: { unreadMessages: 0, unreadGroupMessages: 0, pendingFriendRequests: 0, unreadNotifications: 0 },
    inboxCards: []
  },

  onShow() {
    theme.applyToPage(this);
    this.loadNotifications();
  },

  async onPullDownRefresh() {
    await this.loadNotifications(true);
    wx.stopPullDownRefresh();
  },

  async loadNotifications(force = false) {
    this.setData({ loading: true });
    try {
      const [result, unreadSummary] = await Promise.all([
        cloud.getNotifications(force),
        cloud.getUnreadSummary().catch(() => ({}))
      ]);
      const normalizedUnread = {
        unreadMessages: Number(unreadSummary.unreadMessages) || 0,
        unreadGroupMessages: Number(unreadSummary.unreadGroupMessages) || 0,
        pendingFriendRequests: Number(unreadSummary.pendingFriendRequests) || 0,
        unreadNotifications: Number(unreadSummary.unreadNotifications) || 0
      };
      const notifications = (result.notifications || []).map(item => ({
        ...item,
        displayTime: cloud.formatDate(item.createdAt),
        title: item.type === 'like' ? `${item.fromNickName || '有人'}赞了你的动态` : `${item.fromNickName || '有人'}评论了你的动态`,
        detail: item.text || item.momentText || ''
      }));
      this.setData({
        notifications,
        unreadSummary: normalizedUnread,
        inboxCards: this.buildInboxCards(normalizedUnread),
        unreadCount: notifications.filter(item => !item.read).length,
        loading: false
      }, () => this.applyFilter());
    } catch (error) {
      this.setData({ loading: false });
      wx.showToast({ title: error.message || '通知加载失败', icon: 'none' });
    }
  },

  buildInboxCards(summary) {
    return [
      {
        key: 'messages',
        label: '消息',
        value: (summary.unreadMessages || 0) + (summary.unreadGroupMessages || 0),
        desc: '私信和群聊',
        icon: '/images/icons/tab-messages.png'
      },
      {
        key: 'friends',
        label: '好友申请',
        value: summary.pendingFriendRequests || 0,
        desc: '待处理请求',
        icon: '/images/icons/friend-requests.png'
      },
      {
        key: 'notifications',
        label: '互动通知',
        value: summary.unreadNotifications || 0,
        desc: '点赞和评论',
        icon: '/images/icons/comment.png'
      }
    ];
  },

  onTab(e) {
    this.setData({ activeTab: e.currentTarget.dataset.key }, () => this.applyFilter());
  },

  applyFilter() {
    const key = this.data.activeTab;
    const filtered = key === 'all' ? this.data.notifications : key === 'unread'
      ? this.data.notifications.filter(item => !item.read)
      : this.data.notifications.filter(item => item.type === key);
    this.setData({ filtered });
  },

  async onMarkAllRead() {
    if (!this.data.unreadCount) return;
    try {
      await cloud.markNotificationsRead();
      const notifications = this.data.notifications.map(item => ({ ...item, read: true }));
      this.setData({ notifications, unreadCount: 0 }, () => this.applyFilter());
      const app = getApp();
      if (app && app.refreshGlobalUnread) app.refreshGlobalUnread();
    } catch (error) {
      wx.showToast({ title: error.message || '操作失败', icon: 'none' });
    }
  },

  onInboxCardTap(e) {
    const key = e.currentTarget.dataset.key;
    if (key === 'messages') wx.switchTab({ url: '/pages/messages/messages' });
    else if (key === 'friends') wx.navigateTo({ url: '/pages/find-friends/find-friends' });
    else this.setData({ activeTab: 'unread' }, () => this.applyFilter());
  },

  async onOpen(e) {
    const item = this.data.filtered[e.currentTarget.dataset.index];
    if (!item) return;
    if (!item.read) {
      cloud.markNotificationRead(item._id).catch(() => {});
      item.read = true;
      this.setData({ unreadCount: Math.max(0, this.data.unreadCount - 1) });
    }
    if (item.momentId) wx.navigateTo({ url: `/pages/moment-detail/moment-detail?momentId=${encodeURIComponent(item.momentId)}` });
  }
});
