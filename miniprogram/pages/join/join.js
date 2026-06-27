const cloud = require('../../utils/cloud');

Page({
  data: {
    code: '',
    joining: false
  },

  onCodeInput(e) {
    this.setData({ code: e.detail.value.toUpperCase().slice(0, 6) });
  },

  async onJoin() {
    if (this.data.joining) return;
    const code = this.data.code.trim();
    if (code.length < 4) return wx.showToast({ title: '请输入有效邀请码', icon: 'none' });

    this.setData({ joining: true });
    try {
      const result = await cloud.joinTrip(code);

      wx.showToast({ title: result.alreadyJoined ? '你已加入该行程' : '加入成功！', icon: result.alreadyJoined ? 'none' : 'success' });
      setTimeout(() => {
        wx.navigateTo({ url: `/pages/trip-detail/trip-detail?tripId=${result.tripId}` });
      }, 1000);
    } catch (e) {
      console.error('加入失败:', e);
      wx.showToast({ title: e.message || '加入失败，请重试', icon: 'none' });
      this.setData({ joining: false });
    }
  }
});
