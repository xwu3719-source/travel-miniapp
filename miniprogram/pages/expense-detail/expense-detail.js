const cloud = require('../../utils/cloud');
const theme = require('../../utils/theme');

const CATEGORY_LABELS = {
  transport: '交通',
  hotel: '住宿',
  food: '餐饮',
  tickets: '门票',
  shopping: '购物',
  other: '其他'
};

Page({
  data: {
    themeStyle: '',
    themeClass: 'theme-blue',
    tripId: '',
    expenseId: '',
    expense: null,
    splitMembers: [],
    refundHistory: [],
    netAmount: '0.00',
    refundedText: '',
    canManage: false,
    loading: true,
    showRefundModal: false,
    refundAmount: '',
    refundDesc: '',
    voicePlaying: false
  },

  onLoad(options) {
    this.setData({ tripId: options.tripId || '', expenseId: options.expenseId || '' });
  },

  onShow() {
    theme.applyToPage(this);
    this.loadExpense();
  },

  async loadExpense() {
    const { tripId, expenseId } = this.data;
    if (!tripId || !expenseId) {
      wx.showToast({ title: '账单参数缺失', icon: 'none' });
      return;
    }
    this.setData({ loading: true });
    try {
      const [openid, snapshot] = await Promise.all([
        cloud.getOpenid(),
        cloud.getTripSnapshot(tripId, ['members', 'expenses'])
      ]);
      const members = snapshot.members || [];
      await cloud.resolveUserAvatars(members).catch(() => {});
      const expense = (snapshot.expenses || []).find(item => item._id === expenseId);
      if (!expense) throw new Error('账单不存在或已删除');

      const splitSet = new Set(expense.splitAmong || []);
      const splitMembers = members
        .filter(member => splitSet.has(member.openid))
        .map(member => ({ ...member, share: this.shareAmount(expense, expense.splitAmong || []) }));
      const refunded = Number(expense.refunded) || 0;
      const amount = Number(expense.amount) || 0;
      const netAmount = Math.max(0, amount - refunded);
      const category = expense.category || 'other';
      const paidByMember = members.find(member => member.openid === expense.paidBy);
      const normalized = {
        ...expense,
        icon: cloud.categoryIcon(category),
        categoryLabel: CATEGORY_LABELS[category] || '其他',
        typeLabel: expense.type === 'shared' ? '公共开销' : '私人开销',
        paidByName: (paidByMember && paidByMember.nickName) || expense.paidByName || '未知',
        createdAtText: this.formatTime(expense.createdAt),
        updatedAtText: this.formatTime(expense.updatedAt),
        splitCount: (expense.splitAmong || []).length,
        perPersonAmount: expense.type === 'shared' && (expense.splitAmong || []).length
          ? this.shareAmount(expense, expense.splitAmong)
          : ''
      };

      this.setData({
        expense: normalized,
        splitMembers,
        refundHistory: (expense.refundHistory || []).map(item => ({ ...item, createdAtText: this.formatTime(item.createdAt) })),
        netAmount: netAmount.toFixed(2),
        refundedText: refunded > 0 ? `已退款/抵扣 ¥${refunded.toFixed(2)}` : '',
        canManage: !expense.settled,
        loading: false
      });
    } catch (e) {
      console.error('加载账单详情失败:', e);
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  shareAmount(expense, splitAmong) {
    const count = Array.isArray(splitAmong) ? splitAmong.length : 0;
    if (!count) return '0.00';
    return (Math.round((Number(expense.amount) || 0) / count * 100) / 100).toFixed(2);
  },

  formatTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  },

  onEdit() {
    const { tripId, expenseId, canManage } = this.data;
    if (!canManage) return wx.showToast({ title: '已结算账单不能编辑', icon: 'none' });
    wx.navigateTo({ url: `/pages/add-expense/add-expense?tripId=${tripId}&expenseId=${expenseId}` });
  },

  async onDelete() {
    if (!this.data.canManage) return wx.showToast({ title: '已结算账单不能删除', icon: 'none' });
    const confirmed = await new Promise(resolve => {
      wx.showModal({
        title: '删除账单',
        content: '删除后无法恢复，确定删掉这笔账单吗？',
        confirmColor: '#ef4444',
        success: res => resolve(res.confirm)
      });
    });
    if (!confirmed) return;
    try {
      wx.showLoading({ title: '删除中...' });
      await cloud.deleteExpense(this.data.expenseId);
      wx.hideLoading();
      wx.showToast({ title: '已删除', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 700);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.message || '删除失败', icon: 'none' });
    }
  },

  onShowRefund() {
    if (!this.data.canManage) return wx.showToast({ title: '已结算账单不能退款', icon: 'none' });
    this.setData({ showRefundModal: true, refundAmount: '', refundDesc: '' });
  },

  onCloseRefund() {
    this.setData({ showRefundModal: false, refundAmount: '', refundDesc: '' });
  },

  onRefundAmountInput(e) {
    this.setData({ refundAmount: e.detail.value });
  },

  onRefundDescInput(e) {
    this.setData({ refundDesc: e.detail.value });
  },

  async onConfirmRefund() {
    const amount = Number(this.data.refundAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return wx.showToast({ title: '请输入退款金额', icon: 'none' });
    }
    try {
      wx.showLoading({ title: '记录中...' });
      await cloud.addRefund(this.data.expenseId, amount, this.data.refundDesc);
      wx.hideLoading();
      wx.showToast({ title: '已记录', icon: 'success' });
      this.setData({ showRefundModal: false, refundAmount: '', refundDesc: '' });
      this.loadExpense();
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.message || '记录失败', icon: 'none' });
    }
  },

  async onPreviewReceipt() {
    const fileId = this.data.expense && this.data.expense.receiptFileId;
    if (!fileId) return;
    try {
      wx.showLoading({ title: '打开凭证...' });
      const url = await cloud.getTempFileUrl(fileId);
      wx.hideLoading();
      wx.previewImage({ urls: [url || fileId], current: url || fileId });
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: '凭证已过期', icon: 'none' });
    }
  },

  async onPlayVoice() {
    const fileId = this.data.expense && this.data.expense.voiceFileId;
    if (!fileId) return;
    if (this._audio) {
      this._audio.stop();
      this._audio.destroy();
      this._audio = null;
      this.setData({ voicePlaying: false });
      return;
    }
    try {
      wx.showLoading({ title: '加载语音...' });
      const url = await cloud.getTempFileUrl(fileId);
      wx.hideLoading();
      if (!url) return wx.showToast({ title: '语音已过期', icon: 'none' });
      const audio = wx.createInnerAudioContext();
      this._audio = audio;
      audio.src = url;
      audio.onEnded(() => this.clearAudio());
      audio.onError(() => {
        this.clearAudio();
        wx.showToast({ title: '播放失败', icon: 'none' });
      });
      this.setData({ voicePlaying: true });
      audio.play();
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: '播放失败', icon: 'none' });
    }
  },

  clearAudio() {
    if (this._audio) {
      this._audio.destroy();
      this._audio = null;
    }
    this.setData({ voicePlaying: false });
  },

  onUnload() {
    this.clearAudio();
  },

  preventBubble() {}
});
