const cloud = require('../../utils/cloud');

const CITY_LIST = [
  '北京', '上海', '广州', '深圳', '成都', '重庆', '杭州', '南京', '武汉', '西安',
  '长沙', '青岛', '大连', '厦门', '三亚', '昆明', '大理', '丽江', '拉萨', '桂林',
  '苏州', '无锡', '宁波', '福州', '珠海', '哈尔滨', '沈阳', '天津', '海口', '贵阳',
  '香港', '澳门', '台北', '郑州', '济南', '合肥', '南昌', '南宁', '乌鲁木齐', '兰州',
  '东京', '大阪', '京都', '北海道', '冲绳', '名古屋', '福冈',
  '首尔', '釜山', '济州岛',
  '曼谷', '清迈', '普吉岛', '苏梅岛', '芭提雅',
  '新加坡', '吉隆坡', '槟城', '沙巴',
  '胡志明市', '河内', '岘港', '芽庄',
  '暹粒', '金边',
  '巴厘岛',
  '长滩岛', '薄荷岛',
  '马尔代夫', '迪拜', '阿布扎比',
  '伊斯坦布尔', '卡帕多奇亚',
  '巴黎', '尼斯', '里昂',
  '罗马', '米兰', '威尼斯', '佛罗伦萨',
  '苏黎世', '日内瓦', '因特拉肯',
  '柏林', '慕尼黑', '法兰克福',
  '伦敦', '爱丁堡', '曼彻斯特',
  '巴塞罗那', '马德里', '塞维利亚',
  '里斯本', '波尔图',
  '阿姆斯特丹', '布鲁塞尔',
  '维也纳', '萨尔茨堡',
  '布拉格', '雅典', '圣托里尼',
  '雷克雅未克', '奥斯陆', '哥本哈根', '赫尔辛基',
  '莫斯科', '圣彼得堡',
  '纽约', '洛杉矶', '旧金山', '拉斯维加斯', '芝加哥', '西雅图', '波士顿',
  '多伦多', '温哥华', '蒙特利尔', '班夫',
  '坎昆',
  '悉尼', '墨尔本', '黄金海岸', '凯恩斯',
  '奥克兰', '皇后镇', '基督城',
  '斐济', '埃及', '摩洛哥', '肯尼亚', '南非', '开普敦',
  '日本', '韩国', '泰国', '越南', '柬埔寨', '印度尼西亚', '菲律宾',
  '法国', '意大利', '瑞士', '德国', '英国', '西班牙', '葡萄牙', '荷兰',
  '奥地利', '捷克', '希腊', '冰岛', '挪威', '瑞典', '丹麦', '芬兰', '俄罗斯',
  '美国', '加拿大', '墨西哥', '巴西', '阿根廷', '澳大利亚', '新西兰',
  '土耳其', '阿联酋', '印度', '斯里兰卡', '尼泊尔', '缅甸', '老挝', '马来西亚',
];

Page({
  data: {
    userInfo: { avatarUrl: '', nickName: '' },
    hasUserInfo: false,
    tripCount: 0,
    historyTrips: [],
    totalTrips: 0,
    refreshing: false,
    showHistory: false,
    wishCities: [],
    showCityInput: false,
    cityInput: '',
    citySuggestions: [],
    followStats: { following: 0, followers: 0 },
    showNickModal: false,
    nickInput: ''
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3 });
    }
    const app = getApp();
    if (app.globalData.userInfo) {
      this.setData({ userInfo: app.globalData.userInfo, hasUserInfo: true });
    }
    this.loadStats();
    this.loadWishCities();
    this.loadFollowStats();
  },

  onRefresh() {
    this.setData({ refreshing: true });
    Promise.all([this.loadStats(), this.loadWishCities()]).then(() => {
      this.setData({ refreshing: false });
    });
  },

  async loadStats() {
    try {
      const openid = await cloud.getOpenid();
      const db = cloud.db;

      const { data: memberships } = await db.collection('trip_members')
        .where({ openid })
        .get();

      if (!memberships.length) {
        this.setData({ tripCount: 0, historyTrips: [], totalTrips: 0 });
        return;
      }

      const tripIds = memberships.map(m => m.tripId);
      const { data: trips } = await db.collection('trips')
        .where({ _id: db.command.in(tripIds) })
        .orderBy('createdAt', 'desc')
        .get();

      const history = trips.filter(t => t.status === 'archived');
      const active = trips.filter(t => t.status !== 'archived');

      this.setData({
        tripCount: active.length,
        historyTrips: history,
        totalTrips: trips.length
      });
    } catch (e) {
      console.error('加载统计失败:', e);
    }
  },

  /* ══════ 头像昵称 ══════ */
  onNicknameBlur(e) {
    this.saveNickname(e.detail.value);
  },

  onNicknameConfirm(e) {
    this.saveNickname(e.detail.value);
  },

  saveNickname(nickName) {
    if (!nickName || !nickName.trim()) return;
    const userInfo = { ...this.data.userInfo, nickName: nickName.trim() };
    this.setData({ userInfo });
    this.checkAndSaveProfile(userInfo);
  },

  async syncUserToCloud(userInfo) {
    if (userInfo.avatarUrl || userInfo.nickName) {
      try {
        const openid = await cloud.getOpenid();
        await cloud.upsertUser(openid, userInfo.nickName || '', userInfo.avatarUrl || '');
      } catch (e) { /* silent */ }
    }
  },

  checkAndSaveProfile(userInfo) {
    if (userInfo.avatarUrl && userInfo.nickName) {
      const app = getApp();
      app.globalData.userInfo = userInfo;
      this.setData({ hasUserInfo: true });
    }
    this.syncUserToCloud(userInfo);
  },

  onStatTap(e) {
    const { action } = e.currentTarget.dataset;
    if (action === 'archived') {
      this.setData({ showHistory: !this.data.showHistory });
    } else {
      wx.switchTab({ url: '/pages/index/index' });
    }
  },

  onToggleHistory() {
    this.setData({ showHistory: !this.data.showHistory });
  },

  onTripTap(e) {
    const { id } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/trip-detail/trip-detail?tripId=${id}` });
  },

  onMenuTap(e) {
    const { action } = e.currentTarget.dataset;
    if (action === 'about') {
      wx.showModal({
        title: '关于旅行搭子',
        content: '和朋友们一起规划旅行、记账分账、分享旅途美好瞬间。',
        showCancel: false,
        confirmText: '好的'
      });
    } else if (action === 'tips') {
      wx.showModal({
        title: '旅行小贴士',
        content: '✦ 提前规划每日行程，避免手忙脚乱\n✦ 公共开销记得选分摊人\n✦ 旅途动态可以关联到具体日期',
        showCancel: false,
        confirmText: '知道了'
      });
    }
  },

  onAvatarTap() {
    const that = this;
    const hasAvatar = this.data.userInfo.avatarUrl;
    const itemList = hasAvatar ? ['查看头像', '从相册选择', '拍照'] : ['从相册选择', '拍照'];
    wx.showActionSheet({
      itemList,
      success: (res) => {
        const idx = hasAvatar ? res.tapIndex : res.tapIndex + 1;
        if (idx === 0) {
          wx.previewImage({ urls: [that.data.userInfo.avatarUrl], current: that.data.userInfo.avatarUrl });
        } else if (idx === 1) {
          that.chooseAvatar('album');
        } else if (idx === 2) {
          that.chooseAvatar('camera');
        }
      }
    });
  },

  chooseAvatar(sourceType) {
    wx.chooseImage({
      count: 1,
      sizeType: ['compressed'],
      sourceType: [sourceType],
      success: (imgRes) => {
        wx.cropImage({
          src: imgRes.tempFilePaths[0],
          cropScale: '1:1',
          success: (cropRes) => {
            const avatarUrl = cropRes.tempFilePath;
            const userInfo = { ...this.data.userInfo, avatarUrl };
            this.setData({ userInfo });
            const app = getApp();
            app.globalData.userInfo = userInfo;
            this.setData({ hasUserInfo: true });
            this.syncUserToCloud(userInfo);
          },
          fail: () => {
            wx.showToast({ title: '裁剪失败', icon: 'none' });
          }
        });
      }
    });
  },

  onEditProfile() {
    wx.showActionSheet({
      itemList: ['更换头像', '修改昵称'],
      success: (res) => {
        if (res.tapIndex === 0) {
          this.chooseAvatar('album');
        } else {
          this.onNickTap();
        }
      }
    });
  },

  onNickTap() {
    this.setData({ showNickModal: true, nickInput: this.data.userInfo.nickName || '' });
  },

  onNickInput(e) {
    this.setData({ nickInput: e.detail.value });
  },

  onCloseNickModal() {
    this.setData({ showNickModal: false });
  },

  onConfirmNick() {
    const nickName = this.data.nickInput.trim();
    if (!nickName) return wx.showToast({ title: '请输入昵称', icon: 'none' });
    const userInfo = { ...this.data.userInfo, nickName };
    this.setData({ userInfo, showNickModal: false });
    const app = getApp();
    app.globalData.userInfo = userInfo;
    this.setData({ hasUserInfo: true });
    this.syncUserToCloud(userInfo);
  },

  async loadFollowStats() {
    const openid = await cloud.getOpenid();
    const stats = await cloud.getFollowStats(openid);
    this.setData({ followStats: stats });
  },

  onGoFollowList(e) {
    const { type } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/follow-list/follow-list?type=${type}` });
  },

  onGoMySpace() {
    wx.navigateTo({ url: '/pages/my-moments/my-moments' });
  },

  /* ══════ 想去的地方 ══════ */
  loadWishCities() {
    const cities = wx.getStorageSync('wishCities') || [];
    this.setData({ wishCities: cities });
  },

  saveWishCities(cities) {
    wx.setStorageSync('wishCities', cities);
    this.setData({ wishCities: cities });
  },

  onAddCityTap() {
    this.setData({ showCityInput: true, cityInput: '', citySuggestions: [] });
  },

  onCloseCityInput() {
    this.setData({ showCityInput: false, cityInput: '', citySuggestions: [] });
  },

  onCityInput(e) {
    const value = e.detail.value;
    const suggestions = value ? CITY_LIST.filter(c => c.includes(value)).slice(0, 8) : [];
    this.setData({ cityInput: value, citySuggestions: suggestions });
  },

  onSelectSuggestion(e) {
    const name = e.currentTarget.dataset.name;
    if (this.data.wishCities.includes(name)) {
      this.setData({ cityInput: name, citySuggestions: [] });
      return wx.showToast({ title: '已在列表中', icon: 'none' });
    }
    const cities = [...this.data.wishCities, name];
    this.saveWishCities(cities);
    this.setData({ showCityInput: false, cityInput: '', citySuggestions: [] });
    wx.showToast({ title: '已添加', icon: 'success' });
  },

  onConfirmAddCity() {
    const name = this.data.cityInput.trim();
    if (!name) return wx.showToast({ title: '请输入目的地', icon: 'none' });
    if (this.data.wishCities.includes(name)) {
      return wx.showToast({ title: '已在列表中', icon: 'none' });
    }
    const cities = [...this.data.wishCities, name];
    this.saveWishCities(cities);
    this.setData({ showCityInput: false, cityInput: '', citySuggestions: [] });
    wx.showToast({ title: '已添加', icon: 'success' });
  },

  onRemoveCity(e) {
    const { index } = e.currentTarget.dataset;
    const cities = [...this.data.wishCities];
    cities.splice(index, 1);
    this.saveWishCities(cities);
  },

  preventBubble() {}
});
