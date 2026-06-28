const cloud = require('../../utils/cloud');
const theme = require('../../utils/theme');

Page({
  data: {
    themeStyle: '',
    themeClass: 'theme-blue',
    userInfo: {},
    isPasswordUser: false,
    oldPassword: '',
    newPassword: '',
    confirmPassword: '',
    saving: false,
    sessions: [],
    sessionsLoading: false
  },

  onLoad() {
    const app = getApp();
    const userInfo = (app && app.globalData && app.globalData.userInfo) || {};
    const accountType = (app && app.globalData && app.globalData.accountType) || 'wechat';
    // 有 username 即为密码用户（无论是本次用密码登录还是微信登录）
    const isPasswordUser = !!(userInfo.username) || accountType === 'password';
    this.setData({ userInfo, isPasswordUser });
    if (cloud.getSessionToken()) this.loadSessions();
  },

  onShow() {
    theme.applyToPage(this);
  },

  async loadSessions() {
    this.setData({ sessionsLoading: true });
    try {
      const sessions = await cloud.listAccountSessions();
      this.setData({
        sessions: sessions.map(item => ({
          ...item,
          displayName: (item.device && item.device.name) || '未知设备',
          displayMeta: [item.device && item.device.system, cloud.formatDate(item.lastActiveAt)].filter(Boolean).join(' · ')
        }))
      });
    } catch (error) {
      console.warn('登录设备加载失败:', error);
    } finally {
      this.setData({ sessionsLoading: false });
    }
  },

  async onRevokeSession(e) {
    const sessionId = e.currentTarget.dataset.id;
    if (!sessionId) return;
    const modal = await wx.showModal({ title: '退出该设备', content: '该设备需要重新登录后才能继续使用。', confirmText: '退出', confirmColor: '#ef4444' });
    if (!modal.confirm) return;
    try {
      await cloud.revokeAccountSession(sessionId);
      await this.loadSessions();
      wx.showToast({ title: '设备已退出', icon: 'success' });
    } catch (error) {
      wx.showToast({ title: error.message || '操作失败', icon: 'none' });
    }
  },

  async onRevokeOthers() {
    const others = this.data.sessions.filter(item => !item.current);
    if (!others.length) return;
    const modal = await wx.showModal({ title: '退出其他设备', content: `将退出其他 ${others.length} 台设备，确定继续吗？`, confirmText: '全部退出', confirmColor: '#ef4444' });
    if (!modal.confirm) return;
    try {
      const count = await cloud.revokeOtherAccountSessions();
      await this.loadSessions();
      wx.showToast({ title: `已退出 ${count} 台设备`, icon: 'success' });
    } catch (error) {
      wx.showToast({ title: error.message || '操作失败', icon: 'none' });
    }
  },

  onOldPasswordInput(e) {
    this.setData({ oldPassword: e.detail.value });
  },

  onNewPasswordInput(e) {
    this.setData({ newPassword: e.detail.value });
  },

  onConfirmPasswordInput(e) {
    this.setData({ confirmPassword: e.detail.value });
  },

  onCopyId() {
    const publicId = this.data.userInfo.publicId;
    if (!publicId) return;
    wx.setClipboardData({
      data: String(publicId),
      success: () => wx.showToast({ title: 'ID 已复制', icon: 'success' })
    });
  },

  async onChangePassword() {
    if (this.data.saving) return;

    const oldPassword = this.data.oldPassword;
    const newPassword = this.data.newPassword;
    const confirmPassword = this.data.confirmPassword;

    if (!oldPassword) return wx.showToast({ title: '请输入旧密码', icon: 'none' });
    if (!newPassword) return wx.showToast({ title: '请输入新密码', icon: 'none' });
    if (newPassword.length < 6) return wx.showToast({ title: '新密码至少 6 位', icon: 'none' });
    if (newPassword === oldPassword) return wx.showToast({ title: '新密码不能与旧密码相同', icon: 'none' });
    if (newPassword !== confirmPassword) return wx.showToast({ title: '两次密码不一致', icon: 'none' });

    this.setData({ saving: true });
    wx.showLoading({ title: '保存中...', mask: true });

    try {
      await cloud.changePassword(oldPassword, newPassword);
      wx.hideLoading();
      wx.showToast({ title: '密码已修改', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 800);
    } catch (e) {
      wx.hideLoading();
      wx.showModal({
        title: '修改失败',
        content: e.message || '请稍后重试',
        showCancel: false,
        confirmText: '好的'
      });
    }
    this.setData({ saving: false });
  }
});
