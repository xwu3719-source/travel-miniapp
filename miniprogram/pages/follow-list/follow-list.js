const cloud = require('../../utils/cloud');

Page({
  data: {
    type: 'following', // following / followers
    targetOpenid: '',
    users: [],
    myOpenid: '',
    myFollowingSet: {},
    loading: true
  },

  onLoad(options) {
    const type = options.type || 'following';
    const targetOpenid = options.openid || '';
    wx.setNavigationBarTitle({ title: type === 'following' ? '关注列表' : '粉丝列表' });
    this.setData({ type, targetOpenid });
    this.loadList();
  },

  async loadList() {
    try {
      const myOpenid = await cloud.getOpenid();
      this.setData({ myOpenid });

      const targetOpenid = this.data.targetOpenid || myOpenid;
      const openids = await cloud.getFollowList(targetOpenid, this.data.type);

      const userMap = await cloud.batchGetUsers(openids);
      const users = openids.map(id => userMap[id] || { openid: id, nickName: '未知用户', avatarUrl: '' });

      // 查询当前用户的关注列表（用于判断关注状态）
      const myFollowingIds = await cloud.getFollowList(myOpenid, 'following');
      const myFollowingSet = {};
      myFollowingIds.forEach(id => { myFollowingSet[id] = true; });

      this.setData({ users, myFollowingSet, loading: false });
    } catch (e) {
      console.error('加载列表失败:', e);
      this.setData({ loading: false });
    }
  },

  async onToggleFollow(e) {
    const { openid } = e.currentTarget.dataset;
    const { myOpenid } = this.data;
    if (openid === myOpenid) return;
    try {
      const followed = await cloud.toggleFollow(myOpenid, openid);
      const set = { ...this.data.myFollowingSet };
      if (followed) set[openid] = true;
      else delete set[openid];
      this.setData({ myFollowingSet: set });
    } catch (e) {
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  onUserTap(e) {
    const { openid } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/user-profile/user-profile?openid=${openid}` });
  }
});
