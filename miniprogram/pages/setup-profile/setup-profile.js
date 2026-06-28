const cloud = require('../../utils/cloud');
const theme = require('../../utils/theme');

Page({
  data: {
    themeStyle: '',
    themeClass: 'theme-blue',
    avatarUrl: '',
    avatarTempPath: '',
    nickName: '',
    saving: false
  },

  onShow() {
    theme.applyToPage(this);
  },

  onAvatarPickerTap() {
    wx.showActionSheet({
      itemList: ['从相册选择', '拍照'],
      success: res => this.chooseAvatar(res.tapIndex === 0 ? 'album' : 'camera')
    });
  },

  chooseAvatar(sourceType) {
    wx.chooseImage({
      count: 1,
      sizeType: ['original'],
      sourceType: [sourceType],
      success: imgRes => {
        wx.cropImage({
          src: imgRes.tempFilePaths[0],
          cropScale: '1:1',
          success: cropRes => this.setData({ avatarUrl: cropRes.tempFilePath, avatarTempPath: cropRes.tempFilePath }),
          fail: () => wx.showToast({ title: '裁剪失败', icon: 'none' })
        });
      }
    });
  },

  onNickInput(e) {
    this.setData({ nickName: e.detail.value });
  },

  async onConfirm() {
    if (this.data.saving) return;

    const nickName = this.data.nickName.trim();
    if (!nickName) {
      wx.showToast({ title: '请输入昵称', icon: 'none' });
      return;
    }

    this.setData({ saving: true });
    wx.showLoading({ title: '保存中...', mask: true });

    try {
      const openid = await cloud.getOpenid();

      // 上传头像
      let avatarFileId = '';
      let avatarThumbFileId = '';
      if (this.data.avatarTempPath) {
        try {
          const uploaded = await cloud.uploadImageWithThumbnail(this.data.avatarTempPath, 'avatars');
          avatarFileId = uploaded.original;
          avatarThumbFileId = uploaded.thumbnail;
        } catch (_) {
          // 头像上传失败不阻塞流程
        }
      }

      await cloud.upsertUser(openid, nickName, avatarFileId, '', avatarThumbFileId);

      // 更新 globalData
      const app = getApp();
      const displayUrl = avatarFileId ? await cloud.getTempFileUrl(avatarFileId) : '';
      const userInfo = {
        ...(app.globalData && app.globalData.userInfo),
        nickName,
        avatarUrl: displayUrl || avatarFileId || '',
        rawAvatarUrl: avatarFileId,
        rawAvatarThumbUrl: avatarThumbFileId
      };
      if (app.globalData) {
        app.globalData.userInfo = userInfo;
        app.globalData.needsOnboarding = false;
      }

      wx.setStorageSync('onboarding_completed', true);
      wx.hideLoading();
      wx.showToast({ title: '欢迎加入！', icon: 'success' });

      setTimeout(() => {
        wx.switchTab({ url: '/pages/index/index' });
      }, 400);
    } catch (e) {
      console.error('保存失败:', e);
      wx.hideLoading();
      wx.showModal({
        title: '保存失败',
        content: `未能保存你的资料：${e.message || '未知错误'}\n\n请重试或稍后在「我的」页面设置。`,
        confirmText: '重试',
        cancelText: '跳过',
        success: (res) => {
          if (res.confirm) {
            this.setData({ saving: false });
          } else {
            this.finishSetup();
          }
        }
      });
    }
    this.setData({ saving: false });
  },

  onSkip() {
    wx.showModal({
      title: '跳过设置',
      content: '你可以稍后在「我的」页面中设置头像和昵称，确定跳过吗？',
      confirmText: '确定',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) this.finishSetup();
      }
    });
  },

  finishSetup() {
    wx.setStorageSync('onboarding_completed', true);
    const app = getApp();
    if (app.globalData) {
      app.globalData.needsOnboarding = false;
    }
    wx.switchTab({ url: '/pages/index/index' });
  }
});
