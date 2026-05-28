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
    const code = this.data.code.trim();
    if (code.length < 4) return wx.showToast({ title: '请输入有效邀请码', icon: 'none' });

    this.setData({ joining: true });
    try {
      const db = cloud.db;

      // 查找邀请码对应的成员记录
      const { data: members } = await db.collection('trip_members')
        .where({ inviteCode: code })
        .get();

      if (!members.length) {
        this.setData({ joining: false });
        return wx.showToast({ title: '邀请码无效', icon: 'none' });
      }

      const tripId = members[0].tripId;
      const openid = await cloud.getOpenid();

      // 检查是否已经是成员
      const { data: existing } = await db.collection('trip_members')
        .where({ tripId, openid })
        .get();

      if (existing.length) {
        this.setData({ joining: false });
        wx.showToast({ title: '你已加入该行程', icon: 'none' });
        return wx.navigateBack();
      }

      // 获取行程信息
      const trip = cloud.getDoc(await db.collection('trips').doc(tripId).get());
      if (!trip) {
        this.setData({ joining: false });
        return wx.showToast({ title: '行程不存在', icon: 'none' });
      }

      const userInfo = getApp().globalData.userInfo || {};

      // 加入行程
      await db.collection('trip_members').add({
        data: {
          tripId,
          openid,
          nickName: userInfo.nickName || '新成员',
          avatarUrl: userInfo.avatarUrl || '',
          role: 'member',
          inviteCode: ''
        }
      });

      wx.showToast({ title: '加入成功！', icon: 'success' });
      setTimeout(() => {
        wx.navigateTo({ url: `/pages/trip-detail/trip-detail?tripId=${tripId}` });
      }, 1000);
    } catch (e) {
      console.error('加入失败:', e);
      wx.showToast({ title: '加入失败，请重试', icon: 'none' });
      this.setData({ joining: false });
    }
  }
});
