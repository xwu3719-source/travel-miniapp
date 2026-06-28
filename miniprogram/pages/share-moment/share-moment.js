const cloud = require('../../utils/cloud');
const theme = require('../../utils/theme');

Page({
  data: {
    themeStyle: '',
    themeClass: 'theme-blue',
    momentId: '',
    loading: true,
    sending: false,
    friends: [],
    selectedCount: 0
  },

  onLoad(options) {
    this.setData({ momentId: decodeURIComponent(options.momentId || '') }

  onShow() {
    theme.applyToPage(this);
  },);
    this.loadFriends();
  },

  async loadFriends() {
    try {
      const center = await cloud.getFriendCenter();
      const friends = (center.friends || []).map(item => ({ ...item, selected: false }));
      this.setData({ friends, loading: false });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '好友列表加载失败', icon: 'none' });
    }
  },

  onToggleFriend(e) {
    const index = Number(e.currentTarget.dataset.index);
    const key = `friends[${index}].selected`;
    const selected = !this.data.friends[index].selected;
    this.setData({
      [key]: selected,
      selectedCount: this.data.selectedCount + (selected ? 1 : -1)
    });
  },

  onToggleAll() {
    const shouldSelect = this.data.selectedCount !== this.data.friends.length;
    const friends = this.data.friends.map(item => ({ ...item, selected: shouldSelect }));
    this.setData({ friends, selectedCount: shouldSelect ? friends.length : 0 });
  },

  async onConfirm() {
    if (!this.data.momentId || !this.data.selectedCount || this.data.sending) return;
    const selected = this.data.friends.filter(item => item.selected);
    this.setData({ sending: true });
    wx.showLoading({ title: '正在分享' });
    try {
      const results = await Promise.allSettled(selected.map(friend =>
        cloud.sendRichPrivateMessage(friend.openid, 'moment_share', { momentId: this.data.momentId })
      ));
      const successCount = results.filter(item => item.status === 'fulfilled').length;
      if (!successCount) throw new Error('分享失败，请稍后重试');
      let shareCount;
      try {
        shareCount = await cloud.recordMomentShare(this.data.momentId, successCount);
      } catch (countError) {
        console.warn('记录分享数失败:', countError);
      }
      const eventChannel = this.getOpenerEventChannel();
      if (eventChannel && eventChannel.emit) {
        eventChannel.emit('shared', { momentId: this.data.momentId, count: successCount, shareCount });
      }
      wx.hideLoading();
      wx.showToast({ title: `已分享给 ${successCount} 位好友`, icon: 'success' });
      setTimeout(() => wx.navigateBack(), 900);
    } catch (e) {
      wx.hideLoading();
      this.setData({ sending: false });
      wx.showToast({ title: e.message || '分享失败', icon: 'none' });
    }
  }
});
