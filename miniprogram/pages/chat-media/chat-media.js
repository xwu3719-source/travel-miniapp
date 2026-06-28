const cloud = require('../../utils/cloud');
const theme = require('../../utils/theme');

const TABS = [
  { key: 'all', label: '全部' },
  { key: 'image', label: '图片' },
  { key: 'file', label: '文件' },
  { key: 'voice', label: '语音' },
  { key: 'location', label: '位置' }
];

function formatSize(size) {
  const bytes = Number(size) || 0;
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

Page({
  data: {
    themeStyle: '',
    themeClass: 'theme-blue',
    targetOpenid: '',
    groupId: '',
    tabs: TABS,
    activeTab: 'all',
    loading: true,
    media: [],
    filtered: [],
    voicePlayingId: ''
  },

  onLoad(options) {
    this.setData({ targetOpenid: options.openid || '', groupId: options.groupId || '' });
    this.loadMedia();
  },

  onShow() {
    theme.applyToPage(this);
  },

  onUnload() {
    if (this._audio) {
      this._audio.stop();
      this._audio.destroy();
      this._audio = null;
    }
  },

  async loadMedia() {
    this.setData({ loading: true });
    try {
      const media = await cloud.getChatMedia({ targetOpenid: this.data.targetOpenid, groupId: this.data.groupId });
      const normalized = media.map(item => ({
        ...item,
        displayTime: cloud.formatDate(item.createdAt),
        fileSizeText: formatSize(item.fileSize),
        displayTitle: item.type === 'file' ? item.fileName : item.type === 'location' ? item.locationName : item.type === 'voice' ? `${item.voiceDuration || 1} 秒语音` : item.type === 'user_card' ? item.cardName : item.type === 'moment_share' ? (item.momentText || '动态分享') : '图片'
      }));
      this.setData({ media: normalized, loading: false }, () => this.applyFilter());
    } catch (error) {
      this.setData({ loading: false });
      wx.showToast({ title: error.message || '加载失败', icon: 'none' });
    }
  },

  onTab(e) {
    this.setData({ activeTab: e.currentTarget.dataset.key }, () => this.applyFilter());
  },

  applyFilter() {
    const key = this.data.activeTab;
    const filtered = key === 'all' ? this.data.media : this.data.media.filter(item => item.type === key);
    this.setData({ filtered });
  },

  onOpenImage(e) {
    const current = e.currentTarget.dataset.url;
    const urls = this.data.media.filter(item => item.type === 'image' && item.imageFileId).map(item => item.imageFileId);
    if (current) wx.previewImage({ current, urls });
  },

  async onOpenFile(e) {
    const item = this.data.filtered[e.currentTarget.dataset.index];
    if (!item || !item.fileId) return;
    wx.showLoading({ title: '正在打开' });
    try {
      const filePath = await cloud.downloadCloudFile(item.rawFileId || item.fileId);
      await wx.openDocument({ filePath, fileType: item.fileType || '', showMenu: true });
    } catch (error) {
      wx.showToast({ title: error.message || '文件打开失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  onPlayVoice(e) {
    const item = this.data.filtered[e.currentTarget.dataset.index];
    if (!item || !item.voiceFileId) return;
    if (this.data.voicePlayingId === item._id && this._audio) {
      this._audio.stop();
      this.setData({ voicePlayingId: '' });
      return;
    }
    if (this._audio) this._audio.destroy();
    const audio = wx.createInnerAudioContext();
    this._audio = audio;
    audio.src = item.voiceFileId;
    audio.onEnded(() => this.setData({ voicePlayingId: '' }));
    audio.onError(() => {
      this.setData({ voicePlayingId: '' });
      wx.showToast({ title: '语音播放失败', icon: 'none' });
    });
    this.setData({ voicePlayingId: item._id });
    audio.play();
  },

  onOpenLocation(e) {
    const item = this.data.filtered[e.currentTarget.dataset.index];
    if (!item || !Number.isFinite(Number(item.latitude)) || !Number.isFinite(Number(item.longitude))) return;
    wx.openLocation({ latitude: Number(item.latitude), longitude: Number(item.longitude), name: item.locationName || '位置', address: item.locationAddress || '' });
  }
});
