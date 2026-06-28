const theme = require('../utils/theme');

Component({
  data: {
    selected: 0,
    unreadCount: 0,
    unreadText: '',
    themeStyle: '',
    themeClass: 'theme-blue',
    list: [
      { pagePath: '/pages/index/index', text: '行程', iconPath: '/images/icons/tab-trip.png' },
      { pagePath: '/pages/moments/moments', text: '动态', iconPath: '/images/icons/tab-moments.png' },
      { pagePath: '/pages/ai-search/ai-search', text: '', iconPath: '/images/icons/tab-ai.png', center: true, nav: true },
      { pagePath: '/pages/messages/messages', text: '消息', iconPath: '/images/icons/tab-messages.png' },
      { pagePath: '/pages/profile/profile', text: '我的', iconPath: '/images/icons/tab-profile.png' }
    ]
  },
  lifetimes: {
    attached() {
      const app = getApp();
      if (app && app.registerTabBar) app.registerTabBar(this);
      this.applyTheme();
    },

    detached() {
      const app = getApp();
      if (app && app.unregisterTabBar) app.unregisterTabBar(this);
    }
  },
  methods: {
    switchTab(e) {
      const idx = e.currentTarget.dataset.index;
      const item = this.data.list[idx];
      if (item.nav) {
        wx.navigateTo({ url: item.pagePath });
      } else {
        wx.switchTab({ url: item.pagePath });
      }
    },

    setUnreadCount(count) {
      const unreadCount = Math.max(0, Number(count) || 0);
      this.setData({
        unreadCount,
        unreadText: unreadCount > 99 ? '99+' : String(unreadCount)
      });
    },

    refreshUnread() {
      const app = getApp();
      if (app && app.refreshGlobalUnread) app.refreshGlobalUnread();
    },

    applyTheme() {
      this.setData(theme.getThemeState());
    }
  }
});
