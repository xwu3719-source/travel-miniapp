const cloud = require('../../utils/cloud');

Page({
  data: {
    tripId: '',
    members: [],
    inviteCode: '',
    isCreator: false,
    refreshing: false,
    showInvitePanel: false,
    inviteCandidates: [],
    selectedFriendOpenids: [],
    inviteLoading: false,
    inviteSending: false
  },

  onLoad(options) {
    this.setData({ tripId: options.tripId });
  },

  onShow() {
    this.loadMembers();
  },

  onAuthorTap(e) {
    const { openid, nickName, avatarUrl } = e.currentTarget.dataset;
    cloud.navigateToUserProfile(openid, { nickName, avatarUrl });
  },

  onRefresh() {
    this.setData({ refreshing: true });
    this.loadMembers().then(() => this.setData({ refreshing: false }));
  },

  async loadMembers() {
    try {
      const openid = await cloud.getOpenid();
      const tripId = this.data.tripId;
      const { members } = await cloud.getTripSnapshot(tripId, ['members']);

      // 从 users 集合同步最新的头像昵称
      const memberOpenids = members.map(m => m.openid).filter(Boolean);
      if (memberOpenids.length > 0) {
        try {
          const userMap = await cloud.batchGetUsers(memberOpenids);
          members.forEach(m => {
            const u = userMap[m.openid];
            if (u) {
              if (u.avatarUrl) m.avatarUrl = u.avatarUrl;
              if (u.nickName) m.nickName = u.nickName;
            }
          });
        } catch (e) { /* 非关键 */ }
      }
      await cloud.resolveUserAvatars(members);

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
        try {
          await cloud.removeTripMember(id);
          wx.showToast({ title: '已移除', icon: 'success' });
          this.loadMembers();
        } catch (e) {
          wx.showToast({ title: e.message || '移除失败', icon: 'none' });
        }
      }
    });
  },

  async onOpenInviteFriends() {
    this.setData({
      showInvitePanel: true,
      inviteCandidates: [],
      selectedFriendOpenids: [],
      inviteLoading: true
    });
    try {
      const center = await cloud.getFriendCenter();
      const memberOpenids = new Set(this.data.members.map(item => item.openid).filter(Boolean));
      const inviteCandidates = (center.friends || [])
        .filter(friend => friend.openid && !memberOpenids.has(friend.openid))
        .map(friend => ({ ...friend, selected: false }));
      this.setData({ inviteCandidates, inviteLoading: false });
    } catch (e) {
      console.error('加载好友列表失败:', e);
      this.setData({ inviteLoading: false });
      wx.showToast({ title: e.message || '好友列表加载失败', icon: 'none' });
    }
  },

  onCloseInviteFriends() {
    if (this.data.inviteSending) return;
    this.setData({ showInvitePanel: false, selectedFriendOpenids: [] });
  },

  preventBubble() {},

  onToggleInviteFriend(e) {
    if (this.data.inviteSending) return;
    const { openid } = e.currentTarget.dataset;
    const inviteCandidates = this.data.inviteCandidates.map(friend =>
      friend.openid === openid ? { ...friend, selected: !friend.selected } : friend
    );
    const selectedFriendOpenids = inviteCandidates
      .filter(friend => friend.selected)
      .map(friend => friend.openid);
    this.setData({ inviteCandidates, selectedFriendOpenids });
  },

  onGoFindFriends() {
    this.setData({ showInvitePanel: false });
    wx.navigateTo({ url: '/pages/find-friends/find-friends' });
  },

  async onInviteSelectedFriends() {
    const selected = this.data.inviteCandidates.filter(friend => friend.selected);
    if (!selected.length || this.data.inviteSending) return;
    this.setData({ inviteSending: true });

    let sentCount = 0;
    let duplicateCount = 0;
    const failedOpenids = [];
    for (const friend of selected) {
      try {
        const result = await cloud.sendTripInvitation(friend.openid, this.data.tripId);
        if (result.alreadySent) duplicateCount += 1;
        else sentCount += 1;
      } catch (e) {
        console.error(`邀请 ${friend.nickName || friend.openid} 失败:`, e);
        failedOpenids.push(friend.openid);
      }
    }

    if (!failedOpenids.length) {
      this.setData({
        inviteSending: false,
        showInvitePanel: false,
        selectedFriendOpenids: []
      });
      const title = sentCount
        ? `已邀请${sentCount}位好友`
        : (duplicateCount ? '邀请已发送过' : '邀请完成');
      wx.showToast({ title, icon: sentCount ? 'success' : 'none' });
      return;
    }

    const failedSet = new Set(failedOpenids);
    const inviteCandidates = this.data.inviteCandidates.map(friend => ({
      ...friend,
      selected: failedSet.has(friend.openid)
    }));
    this.setData({
      inviteSending: false,
      inviteCandidates,
      selectedFriendOpenids: failedOpenids
    });
    wx.showModal({
      title: sentCount || duplicateCount ? '部分邀请未发送' : '邀请发送失败',
      content: `还有 ${failedOpenids.length} 位好友邀请失败，请稍后重试。`,
      showCancel: false
    });
  }
});
