const cloud = require('../../utils/cloud');
const theme = require('../../utils/theme');

Page({
  data: {
    themeStyle: '',
    themeClass: 'theme-blue',
    username: '',
    password: '',
    confirmPassword: '',
    loading: false
  },

  onShow() {
    theme.applyToPage(this);
  },

  onUsernameInput(e) {
    this.setData({ username: e.detail.value });
  },

  onPasswordInput(e) {
    this.setData({ password: e.detail.value });
  },

  onConfirmPasswordInput(e) {
    this.setData({ confirmPassword: e.detail.value });
  },

  async onRegister() {
    if (this.data.loading) return;

    const username = this.data.username.trim();
    const password = this.data.password;
    const confirmPassword = this.data.confirmPassword;

    // 客户端校验
    if (!username) return wx.showToast({ title: '请输入用户名', icon: 'none' });
    if (username.length < 3) return wx.showToast({ title: '用户名至少3位', icon: 'none' });
    if (!/^[a-zA-Z0-9_一-龥]+$/.test(username)) {
      return wx.showToast({ title: '用户名格式不正确', icon: 'none' });
    }
    if (!password) return wx.showToast({ title: '请输入密码', icon: 'none' });
    if (password.length < 6) return wx.showToast({ title: '密码至少6位', icon: 'none' });
    if (password !== confirmPassword) return wx.showToast({ title: '两次密码不一致', icon: 'none' });

    this.setData({ loading: true });
    wx.showLoading({ title: '注册中...', mask: true });

    try {
      const user = await cloud.registerWithPassword(username, password);
      wx.hideLoading();

      // 告知用户系统分配的 ID，用于后续登录
      wx.showModal({
        title: '注册成功',
        content: `你的ID为 ${user.publicId}，请牢记，后续使用ID+密码登录。`,
        showCancel: false,
        confirmText: '知道了',
        success: () => {
          wx.redirectTo({ url: '/pages/setup-profile/setup-profile' });
        }
      });
    } catch (e) {
      wx.hideLoading();
      console.error('注册失败:', e);
      const msg = e.message || '注册失败';
      wx.showModal({
        title: '注册失败',
        content: msg,
        showCancel: false,
        confirmText: '好的'
      });
    }
    this.setData({ loading: false });
  },

  onGoLogin() {
    wx.navigateBack();
  }
});
