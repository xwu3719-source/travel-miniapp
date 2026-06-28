const cloud = require('../../utils/cloud');
const scan = require('../../utils/scan');
const theme = require('../../utils/theme');

Page({
  data: {
    themeStyle: '',
    themeClass: 'theme-blue',
    code: '',
    joining: false
  },

  onLoad(options = {}) {
    const code = String(options.code || '').trim().toUpperCase().slice(0, 12);
    if (code) {
      this.setData({ code }

  onShow() {
    theme.applyToPage(this);
  },);
      if (options.auto === '1') setTimeout(() => this.onJoin(), 260);
    }
  },

  onCodeInput(e) {
    this.setData({ code: e.detail.value.toUpperCase().slice(0, 12) });
  },

  async onJoin() {
    if (this.data.joining) return;
    const code = this.data.code.trim();
    if (code.length < 4) return wx.showToast({ title: '请输入有效邀请码', icon: 'none' });

    this.setData({ joining: true });
    try {
      const result = await cloud.joinTrip(code);

      wx.showToast({ title: result.alreadyJoined ? '你已加入该行程' : '加入成功！', icon: result.alreadyJoined ? 'none' : 'success' });
      setTimeout(() => {
        wx.navigateTo({ url: `/pages/trip-detail/trip-detail?tripId=${result.tripId}` });
      }, 1000);
    } catch (e) {
      console.error('加入失败:', e);
      wx.showToast({ title: e.message || '加入失败，请重试', icon: 'none' });
      this.setData({ joining: false });
    }
  },

  async onScanJoin() {
    try {
      const parsed = await scan.scanCode();
      if (parsed.type === 'trip_invite' && parsed.code) {
        this.setData({ code: parsed.code }, () => this.onJoin());
        return;
      }
      const fallback = scan.parseScanResult(parsed.text || '');
      if (fallback.code) {
        this.setData({ code: fallback.code }, () => this.onJoin());
        return;
      }
      wx.showToast({ title: '没有识别到行程邀请码', icon: 'none' });
    } catch (error) {
      if (/cancel/i.test(String(error && (error.errMsg || error.message)))) return;
      wx.showToast({ title: error.message || '扫码失败', icon: 'none' });
    }
  }
});
