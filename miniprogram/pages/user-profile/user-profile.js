const cloud = require('../../utils/cloud');

Page({
  data: {
    targetOpenid: '',
    user: null,
    myOpenid: '',
    isFollowing: false,
    followStats: { following: 0, followers: 0 },
    momentCount: 0,
    moments: [],
    loading: true
  },

  onLoad(options) {
    this.setData({ targetOpenid: options.openid });
    this.loadAll();
  },

  async loadAll() {
    try {
      const myOpenid = await cloud.getOpenid();
      const { targetOpenid } = this.data;
      this.setData({ myOpenid });

      // 加载用户信息
      const user = await cloud.getUserProfile(targetOpenid);
      if (!user) {
        wx.showToast({ title: '用户不存在', icon: 'none' });
        return setTimeout(() => wx.navigateBack(), 1200);
      }

      // 关注状态 + 统计
      const [isFollowing, followStats] = await Promise.all([
        cloud.isFollowing(myOpenid, targetOpenid),
        cloud.getFollowStats(targetOpenid)
      ]);

      // 公开动态
      const db = cloud.db;
      const { data: moments } = await db.collection('moments')
        .where({ authorId: targetOpenid, isPrivate: db.command.neq(true) })
        .orderBy('createdAt', 'desc')
        .limit(20)
        .get();

      moments.forEach(m => {
        m.formattedTime = cloud.formatDate(m.createdAt);
      });

      this.setData({
        user, isFollowing, followStats,
        momentCount: moments.length,
        moments,
        loading: false
      });
    } catch (e) {
      console.error('加载用户主页失败:', e);
      this.setData({ loading: false });
    }
  },

  async onToggleFollow() {
    const { myOpenid, targetOpenid } = this.data;
    if (myOpenid === targetOpenid) return;
    try {
      const followed = await cloud.toggleFollow(myOpenid, targetOpenid);
      this.setData({ isFollowing: followed });
      wx.showToast({ title: followed ? '已关注' : '已取消关注', icon: 'success' });
      this.loadAll();
    } catch (e) {
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  onGoFollowList(e) {
    const { type } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/follow-list/follow-list?openid=${this.data.targetOpenid}&type=${type}` });
  },

  onMomentTap(e) {
    const { id } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/moment-detail/moment-detail?momentId=${id}` });
  },

  async onPlayMomentVideo(e) {
    const { fileId } = e.currentTarget.dataset;
    if (!fileId) return;
    try {
      const res = await wx.cloud.getTempFileURL({ fileList: [fileId] });
      const item = res.fileList[0];
      if (!item.tempFileURL) { wx.showToast({ title: '视频已过期', icon: 'none' }); return; }
      wx.previewMedia({ sources: [{ url: item.tempFileURL, type: 'video' }] });
    } catch (e) {
      console.error('播放视频失败:', e);
      wx.showToast({ title: '播放失败', icon: 'none' });
    }
  }
});
