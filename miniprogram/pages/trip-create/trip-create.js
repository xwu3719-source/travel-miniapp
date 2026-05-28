const cloud = require('../../utils/cloud');

Page({
  data: {
    isEdit: false,
    tripId: '',
    name: '',
    city: '',
    startDate: '',
    endDate: '',
    totalBudget: '',
    categoryBudgets: {
      transport: '',
      hotel: '',
      food: '',
      tickets: '',
      shopping: '',
      other: ''
    },
    showCategoryBudget: false,
    nameFocus: false,
    cityFocus: false,
    budgetFocus: false,
    saving: false,
    categories: [
      { key: 'transport', icon: '🚄', label: '交通' },
      { key: 'hotel', icon: '🏨', label: '住宿' },
      { key: 'food', icon: '🍜', label: '餐饮' },
      { key: 'tickets', icon: '🎫', label: '门票' },
      { key: 'shopping', icon: '🛍', label: '购物' },
      { key: 'other', icon: '📦', label: '其他' }
    ]
  },

  onLoad(options) {
    if (options.tripId) {
      this.setData({ isEdit: true, tripId: options.tripId });
      this.loadTrip(options.tripId);
    }
  },

  async loadTrip(tripId) {
    const t = cloud.getDoc(await cloud.collection('trips').doc(tripId).get());
    if (t) {
      this.setData({
        name: t.name || '',
        city: t.city || '',
        startDate: t.startDate || '',
        endDate: t.endDate || '',
        totalBudget: t.totalBudget ? String(t.totalBudget) : '',
        categoryBudgets: t.categoryBudgets || this.data.categoryBudgets
      });
    }
  },

  onNameInput(e) { this.setData({ name: e.detail.value }); },
  onNameFocus() { this.setData({ nameFocus: true }); },
  onNameBlur() { this.setData({ nameFocus: false }); },
  onCityInput(e) { this.setData({ city: e.detail.value }); },
  onCityFocus() { this.setData({ cityFocus: true }); },
  onCityBlur() { this.setData({ cityFocus: false }); },
  onBudgetInput(e) { this.setData({ totalBudget: e.detail.value }); },
  onBudgetFocus() { this.setData({ budgetFocus: true }); },
  onBudgetBlur() { this.setData({ budgetFocus: false }); },

  onStartDateChange(e) {
    this.setData({ startDate: e.detail.value });
  },
  onEndDateChange(e) {
    this.setData({ endDate: e.detail.value });
  },

  onCatBudgetInput(e) {
    const { cat } = e.currentTarget.dataset;
    const cb = { ...this.data.categoryBudgets };
    cb[cat] = e.detail.value;
    this.setData({ categoryBudgets: cb });
  },

  toggleCategoryBudget() {
    this.setData({ showCategoryBudget: !this.data.showCategoryBudget });
  },

  async onSave() {
    const { name, city, startDate, endDate, totalBudget, categoryBudgets } = this.data;
    if (!name.trim()) return wx.showToast({ title: '请输入行程名称', icon: 'none' });
    if (!city.trim()) return wx.showToast({ title: '请输入目的地', icon: 'none' });
    if (!startDate || !endDate) return wx.showToast({ title: '请选择日期', icon: 'none' });
    if (startDate > endDate) return wx.showToast({ title: '开始日期不能晚于结束日期', icon: 'none' });

    this.setData({ saving: true });

    const totalDays = cloud.daysBetween(startDate, endDate);
    const openid = await cloud.getOpenid();
    const db = cloud.db;

    const tripData = {
      name: name.trim(),
      city: city.trim(),
      startDate,
      endDate,
      totalDays,
      totalBudget: Number(totalBudget) || 0,
      categoryBudgets: categoryBudgets,
      updatedAt: new Date().toISOString()
    };

    try {
      if (this.data.isEdit) {
        await db.collection('trips').doc(this.data.tripId).update({ data: tripData });
      } else {
        tripData.creatorId = openid;
        tripData.status = 'active';
        tripData.createdAt = new Date().toISOString();

        const res = await db.collection('trips').add({ data: tripData });
        const tripId = res._id;

        // 生成邀请码
        const inviteCode = cloud.genInviteCode();

        // 获取用户信息
        const userInfo = getApp().globalData.userInfo || {};

        // 创建者为第一个成员
        await db.collection('trip_members').add({
          data: {
            tripId,
            openid,
            nickName: userInfo.nickName || '我',
            avatarUrl: userInfo.avatarUrl || '',
            role: 'creator',
            inviteCode
          }
        });
      }

      wx.showToast({ title: this.data.isEdit ? '已更新' : '创建成功', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 1200);
    } catch (e) {
      console.error('保存失败:', e);
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
    this.setData({ saving: false });
  }
});
