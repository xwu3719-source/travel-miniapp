const cloud = require('../../utils/cloud');

Page({
  data: {
    avatarUrl: '',
    avatarFileId: '',
    avatarThumbFileId: '',
    nickName: '',
    signature: '',
    loading: true,
    saving: false,
    avatarUploading: false
  },

  onLoad() {
    this.loadProfile();
  },

  async loadProfile() {
    try {
      const app = getApp();
      const cached = (app.globalData && app.globalData.userInfo) || {};
      this.setData({
        avatarUrl: cached.avatarUrl || '',
        avatarFileId: cached.rawAvatarUrl || cached.avatarFileId || cached.avatarUrl || '',
        avatarThumbFileId: cached.rawAvatarThumbUrl || cached.avatarThumbFileId || '',
        nickName: cached.nickName || '',
        signature: cached.signature || ''
      });

      const openid = await cloud.getOpenid();
      const user = await cloud.getUserProfile(openid);
      if (user) {
        const userInfo = {
          avatarUrl: user.avatarUrl || '',
          avatarFileId: user.rawAvatarUrl || user.avatarUrl || '',
          avatarThumbFileId: user.rawAvatarThumbUrl || user.avatarThumbUrl || '',
          nickName: user.nickName || '',
          signature: user.signature || ''
        };
        if (app.globalData) app.globalData.userInfo = userInfo;
        this.setData(userInfo);
      }
    } catch (e) {
      console.warn('加载编辑资料失败:', e);
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
    this.setData({ loading: false });
  },

  onNickInput(e) {
    this.setData({ nickName: e.detail.value });
  },

  onSignatureInput(e) {
    this.setData({ signature: e.detail.value });
  },

  onAvatarTap() {
    const hasAvatar = !!this.data.avatarUrl;
    const itemList = hasAvatar ? ['查看头像', '从相册选择', '拍照'] : ['从相册选择', '拍照'];
    wx.showActionSheet({
      itemList,
      success: (res) => {
        const actionIndex = hasAvatar ? res.tapIndex : res.tapIndex + 1;
        if (actionIndex === 0) {
          wx.previewImage({ urls: [this.data.avatarUrl], current: this.data.avatarUrl });
        } else if (actionIndex === 1) {
          this.chooseAvatar('album');
        } else {
          this.chooseAvatar('camera');
        }
      }
    });
  },

  chooseAvatar(sourceType) {
    wx.chooseImage({
      count: 1,
      sizeType: ['original'],
      sourceType: [sourceType],
      success: (imgRes) => {
        wx.cropImage({
          src: imgRes.tempFilePaths[0],
          cropScale: '1:1',
          success: (cropRes) => this.uploadAvatar(cropRes.tempFilePath),
          fail: () => wx.showToast({ title: '裁剪失败', icon: 'none' })
        });
      }
    });
  },

  async uploadAvatar(tempFilePath) {
    try {
      this.setData({ avatarUploading: true });
      wx.showLoading({ title: '上传头像...' });
      const uploaded = await cloud.uploadImageWithThumbnail(tempFilePath, 'avatars');
      const displayUrl = await cloud.getTempFileUrl(uploaded.original);
      this.setData({ avatarUrl: displayUrl || uploaded.original, avatarFileId: uploaded.original, avatarThumbFileId: uploaded.thumbnail });
      wx.hideLoading();
      wx.showToast({ title: '头像已选择', icon: 'success' });
    } catch (e) {
      console.error('头像上传失败:', e);
      wx.hideLoading();
      wx.showToast({ title: '头像上传失败', icon: 'none' });
    }
    this.setData({ avatarUploading: false });
  },

  onSaveSubmit(e) {
    const values = (e && e.detail && e.detail.value) || {};
    this.onSave({
      nickName: typeof values.nickName === 'string' ? values.nickName : this.data.nickName,
      signature: typeof values.signature === 'string' ? values.signature : this.data.signature
    });
  },

  async onSave(formValues = {}) {
    if (this.data.saving || this.data.avatarUploading) return;
    const nickName = String(formValues.nickName !== undefined ? formValues.nickName : this.data.nickName).trim();
    const signature = String(formValues.signature !== undefined ? formValues.signature : this.data.signature).trim().slice(0, 60);
    if (!nickName) {
      wx.showToast({ title: '请输入昵称', icon: 'none' });
      return;
    }

    this.setData({ saving: true, nickName, signature });
    wx.showLoading({ title: '保存中...' });
    try {
      const openid = await cloud.getOpenid();
      const rawAvatarUrl = this.data.avatarFileId || this.data.avatarUrl || '';
      await cloud.upsertUser(openid, nickName, rawAvatarUrl, signature, this.data.avatarThumbFileId);

      const savedProfile = await cloud.getUserProfile(openid);
      const userInfo = {
        avatarUrl: (savedProfile && savedProfile.avatarUrl) || this.data.avatarUrl,
        rawAvatarUrl: (savedProfile && savedProfile.rawAvatarUrl) || rawAvatarUrl,
        avatarFileId: (savedProfile && savedProfile.rawAvatarUrl) || rawAvatarUrl,
        avatarThumbUrl: (savedProfile && savedProfile.avatarThumbUrl) || '',
        rawAvatarThumbUrl: (savedProfile && savedProfile.rawAvatarThumbUrl) || this.data.avatarThumbFileId,
        avatarThumbFileId: (savedProfile && savedProfile.rawAvatarThumbUrl) || this.data.avatarThumbFileId,
        nickName,
        signature
      };
      const app = getApp();
      if (app.globalData) app.globalData.userInfo = userInfo;
      this.setData({
        avatarUrl: userInfo.avatarUrl,
        avatarFileId: userInfo.rawAvatarUrl,
        nickName: userInfo.nickName,
        signature: userInfo.signature
      });
      this.syncPreviousProfilePage(userInfo);
      wx.hideLoading();
      wx.showToast({ title: '已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 350);
    } catch (e) {
      console.error('保存资料失败:', e);
      wx.hideLoading();
      const message = e.message || '保存失败';
      const isDbMissing = message.includes('collection') ||
        message.includes('Db or Table') ||
        message.includes('-502001') ||
        message.includes('-502005');
      wx.showModal({
        title: '保存失败',
        content: isDbMissing
          ? `云端数据库 users 集合还不可写。请确认当前环境已手动创建 users 集合，并且 login/dbOps 都部署到了同一个云环境。\n\n原始错误：${message}`
          : message,
        showCancel: false,
        confirmText: '知道了'
      });
    }
    this.setData({ saving: false });
  },

  syncPreviousProfilePage(userInfo) {
    const pages = getCurrentPages();
    const prevPage = pages[pages.length - 2];
    if (!prevPage || prevPage.route !== 'pages/profile/profile') return;
    prevPage.setData({
      userInfo,
      hasUserInfo: !!(userInfo.nickName || userInfo.avatarUrl || userInfo.signature)
    });
  }
});
