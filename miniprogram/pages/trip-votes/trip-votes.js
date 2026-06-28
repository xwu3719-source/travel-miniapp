const cloud = require('../../utils/cloud');
const theme = require('../../utils/theme');

const VOTE_TYPES = [
  { id: 'spot', label: '景点' },
  { id: 'food', label: '餐厅' },
  { id: 'hotel', label: '住宿' },
  { id: 'time', label: '时间' },
  { id: 'other', label: '其他' }
];

function splitOptions(text) {
  return [...new Set(String(text || '')
    .split(/[\n,，、/]+/)
    .map(item => item.trim())
    .filter(Boolean))]
    .slice(0, 8);
}

Page({
  data: {
    tripId: '',
    trip: null,
    votes: [],
    loading: true,
    showCreate: false,
    saving: false,
    voteTypes: VOTE_TYPES,
    keyboardHeight: 0,
    sheetMaxHeight: 620,
    sheetScrollMaxHeight: 568,
    form: {
      title: '',
      optionText: '',
      type: 'spot'
    }
  },

  onLoad(options) {
    this.setData({ tripId: options.tripId || '' });
  },

  onShow() {
    theme.applyToPage(this);
    this.loadVotes();
  },

  async loadVotes() {
    const tripId = this.data.tripId;
    if (!tripId) {
      wx.showToast({ title: '缺少行程', icon: 'none' });
      return;
    }
    this.setData({ loading: true });
    try {
      const [detail, votes] = await Promise.all([
        cloud.getTripDetail(tripId),
        cloud.getTripVotes(tripId)
      ]);
      this.setData({
        trip: detail.trip || null,
        votes: votes || [],
        loading: false
      });
    } catch (error) {
      console.error('加载投票失败:', error);
      this.setData({ loading: false });
      wx.showToast({ title: error.message || '加载失败', icon: 'none' });
    }
  },

  onOpenCreate() {
    if (this.data.trip && this.data.trip.status === 'archived') {
      wx.showToast({ title: '历史行程不能发起投票', icon: 'none' });
      return;
    }
    this.updateSheetLayout(0);
    this.setData({ showCreate: true });
  },

  preventBubble() {},

  onCloseCreate() {
    if (this.data.saving) return;
    this.setData({
      showCreate: false,
      keyboardHeight: 0
    });
  },

  updateSheetLayout(keyboardHeight = 0) {
    let windowHeight = 812;
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      windowHeight = Number(info.windowHeight) || windowHeight;
    } catch (error) {
      console.warn('获取窗口高度失败:', error);
    }
    const maxHeight = Math.max(280, Math.min(620, windowHeight - keyboardHeight - 96));
    this.setData({
      keyboardHeight,
      sheetMaxHeight: maxHeight,
      sheetScrollMaxHeight: Math.max(240, maxHeight - 52)
    });
  },

  onTitleInput(e) {
    this.setData({ 'form.title': e.detail.value });
  },

  onKeyboardHeightChange(e) {
    const height = Math.max(0, Number(e.detail && e.detail.height) || 0);
    this.updateSheetLayout(height);
  },

  onOptionsInput(e) {
    this.setData({ 'form.optionText': e.detail.value });
  },

  onTypeTap(e) {
    this.setData({ 'form.type': e.currentTarget.dataset.type || 'other' });
  },

  async onCreateVote() {
    if (this.data.saving) return;
    const title = String(this.data.form.title || '').trim();
    const options = splitOptions(this.data.form.optionText);
    if (!title) {
      wx.showToast({ title: '请输入投票主题', icon: 'none' });
      return;
    }
    if (options.length < 2) {
      wx.showToast({ title: '至少写 2 个选项', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    try {
      await cloud.createTripVote(this.data.tripId, {
        title,
        options,
        type: this.data.form.type
      });
      this.setData({
        saving: false,
        showCreate: false,
        form: { title: '', optionText: '', type: 'spot' }
      });
      wx.showToast({ title: '已发起投票', icon: 'success' });
      this.loadVotes();
    } catch (error) {
      this.setData({ saving: false });
      wx.showToast({ title: error.message || '创建失败', icon: 'none' });
    }
  },

  async onVoteOption(e) {
    const { id, index } = e.currentTarget.dataset;
    if (!id && id !== 0) return;
    try {
      await cloud.voteTripPoll(id, Number(index));
      this.loadVotes();
    } catch (error) {
      wx.showToast({ title: error.message || '投票失败', icon: 'none' });
    }
  },

  onCloseVote(e) {
    const voteId = e.currentTarget.dataset.id;
    wx.showModal({
      title: '结束投票',
      content: '结束后成员不能再修改选择，确认结束吗？',
      confirmText: '结束',
      confirmColor: '#5b9ff5',
      success: async res => {
        if (!res.confirm) return;
        try {
          await cloud.closeTripVote(voteId);
          wx.showToast({ title: '已结束', icon: 'success' });
          this.loadVotes();
        } catch (error) {
          wx.showToast({ title: error.message || '操作失败', icon: 'none' });
        }
      }
    });
  },

  getWinningOption(vote) {
    const options = vote && Array.isArray(vote.options) ? vote.options : [];
    if (!options.length) return '';
    const sorted = [...options].sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0));
    return (sorted[0] && sorted[0].text) || options[0].text || '';
  },

  onAdoptVote(e) {
    const voteId = e.currentTarget.dataset.id;
    const vote = this.data.votes.find(item => item._id === voteId);
    const title = this.getWinningOption(vote);
    if (!vote || !title) return;
    wx.showModal({
      title: '写入行程',
      content: `把「${title}」加入哪一天？`,
      editable: true,
      placeholderText: '输入 Day 数字，例如 1',
      confirmText: '写入',
      confirmColor: '#5b9ff5',
      success: async res => {
        if (!res.confirm) return;
        const dayIndex = Math.max(1, Math.min(Number(this.data.trip && this.data.trip.totalDays) || 1, Number(res.content) || 1));
        try {
          wx.showLoading({ title: '写入中...' });
          const detail = await cloud.getTripDetail(this.data.tripId);
          const trip = detail.trip || this.data.trip || {};
          const existing = (detail.dayPlans || []).find(day => Number(day.dayIndex) === dayIndex);
          const dates = cloud.dateRange(trip.startDate, trip.endDate);
          const item = {
            title,
            type: vote.type === 'food' ? 'food' : (vote.type === 'hotel' ? 'hotel' : 'spot'),
            time: '',
            location: title,
            notes: `来自投票：${vote.title}`,
            sortId: `vote_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
          };
          await cloud.upsertDayPlan(
            existing && existing._id,
            this.data.tripId,
            dayIndex,
            (dates && dates[dayIndex - 1]) || '',
            [...((existing && existing.items) || []), item]
          );
          wx.hideLoading();
          wx.showToast({ title: '已写入日程', icon: 'success' });
        } catch (error) {
          wx.hideLoading();
          wx.showToast({ title: error.message || '写入失败', icon: 'none' });
        }
      }
    });
  }
});
