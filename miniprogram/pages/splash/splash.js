const theme = require('../../utils/theme');

Page({
  data: {
    themeStyle: '',
    themeClass: 'theme-blue',
    ready: false
  },

  onLoad() {
    this._waitAndGo();
  }

  onShow() {
    theme.applyToPage(this);
  },,

  async _waitAndGo() {
    const app = getApp();

    // 等待 app.onLaunch 完成（最长等 6 秒）
    for (let i = 0; i < 60; i++) {
      if (app.globalData._launchComplete) break;
      await new Promise(r => setTimeout(r, 100));
    }

    // 最短展示 1.2 秒，保证过渡不闪
    await new Promise(r => setTimeout(r, 1200));

    // 动画淡出
    this.setData({ ready: true });

    // 等动画跑完再跳转
    await new Promise(r => setTimeout(r, 350));

    const needsOnboarding = app.globalData.needsOnboarding;
    const loggedIn = app.globalData.loggedIn && app.globalData.userInfo && app.globalData.userInfo.nickName;

    if (needsOnboarding || !loggedIn) {
      wx.redirectTo({ url: '/pages/welcome/welcome' });
    } else {
      wx.switchTab({ url: '/pages/index/index' });
    }
  }
});
