const cloud = require('../../utils/cloud');
const theme = require('../../utils/theme');

const DEFAULT_PRIVACY = {
  allowProfileView: true,
  allowPrivateMessage: true,
  defaultMomentPrivate: false,
  hideReadReceipts: false,
  showMoodStatus: true
};

const COLOR_PALETTE = [
  // 蓝色系
  '#3b82f6', '#2563eb', '#1d4ed8', '#0ea5e9', '#06b6d4', '#38bdf8',
  // 紫色系
  '#8b5cf6', '#7c3aed', '#6d28d9', '#a855f7', '#c084fc', '#d946ef',
  // 暖色系
  '#f97316', '#ea580c', '#ef4444', '#dc2626', '#f59e0b', '#eab308',
  // 绿/粉/其他
  '#10b981', '#059669', '#14b8a6', '#ec4899', '#6366f1', '#84cc16',
  // 中性/暗色
  '#64748b', '#475569', '#334155', '#1e293b', '#0f172a', '#78716c'
];

const COLOR_KEY_LABELS = {
  primary: '主色',
  deep: '深色',
  start: '起点',
  end: '终点'
};

Page({
  data: {
    privacySettings: { ...DEFAULT_PRIVACY },
    showBadge: true,
    saving: false,
    loading: true,
    themeChoices: [
      ...Object.values(theme.BUILTIN_THEMES),
      { id: 'diy', name: '我的 DIY', desc: '用自己的颜色做一套主题', primary: theme.DEFAULT_DIY.primary, deep: theme.DEFAULT_DIY.deep, start: theme.DEFAULT_DIY.start, end: theme.DEFAULT_DIY.end }
    ],
    accentPresets: theme.ACCENT_PRESETS,
    themeId: 'blue',
    themeStyle: '',
    themeClass: 'theme-blue',
    themePrimary: '#5b9ff5',
    themeName: '浅蓝玻璃',
    diyColors: { ...theme.DEFAULT_DIY },
    // DIY 颜色选择器
    colorPalette: COLOR_PALETTE,
    activeColorKey: 'primary',
    diyPreviewStyle: '',
    colorKeyLabels: COLOR_KEY_LABELS
  },

  onShow() {
    this.applyThemeState();
    this.loadSettings();
  },

  applyThemeState() {
    const state = theme.getThemeState();
    this.setData({
      ...state,
      diyColors: { ...theme.DEFAULT_DIY, ...((state.themeConfig && state.themeConfig.diy) || {}) }
    });
    this.updateDiyPreview();
  },

  async loadSettings() {
    try {
      const openid = await cloud.getOpenid();
      const user = await cloud.getUserProfile(openid);
      const privacySettings = {
        ...DEFAULT_PRIVACY,
        ...((user && user.privacySettings) || {})
      };
      const showBadge = user && user.showBadge !== undefined ? user.showBadge : true;
      this.setData({ privacySettings, showBadge, loading: false });
    } catch (e) {
      console.warn('加载设置失败:', e);
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  onGoEditProfile() {
    wx.navigateTo({ url: '/pages/edit-profile/edit-profile' });
  },

  onGoAccountSecurity() {
    wx.navigateTo({ url: '/pages/account-security/account-security' });
  },

  onSelectTheme(e) {
    const id = e.currentTarget.dataset.id || 'blue';
    const config = theme.saveThemeConfig({
      id,
      diy: this.data.diyColors
    });
    const current = theme.getTheme(config);
    this.setData({
      themeConfig: config,
      themeId: config.id,
      themeClass: `theme-${config.id}`,
      themeStyle: theme.buildThemeStyle(config),
      themePrimary: current.primary,
      themeName: current.name
    });
    wx.showToast({ title: `已切换到${current.name}`, icon: 'none' });
  },

  onSelectAccent(e) {
    const preset = this.data.accentPresets.find(item => item.id === e.currentTarget.dataset.id);
    if (!preset) return;
    const diyColors = {
      primary: preset.primary,
      deep: preset.deep,
      start: preset.start,
      end: preset.end
    };
    const config = theme.saveThemeConfig({ id: 'diy', diy: diyColors });
    const current = theme.getTheme(config);
    this.setData({
      diyColors,
      themeConfig: config,
      themeId: 'diy',
      themeClass: 'theme-diy',
      themeStyle: theme.buildThemeStyle(config),
      themePrimary: current.primary,
      themeName: current.name
    });
    this.updateDiyPreview();
    wx.showToast({ title: `已套用${preset.name}`, icon: 'none' });
  },

  onDiyColorInput(e) {
    const key = e.currentTarget.dataset.key;
    if (!key) return;
    const value = e.detail.value;
    this.setData({ [`diyColors.${key}`]: value });
    this.updateDiyPreview();
  },

  // 选择要编辑的颜色槽位
  onSelectColorKey(e) {
    const key = e.currentTarget.dataset.key;
    if (!key) return;
    this.setData({ activeColorKey: key });
  },

  // 从色板选择颜色
  onSelectPaletteColor(e) {
    const color = e.currentTarget.dataset.color;
    if (!color) return;
    const key = this.data.activeColorKey;
    this.setData({ [`diyColors.${key}`]: color });
    this.updateDiyPreview();
  },

  // 实时预览 DIY 主题效果
  updateDiyPreview() {
    const diyColors = {
      primary: theme.normalizeHex(this.data.diyColors.primary, theme.DEFAULT_DIY.primary),
      deep: theme.normalizeHex(this.data.diyColors.deep, theme.DEFAULT_DIY.deep),
      start: theme.normalizeHex(this.data.diyColors.start, theme.DEFAULT_DIY.start),
      end: theme.normalizeHex(this.data.diyColors.end, theme.DEFAULT_DIY.end)
    };
    const previewStyle = [
      `--preview-primary:${diyColors.primary}`,
      `--preview-deep:${diyColors.deep}`,
      `--preview-start:${diyColors.start}`,
      `--preview-end:${diyColors.end}`,
      `--preview-gradient:linear-gradient(135deg, ${diyColors.start}, ${diyColors.primary}, ${diyColors.end})`
    ].join(';');
    this.setData({ diyPreviewStyle: previewStyle });
  },

  onApplyDiy() {
    const diyColors = {
      primary: theme.normalizeHex(this.data.diyColors.primary, theme.DEFAULT_DIY.primary),
      deep: theme.normalizeHex(this.data.diyColors.deep, theme.DEFAULT_DIY.deep),
      start: theme.normalizeHex(this.data.diyColors.start, theme.DEFAULT_DIY.start),
      end: theme.normalizeHex(this.data.diyColors.end, theme.DEFAULT_DIY.end)
    };
    const config = theme.saveThemeConfig({ id: 'diy', diy: diyColors });
    const current = theme.getTheme(config);
    this.setData({
      diyColors,
      themeConfig: config,
      themeId: 'diy',
      themeClass: 'theme-diy',
      themeStyle: theme.buildThemeStyle(config),
      themePrimary: current.primary,
      themeName: current.name
    });
    this.updateDiyPreview();
    wx.showToast({ title: 'DIY 主题已保存', icon: 'success' });
  },

  async onPrivacySwitch(e) {
    const key = e.currentTarget.dataset.key;
    if (!key) return;
    const invertValue = e.currentTarget.dataset.invert;
    const invert = invertValue === true || invertValue === 'true';
    const checked = e.detail.value === true;
    const value = invert ? !checked : checked;
    const previousValue = this.data.privacySettings[key];
    const privacySettings = {
      ...this.data.privacySettings,
      [key]: value
    };
    this.setData({ [`privacySettings.${key}`]: value, saving: true });
    try {
      await cloud.updateUserSettings({ privacySettings });
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (err) {
      this.setData({ [`privacySettings.${key}`]: previousValue });
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
    this.setData({ saving: false });
  },

  async onShowBadgeSwitch(e) {
    const showBadge = e.detail.value === true;
    const previousValue = this.data.showBadge;
    this.setData({ showBadge, saving: true });
    try {
      await cloud.updateShowBadge(showBadge);
      // 同步到 globalData
      const app = getApp();
      if (app.globalData.userInfo) {
        app.globalData.userInfo.showBadge = showBadge;
      }
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (err) {
      this.setData({ showBadge: previousValue });
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
    this.setData({ saving: false });
  },

  onAbout() {
    wx.showModal({
      title: '关于拾途 ST',
      content: '拾起沿途的计划、故事与同行的人。',
      showCancel: false,
      confirmText: '好的'
    });
  },

  onLogout() {
    wx.showModal({
      title: '退出账号',
      content: '退出后将清除所有本地数据，返回欢迎页。你的云端数据（行程、动态等）不会丢失。',
      confirmText: '确定退出',
      confirmColor: '#ef4444',
      cancelText: '取消',
      success: async (res) => {
        if (!res.confirm) return;
        // 注销服务端 session
        try {
          await wx.cloud.callFunction({
            name: 'accountOps',
            data: { action: 'logout', _sessionToken: cloud.getSessionToken() }
          });
        } catch (_) { /* best effort */ }
        // 清除本地 session 和缓存（精准清除，保留 wishCities 等非敏感数据）
        cloud.clearSessionToken();
        cloud.setOpenid('');
        wx.removeStorageSync('_sessionToken');
        wx.removeStorageSync('_cachedAccountOpenid');
        wx.removeStorageSync('onboarding_completed');
        // 清空 globalData
        const app = getApp();
        if (app.stopGlobalInboxWatch) app.stopGlobalInboxWatch();
        if (app.stopGlobalUnreadLoop) app.stopGlobalUnreadLoop();
        if (app.globalData) {
          app.globalData.openid = '';
          app.globalData.loggedIn = false;
          app.globalData.userInfo = null;
          app.globalData.needsOnboarding = true;
          app.globalData.accountType = 'wechat';
          app.globalData.unreadCount = 0;
          app.globalData._newMsgNotify = null;
          app.globalData._currentChatOpenid = '';
        }
        // 跳转到欢迎页
        wx.reLaunch({ url: '/pages/welcome/welcome' });
      }
    });
  },

  onTips() {
    wx.showModal({
      title: '旅行小贴士',
      content: '提前规划每日行程，公共开销记得选分摊人，旅途动态可以关联到具体日期。',
      showCancel: false,
      confirmText: '知道了'
    });
  }
});
