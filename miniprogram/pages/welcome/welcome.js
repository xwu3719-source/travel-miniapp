const cloud = require('../../utils/cloud');
const theme = require('../../utils/theme');

Page({
  data: {
    themeStyle: '',
    themeClass: 'theme-blue',
    activeTab: 'account',
    publicId: '',
    password: '',
    loading: false,
    wechatLoading: false,
    wechatAvatarUrl: '',
    wechatNickName: ''
  },

  onLoad() {
    // splash 页已处理登录态检测，这里直接展示登录表单
    if (this.data.activeTab === 'wechat' && !this.data.wechatAvatarUrl) {
      this._fetchWechatProfile();
    }
  },

  onShow() {
    theme.applyToPage(this);
  },

  onSwitchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ activeTab: tab });
    if (tab === 'wechat' && !this.data.wechatAvatarUrl) {
      this._fetchWechatProfile();
    }
  },

  _fetchWechatProfile() {
    // 尝试获取微信头像和昵称
    wx.getSetting({
      success: (settingRes) => {
        if (settingRes.authSetting['scope.userInfo']) {
          wx.getUserInfo({
            success: (res) => {
              this.setData({
                wechatAvatarUrl: res.userInfo.avatarUrl || '',
                wechatNickName: res.userInfo.nickName || ''
              });
            },
            fail: () => {}
          });
        }
      },
      fail: () => {}
    });
  },

  onPublicIdInput(e) {
    this.setData({ publicId: e.detail.value });
  },

  onPasswordInput(e) {
    this.setData({ password: e.detail.value });
  },

  // 账号ID+密码登录
  async onAccountLogin() {
    if (this.data.loading) return;

    const publicId = this.data.publicId.trim();
    const password = this.data.password;

    if (!publicId) return wx.showToast({ title: '请输入ID', icon: 'none' });
    if (!/^\d{6}$/.test(publicId)) return wx.showToast({ title: 'ID为6位数字', icon: 'none' });
    if (!password) return wx.showToast({ title: '请输入密码', icon: 'none' });

    this.setData({ loading: true });
    wx.showLoading({ title: '登录中...', mask: true });

    try {
      const user = await cloud.loginWithPassword(publicId, password);
      wx.hideLoading();

      // 判断是否需要设置资料
      if (user.nickName && user.nickName.trim()) {
        // 已有资料 → 直接进主页
        const app = getApp();
        if (app.globalData) app.globalData.needsOnboarding = false;
        wx.setStorageSync('onboarding_completed', true);
        wx.switchTab({ url: '/pages/index/index' });
      } else {
        // 新用户 → 设置资料
        wx.redirectTo({ url: '/pages/setup-profile/setup-profile' });
      }
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.message || '登录失败', icon: 'none' });
    }
    this.setData({ loading: false });
  },

  // 微信一键登录
  async onWechatLogin() {
    if (this.data.wechatLoading) return;

    this.setData({ wechatLoading: true });
    wx.showLoading({ title: '登录中...', mask: true });

    try {
      // 直接调 login 云函数拿最新用户数据，不依赖缓存
      const res = await wx.cloud.callFunction({ name: 'login' });
      wx.hideLoading();

      if (!res || !res.result || !res.result.openid) {
        throw new Error('登录失败');
      }

      const { openid, nickName, avatarUrl, publicId, username } = res.result;
      cloud.setOpenid(openid);

      const app = getApp();
      if (app.globalData) {
        app.globalData.openid = openid;
        app.globalData.loggedIn = true;
        app.globalData.userInfo = {
          nickName: nickName || '',
          avatarUrl: avatarUrl || '',
          publicId: publicId || '',
          username: username || ''
        };
        app.globalData.accountType = username ? 'password' : 'wechat';
      }

      const hasProfile = nickName && nickName.trim();
      if (hasProfile) {
        if (app.globalData) app.globalData.needsOnboarding = false;
        wx.setStorageSync('onboarding_completed', true);
        wx.switchTab({ url: '/pages/index/index' });
      } else {
        wx.redirectTo({ url: '/pages/setup-profile/setup-profile' });
      }
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: '微信登录失败，请尝试账号登录', icon: 'none' });
    }
    this.setData({ wechatLoading: false });
  },

  onGoRegister() {
    wx.navigateTo({ url: '/pages/register/register' });
  },

  onForgotPassword() {
    wx.navigateTo({ url: '/pages/reset-password/reset-password' });
  }
});
