const cloud = require('../../utils/cloud');

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
    this.setData({ showCreate: true });
  },

  onCloseCreate() {
    if (this.data.saving) return;
    this.setData({ showCreate: false });
  },

  onTitleInput(e) {
    this.setData({ 'form.title': e.detail.value });
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
  }
});
