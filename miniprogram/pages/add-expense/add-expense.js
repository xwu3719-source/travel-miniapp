const cloud = require('../../utils/cloud');

const CATEGORIES = [
  { key: 'transport', icon: '🚄', label: '交通' },
  { key: 'hotel', icon: '🏨', label: '住宿' },
  { key: 'food', icon: '🍜', label: '餐饮' },
  { key: 'tickets', icon: '🎫', label: '门票' },
  { key: 'shopping', icon: '🛍', label: '购物' },
  { key: 'other', icon: '📦', label: '其他' }
];

Page({
  data: {
    tripId: '',
    members: [],
    categories: CATEGORIES,
    type: 'shared',
    category: 'food',
    amount: '',
    description: '',
    paidBy: '',
    splitAmong: [],
    saving: false
  },

  onLoad(options) {
    const tripId = options.tripId;
    const members = options.members ? JSON.parse(decodeURIComponent(options.members)) : [];
    this.setData({ tripId, members });
    this.loadMembers(tripId);
  },

  async loadMembers(tripId) {
    try {
      const openid = await cloud.getOpenid();
      const { data: members } = await cloud.collection('trip_members').where({ tripId }).get();
      this.setData({ members, paidBy: openid });
    } catch (e) {
      console.warn('加载成员失败:', e);
    }
  },

  onTypeTap(e) { this.setData({ type: e.currentTarget.dataset.type }); },
  onCategoryTap(e) { this.setData({ category: e.currentTarget.dataset.cat }); },
  onAmountInput(e) { this.setData({ amount: e.detail.value }); },
  onDescInput(e) { this.setData({ description: e.detail.value }); },
  onPaidByChange(e) {
    const idx = e.detail.value;
    const member = this.data.members[idx];
    if (member) {
      this.setData({ paidBy: member.openid });
    }
  },

  onSplitToggle(e) {
    const openid = e.currentTarget.dataset.openid;
    let split = [...this.data.splitAmong];
    const idx = split.indexOf(openid);
    if (idx > -1) {
      split.splice(idx, 1);
    } else {
      split.push(openid);
    }
    this.setData({ splitAmong: split });
  },

  async onSave() {
    const { tripId, type, category, amount, description, paidBy, splitAmong } = this.data;
    if (!amount || Number(amount) <= 0) return wx.showToast({ title: '请输入金额', icon: 'none' });
    if (!description.trim()) return wx.showToast({ title: '请输入描述', icon: 'none' });

    const db = cloud.db;
    const payer = this.data.members.find(m => m.openid === paidBy);

    const expense = {
      tripId,
      type,
      category,
      amount: Number(amount),
      description: description.trim(),
      paidBy: paidBy || '',
      paidByName: payer ? payer.nickName : '未知',
      splitAmong: type === 'shared' ? splitAmong : [],
      createdAt: new Date().toISOString()
    };

    this.setData({ saving: true });
    try {
      await db.collection('expenses').add({ data: expense });
      wx.showToast({ title: '记账成功', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 1000);
    } catch (e) {
      console.error('保存失败:', e);
      wx.showToast({ title: '保存失败', icon: 'none' });
      this.setData({ saving: false });
    }
  }
});
