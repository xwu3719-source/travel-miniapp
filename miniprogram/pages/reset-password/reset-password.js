const cloud = require('../../utils/cloud');

Page({
  data: {
    step: 1,
    publicId: '',
    username: '',
    newPassword: '',
    confirmPassword: '',
    loading: false
  },

  onPublicIdInput(e) {
    this.setData({ publicId: e.detail.value });
  },

  onUsernameInput(e) {
    this.setData({ username: e.detail.value });
  },

  onNewPasswordInput(e) {
    this.setData({ newPassword: e.detail.value });
  },

  onConfirmPasswordInput(e) {
    this.setData({ confirmPassword: e.detail.value });
  },

  // Step 1 → 验证微信身份
  async onVerify() {
    if (this.data.loading) return;

    const publicId = this.data.publicId.trim();
    const username = this.data.username.trim();
    if (!/^\d{6}$/.test(publicId)) {
      return wx.showToast({ title: '请输入 6 位 ID', icon: 'none' });
    }
    if (!username) {
      return wx.showToast({ title: '请输入用户名', icon: 'none' });
    }

    this.setData({ loading: true });
    wx.showLoading({ title: '验证中...', mask: true });

    try {
      await cloud.verifyIdentity(publicId, username);
      wx.hideLoading();
      this.setData({ step: 2, loading: false });
    } catch (e) {
      wx.hideLoading();
      this.setData({ loading: false });
      wx.showModal({
        title: '验证失败',
        content: e.message || '请确认 ID 是否正确',
        showCancel: false,
        confirmText: '好的'
      });
    }
  },

  // Step 2 → 重置密码
  async onReset() {
    if (this.data.loading) return;

    const publicId = this.data.publicId.trim();
    const username = this.data.username.trim();
    const newPassword = this.data.newPassword;
    const confirmPassword = this.data.confirmPassword;

    if (!newPassword) return wx.showToast({ title: '请输入新密码', icon: 'none' });
    if (newPassword.length < 6) return wx.showToast({ title: '密码至少 6 位', icon: 'none' });
    if (newPassword !== confirmPassword) return wx.showToast({ title: '两次密码不一致', icon: 'none' });

    this.setData({ loading: true });
    wx.showLoading({ title: '重置中...', mask: true });

    try {
      await cloud.resetPassword(publicId, username, newPassword);
      wx.hideLoading();
      this.setData({ step: 3, loading: false });
    } catch (e) {
      wx.hideLoading();
      this.setData({ loading: false });
      wx.showModal({
        title: '重置失败',
        content: e.message || '请稍后重试',
        showCancel: false,
        confirmText: '好的'
      });
    }
  },

  // Step 3 → 返回登录
  onGoLogin() {
    wx.navigateBack();
  }
});
