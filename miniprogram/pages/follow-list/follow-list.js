const cloud = require('../../utils/cloud');
const theme = require('../../utils/theme');

Page({
  data: {
    themeStyle: '',
    themeClass: 'theme-blue',
    type: 'following', // following / followers
    targetOpenid: '',
    users: [],
    myOpenid: '',
    myFollowingSet: {},
    myFollowerSet: {},
    loading: true
  },

  onLoad(options) {
    const type = options.type || 'following';
    const targetOpenid = options.openid || '';
    wx.setNavigationBarTitle({ title: type === 'following' ? '关注列表' : '粉丝列表' });
    this.setData({ type, targetOpenid });
    this.loadList();
  },

  onShow() {
    theme.applyToPage(this);
  },

  async loadList() {
    try {
      const myOpenid = await cloud.getOpenid();
      this.setData({ myOpenid });

      const targetOpenid = this.data.targetOpenid || myOpenid;
      const openids = await cloud.getFollowList(targetOpenid, this.data.type);

      const userMap = await cloud.batchGetUsers(openids);
      const users = openids.map(id => userMap[id] || { openid: id, nickName: '未知用户', avatarUrl: '' });

      // 查询当前用户的关注列表（用于判断关注状态）+ 谁关注了我（互相关注）
      const [myFollowingIds, myFollowerIds] = await Promise.all([
        cloud.getFollowList(myOpenid, 'following'),
        cloud.getFollowList(myOpenid, 'followers')
      ]);
      const myFollowingSet = {};
      myFollowingIds.forEach(id => { myFollowingSet[id] = true; });
      const myFollowerSet = {};
      myFollowerIds.forEach(id => { myFollowerSet[id] = true; });

      this.setData({ users, myFollowingSet, myFollowerSet, loading: false });
    } catch (e) {
      console.error('加载列表失败:', e);
      this.setData({ loading: false });
    }
  },

  async onToggleFollow(e) {
    const { openid } = e.currentTarget.dataset;
    const { myOpenid, myFollowingSet } = this.data;
    if (openid === myOpenid) return;
    // 取关时需要确认
    if (myFollowingSet[openid]) {
      wx.showModal({
        title: '取消关注',
        content: '确定要取消关注吗？',
        confirmColor: '#ef4444',
        success: async (res) => {
          if (!res.confirm) return;
          try {
            await cloud.toggleFollow(myOpenid, openid);
            const set = { ...this.data.myFollowingSet };
            delete set[openid];
            this.setData({ myFollowingSet: set });
            wx.showToast({ title: '已取消关注', icon: 'success' });
          } catch (e) {
            wx.showToast({ title: '操作失败', icon: 'none' });
          }
        }
      });
      return;
    }
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
    const { openid, nickName, avatarUrl } = e.currentTarget.dataset;
    cloud.navigateToUserProfile(openid, { nickName, avatarUrl });
  }
});
