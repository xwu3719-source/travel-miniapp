const cloud = require('../../utils/cloud');

Page({
  data: {
    momentId: '',
    tripId: '',
    text: '',
    images: [],
    videos: [],
    location: '',
    dayIndex: 0,
    tripDays: [],
    uploading: false,
    publishing: false,
    isEditing: false
  },

  onLoad(options) {
    const tripId = options.tripId;
    const momentId = options.momentId || '';
    this.setData({ tripId, momentId, isEditing: !!momentId });
    this.loadTripDays(tripId);
    if (momentId) this.loadMoment(momentId);
  },

  async loadMoment(momentId) {
    try {
      const moment = cloud.getDoc(await cloud.collection('moments').doc(momentId).get());
      if (moment) {
        this.setData({
          text: moment.text || '',
          images: moment.images || [],
          videos: moment.videos || [],
          location: moment.location || '',
          dayIndex: moment.dayIndex || 0
        });
      }
    } catch (e) {
      console.warn('加载动态失败:', e);
    }
  },

  async loadTripDays(tripId) {
    try {
      const trip = cloud.getDoc(await cloud.collection('trips').doc(tripId).get());
      if (trip) {
        const days = [];
        for (let i = 1; i <= trip.totalDays; i++) {
          days.push({ dayIndex: i, label: `Day ${i}` });
        }
        this.setData({ tripDays: days });
      }
    } catch (e) {
      console.warn('加载天数失败:', e);
    }
  },

  onTextInput(e) { this.setData({ text: e.detail.value }); },

  onChooseLocation() {
    wx.chooseLocation({
      success: (res) => {
        this.setData({ location: res.name || res.address || '' });
      },
      fail: (err) => {
        if (err.errMsg && err.errMsg.indexOf('cancel') === -1) {
          wx.showToast({ title: '选点失败，请在设置中授权位置权限', icon: 'none' });
        }
      }
    });
  },

  onRemoveLocation(e) {
    this.setData({ location: '' });
  },

  onDayTap(e) {
    const { day } = e.currentTarget.dataset;
    this.setData({ dayIndex: this.data.dayIndex === day ? 0 : day });
  },

  async onAddMedia() {
    const total = this.data.images.length + this.data.videos.length;
    if (total >= 9) return wx.showToast({ title: '最多9个', icon: 'none' });

    try {
      const res = await wx.chooseMedia({
        count: 9 - total,
        mediaType: ['image', 'video'],
        sourceType: ['album', 'camera'],
        maxDuration: 60
      });

      this.setData({ uploading: true });
      const newImages = [...this.data.images];
      const newVideos = [...this.data.videos];

      for (const file of res.tempFiles) {
        if (file.fileType === 'image') {
          const fileID = await cloud.uploadImage(file.tempFilePath, 'moments');
          newImages.push(fileID);
        } else {
          if (newVideos.length >= 1) continue;
          const fileID = await cloud.uploadFile(file.tempFilePath, 'mp4', 'videos');
          newVideos.push({ fileID, duration: Math.round(file.duration || 0) });
        }
      }

      this.setData({ images: newImages, videos: newVideos, uploading: false });
    } catch (e) {
      console.error('上传失败:', e);
      this.setData({ uploading: false });
    }
  },

  onRemoveImage(e) {
    const { index } = e.currentTarget.dataset;
    const images = [...this.data.images];
    images.splice(index, 1);
    this.setData({ images });
  },

  onRemoveVideo(e) {
    const { index } = e.currentTarget.dataset;
    const videos = [...this.data.videos];
    videos.splice(index, 1);
    this.setData({ videos });
  },

  async onPublish() {
    if (!this.data.text.trim() && !this.data.images.length && !this.data.videos.length) {
      return wx.showToast({ title: '请输入文字或添加图片/视频', icon: 'none' });
    }

    this.setData({ publishing: true });
    try {
      if (this.data.isEditing) {
        await cloud.collection('moments').doc(this.data.momentId).update({
          data: {
            text: this.data.text.trim(),
            images: this.data.images,
            videos: this.data.videos,
            location: this.data.location.trim(),
            dayIndex: this.data.dayIndex
          }
        });
        wx.showToast({ title: '已保存', icon: 'success' });
      } else {
        const app = getApp();
        const userInfo = app.globalData.userInfo || {};

        await cloud.collection('moments').add({
          data: {
            tripId: this.data.tripId,
            authorId: await cloud.getOpenid(),
            authorName: userInfo.nickName || '我',
            authorAvatar: userInfo.avatarUrl || '',
            text: this.data.text.trim(),
            images: this.data.images,
            videos: this.data.videos,
            location: this.data.location.trim(),
            dayIndex: this.data.dayIndex,
            likes: [],
            comments: [],
            createdAt: new Date().toISOString()
          }
        });
        wx.showToast({ title: '发布成功', icon: 'success' });
      }
      setTimeout(() => wx.navigateBack(), 1000);
    } catch (e) {
      console.error('发布失败:', e);
      wx.showToast({ title: '操作失败', icon: 'none' });
      this.setData({ publishing: false });
    }
  }
});
