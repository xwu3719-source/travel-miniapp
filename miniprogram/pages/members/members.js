const cloud = require('../../utils/cloud');

Page({
  data: {
    tripId: '',
    members: [],
    inviteCode: '',
    isCreator: false,
    refreshing: false
  },

  onLoad(options) {
    this.setData({ tripId: options.tripId });
  },

  onShow() {
    this.loadMembers();
  },

  onRefresh() {
    this.setData({ refreshing: true });
    this.loadMembers().then(() => this.setData({ refreshing: false }));
  },

  async loadMembers() {
    try {
      const db = cloud.db;
      const openid = await cloud.getOpenid();
      const tripId = this.data.tripId;

      const { data: members } = await db.collection('trip_members').where({ tripId }).get();

      const creator = members.find(m => m.role === 'creator');
      const isCreator = creator && creator.openid === openid;
      const inviteCode = creator ? creator.inviteCode : '';

      this.setData({ members, inviteCode, isCreator });
    } catch (e) {
      console.error('加载成员失败:', e);
    }
  },

  async onRemoveMember(e) {
    const { id, name } = e.currentTarget.dataset;
    if (!this.data.isCreator) return wx.showToast({ title: '仅创建者可移除成员', icon: 'none' });

    wx.showModal({
      title: `移除 ${name}？`,
      content: '移除后该成员将无法查看此行程',
      success: async (res) => {
        if (!res.confirm) return;
        await cloud.collection('trip_members').doc(id).remove();
        wx.showToast({ title: '已移除', icon: 'success' });
        this.loadMembers();
      }
    });
  }
});
