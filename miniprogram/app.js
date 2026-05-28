App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
      this.globalData.cloudReady = false;
      return;
    }
    wx.cloud.init({
      env: 'cloud1-1ga9pk42512defdc',
      traceUser: true
    });
    this.globalData.cloudReady = true;
    // 预加载 openid，确保后续页面直接使用
    wx.cloud.callFunction({ name: 'getOpenid' }).then(res => {
      if (res && res.result && res.result.openid) {
        this.globalData.openid = res.result.openid;
      }
    }).catch(() => {});
  },

  globalData: {
    openid: '',
    cloudReady: true,
    userInfo: null
  }
});
