const cloud = require('../../utils/cloud');
const theme = require('../../utils/theme');

Page({
  data: {
    themeStyle: '',
    themeClass: 'theme-blue', name: '', friends: [], selectedCount: 0, loading: true, creating: false, presetOpenid: '' },

  onLoad(options) {
    this.setData({ presetOpenid: decodeURIComponent(options.memberOpenid || '') });
    this.loadFriends();
  },

  onShow() {
    theme.applyToPage(this);
  },

  async loadFriends() {
    try {
      const center = await cloud.getFriendCenter();
      const friends = (center.friends || []).map(item => ({
        ...item,
        selected: item.openid === this.data.presetOpenid
      }));
      this.setData({ friends, selectedCount: friends.filter(item => item.selected).length, loading: false });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '好友列表加载失败', icon: 'none' });
    }
  },

  onNameInput(e) { this.setData({ name: e.detail.value }); },

  onToggleFriend(e) {
    const index = Number(e.currentTarget.dataset.index);
    const selected = !this.data.friends[index].selected;
    this.setData({ [`friends[${index}].selected`]: selected, selectedCount: this.data.selectedCount + (selected ? 1 : -1) });
  },

  async onCreate() {
    const name = this.data.name.trim();
    if (!name) return wx.showToast({ title: '请输入群聊名称', icon: 'none' });
    const memberOpenids = this.data.friends.filter(item => item.selected).map(item => item.openid);
    if (!memberOpenids.length) return wx.showToast({ title: '至少选择一位好友', icon: 'none' });
    if (this.data.creating) return;
    this.setData({ creating: true });
    try {
      const groupId = await cloud.createGroupChat(name, memberOpenids);
      wx.redirectTo({ url: `/pages/group-chat/group-chat?groupId=${encodeURIComponent(groupId)}&name=${encodeURIComponent(name)}` });
    } catch (e) {
      this.setData({ creating: false });
      wx.showToast({ title: e.message || '创建失败', icon: 'none' });
    }
  }
});
