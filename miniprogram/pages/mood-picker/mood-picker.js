const cloud = require('../../utils/cloud');

const MOOD_PRESETS = [
  { emoji: '飞机', label: '旅行中' },
  { emoji: '听歌识曲', label: '听歌' },
  { emoji: '运动', label: '运动中' },
  { emoji: '餐饮', label: '吃饭中' },
  { emoji: '冥想', label: '放空' },
  { emoji: '难受', label: '低落' }
];

const LEGACY_MOOD_ICON_MAP = {
  '✈️': '飞机', '✈': '飞机', '🛫': '飞机',
  '🎵': '听歌识曲', '🎶': '听歌识曲', '🎧': '听歌识曲',
  '🏃': '运动', '💪': '运动',
  '🍜': '餐饮', '🍔': '餐饮', '🍕': '餐饮', '☕': '餐饮',
  '😢': '难受', '😴': '难受', '🌧️': '难受', '🌙': '难受'
};

function normalizeMoodIcon(value) {
  const icon = String(value || '').trim();
  if (MOOD_PRESETS.some(item => item.emoji === icon)) return icon;
  return LEGACY_MOOD_ICON_MAP[icon] || (icon ? '冥想' : '');
}

Page({
  data: {
    moodPresets: MOOD_PRESETS,
    selectedEmoji: '',
    selectedLabel: '',
    moodText: '',
    hasCurrentMood: false
  },

  onLoad(options) {
    // 如果有当前心情，预填
    const currentEmoji = normalizeMoodIcon(decodeURIComponent(options.emoji || ''));
    const currentText = decodeURIComponent(options.text || '');
    wx.setNavigationBarTitle({ title: currentEmoji || currentText ? '修改心情状态' : '设置心情状态' });
    if (currentEmoji || currentText) {
      this.setData({ hasCurrentMood: true });
    }
    if (currentEmoji) {
      const preset = MOOD_PRESETS.find(p => p.emoji === currentEmoji);
      this.setData({
        selectedEmoji: currentEmoji,
        selectedLabel: preset ? preset.label : '',
        moodText: currentText
      });
    }
  },

  onSelectMood(e) {
    const { emoji, label } = e.currentTarget.dataset;
    if (this.data.selectedEmoji === emoji) {
      // 再次点击取消选中
      this.setData({ selectedEmoji: '', selectedLabel: '' });
    } else {
      this.setData({ selectedEmoji: emoji, selectedLabel: label });
    }
  },

  onTextInput(e) {
    this.setData({ moodText: e.detail.value });
  },

  async onSave() {
    const { selectedEmoji, moodText } = this.data;
    if (!selectedEmoji && !moodText.trim()) {
      wx.showToast({ title: '请选择一个心情', icon: 'none' });
      return;
    }
    if (!selectedEmoji && moodText.trim()) {
      // 只输入文字时使用通用状态图标，避免回退到 emoji。
      this.setData({ selectedEmoji: '冥想' });
    }
    wx.showLoading({ title: '保存中' });
    try {
      const emoji = this.data.selectedEmoji;
      await cloud.setMood(emoji, moodText.trim());
      wx.hideLoading();
      wx.showToast({ title: '心情已更新', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 800);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.message || '保存失败', icon: 'none' });
    }
  },

  async onClearMood() {
    wx.showModal({
      title: '清除状态',
      content: '确认清除当前心情状态？',
      confirmColor: '#ef4444',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await cloud.clearMood();
          wx.showToast({ title: '心情已清除', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 800);
        } catch (e) {
          wx.showToast({ title: e.message || '操作失败', icon: 'none' });
        }
      }
    });
  }
});
