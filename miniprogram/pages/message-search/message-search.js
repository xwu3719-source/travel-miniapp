const cloud = require('../../utils/cloud');

function previewText(message) {
  if (message.type === 'image') return '[图片]';
  if (message.type === 'voice') return `[语音] ${message.voiceDuration || 1}秒`;
  if (message.type === 'file') return `[文件] ${message.fileName || ''}`;
  if (message.type === 'location') return `[位置] ${message.locationName || ''}`;
  if (message.type === 'user_card') return `[名片] ${message.cardName || ''}`;
  if (message.type === 'moment_share') return '[动态分享]';
  if (message.type === 'trip_invite') return `[行程邀请] ${message.tripName || ''}`;
  if (message.type === 'revoked') return '[已撤回]';
  return message.text || '';
}

Page({
  data: { targetOpenid: '', targetName: '', query: '', loading: true, messages: [], results: [] },

  onLoad(options) {
    this.setData({
      targetOpenid: decodeURIComponent(options.openid || ''),
      targetName: decodeURIComponent(options.nickName || '')
    });
    this.loadMessages();
  },

  async loadMessages() {
    try {
      const [chat, myOpenid] = await Promise.all([cloud.getPrivateChat(this.data.targetOpenid), cloud.getOpenid()]);
      const messages = (chat.messages || []).map(item => ({
        ...item,
        previewText: previewText(item),
        senderName: item.from === myOpenid ? '我' : (this.data.targetName || '对方'),
        displayTime: cloud.formatDate(item.createdAt)
      }));
      this.setData({ messages, results: messages, loading: false });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '聊天记录加载失败', icon: 'none' });
    }
  },

  onInput(e) {
    const query = String(e.detail.value || '').trim().toLowerCase();
    const results = query ? this.data.messages.filter(item => item.previewText.toLowerCase().includes(query)) : this.data.messages;
    this.setData({ query: e.detail.value, results });
  },

  onOpenResult(e) {
    const messageId = e.currentTarget.dataset.id;
    const pages = getCurrentPages();
    const privatePage = pages[pages.length - 3];
    if (privatePage && privatePage.data && Array.isArray(privatePage.data.messages)) {
      const index = privatePage.data.messages.findIndex(item => item._id === messageId);
      if (index >= 0) {
        privatePage.setData({ scrollIntoView: '' });
        setTimeout(() => privatePage.setData({ scrollIntoView: `msg-${index}` }), 80);
      }
    }
    wx.navigateBack({ delta: 2 });
  }
});
