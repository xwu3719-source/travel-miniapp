const cloud = require('../../utils/cloud');
const drafts = require('../../utils/drafts');
const theme = require('../../utils/theme');

Page({
  data: {
    themeStyle: '',
    themeClass: 'theme-blue',
    momentId: '',
    tripId: '',
    text: '',
    images: [],
    imageThumbs: [],
    videos: [],
    location: '',
    dayIndex: 0,
    tripDays: [],
    privacySettings: { defaultMomentPrivate: false },
    uploading: false,
    publishing: false,
    isEditing: false,
    sendOriginal: false
  },

  onLoad(options) {
    const tripId = options.tripId || '';
    const momentId = options.momentId || '';
    this.setData({ tripId, momentId, isEditing: !!momentId }

  onShow() {
    theme.applyToPage(this);
  },);
    if (!momentId) {
      const draft = drafts.getDraft('moment', tripId || 'general');
      if (draft) this.setData({
        text: draft.text || '',
        images: draft.images || [],
        imageThumbs: draft.imageThumbs || [],
        videos: draft.videos || [],
        location: draft.location || '',
        dayIndex: Number(draft.dayIndex) || 0,
        sendOriginal: draft.sendOriginal === true
      });
    }
    if (tripId) this.loadTripDays(tripId);
    this.loadPrivacySettings();
    if (momentId) this.loadMoment(momentId);
  },

  async loadPrivacySettings() {
    try {
      const openid = await cloud.getOpenid();
      const user = await cloud.getUserProfile(openid);
      this.setData({
        privacySettings: {
          defaultMomentPrivate: !!(user && user.privacySettings && user.privacySettings.defaultMomentPrivate)
        }
      });
    } catch (e) {
      console.warn('加载隐私设置失败:', e);
    }
  },

  async loadMoment(momentId) {
    try {
      const moment = await cloud.getMomentById(momentId);
      if (moment) {
        const tripId = moment.tripId || this.data.tripId;
        const shouldLoadTripDays = !!tripId && tripId !== this.data.tripId;
        this.setData({
          tripId,
          text: moment.text || '',
          images: moment.images || [],
          imageThumbs: moment.imageThumbs || [],
          videos: moment.videos || [],
          location: moment.location || '',
          dayIndex: moment.dayIndex || 0
        });
        if (shouldLoadTripDays) this.loadTripDays(tripId);
      }
    } catch (e) {
      console.warn('加载动态失败:', e);
    }
  },

  async loadTripDays(tripId) {
    try {
      const { trip } = await cloud.getTripSnapshot(tripId, ['trip']);
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

  saveDraft() {
    if (this.data.isEditing) return;
    drafts.saveDraft('moment', this.data.tripId || 'general', {
      text: this.data.text,
      images: this.data.images,
      imageThumbs: this.data.imageThumbs,
      videos: this.data.videos,
      location: this.data.location,
      dayIndex: this.data.dayIndex,
      sendOriginal: this.data.sendOriginal
    });
  },

  onTextInput(e) { this.setData({ text: e.detail.value }, () => this.saveDraft()); },

  onChooseLocation() {
    wx.chooseLocation({
      success: (res) => {
        this.setData({ location: res.name || res.address || '' }, () => this.saveDraft());
      },
      fail: (err) => {
        if (err.errMsg && err.errMsg.indexOf('cancel') === -1) {
          wx.showToast({ title: '选点失败，请在设置中授权位置权限', icon: 'none' });
        }
      }
    });
  },

  onRemoveLocation(e) {
    this.setData({ location: '' }, () => this.saveDraft());
  },

  onDayTap(e) {
    const { day } = e.currentTarget.dataset;
    this.setData({ dayIndex: this.data.dayIndex === day ? 0 : day }, () => this.saveDraft());
  },

  async onAddMedia() {
    const total = this.data.images.length + this.data.videos.length;
    if (total >= 9) return wx.showToast({ title: '最多9个', icon: 'none' });

    try {
      const res = await wx.chooseMedia({
        count: 9 - total,
        mediaType: ['image', 'video'],
        sourceType: ['album', 'camera'],
        sizeType: ['original'],
        maxDuration: 60
      });

      this.setData({ uploading: true });
      const newImages = [...this.data.images];
      const newImageThumbs = [...this.data.imageThumbs];
      const newVideos = [...this.data.videos];

      for (const file of res.tempFiles) {
        if (file.fileType === 'image') {
          if (this.data.sendOriginal) {
            const uploaded = await cloud.uploadImageWithThumbnail(file.tempFilePath, 'moments');
            newImages.push(uploaded.original);
            newImageThumbs.push(uploaded.thumbnail);
          } else {
            const compressed = await cloud.createImageThumbnail(file.tempFilePath, 65);
            const fileID = await cloud.uploadImage(compressed, 'moments');
            newImages.push(fileID);
            newImageThumbs.push(fileID);
          }
        } else {
          if (newVideos.length >= 1) continue;
          const fileID = await cloud.uploadFile(file.tempFilePath, 'mp4', 'videos');
          newVideos.push({ fileID, duration: Math.round(file.duration || 0) });
        }
      }

      this.setData({ images: newImages, imageThumbs: newImageThumbs, videos: newVideos, uploading: false }, () => this.saveDraft());
    } catch (e) {
      console.error('上传失败:', e);
      this.setData({ uploading: false });
      wx.showToast({ title: e.message || '上传失败，请重试', icon: 'none' });
    }
  },

  onToggleOriginal() {
    this.setData({ sendOriginal: !this.data.sendOriginal }, () => this.saveDraft());
  },

  onRemoveImage(e) {
    const { index } = e.currentTarget.dataset;
    const images = [...this.data.images];
    const imageThumbs = [...this.data.imageThumbs];
    images.splice(index, 1);
    imageThumbs.splice(index, 1);
    this.setData({ images, imageThumbs }, () => this.saveDraft());
  },

  onRemoveVideo(e) {
    const { index } = e.currentTarget.dataset;
    const videos = [...this.data.videos];
    videos.splice(index, 1);
    this.setData({ videos }, () => this.saveDraft());
  },

  async onPublish() {
    if (this.data.publishing) return;
    if (!this.data.text.trim() && !this.data.images.length && !this.data.videos.length) {
      return wx.showToast({ title: '请输入文字或添加图片/视频', icon: 'none' });
    }

    this.setData({ publishing: true });
    try {
      if (this.data.isEditing) {
        await cloud.updateMoment(this.data.momentId, {
          text: this.data.text.trim(),
          images: this.data.images,
          imageThumbs: this.data.imageThumbs,
          videos: this.data.videos,
          location: this.data.location.trim(),
          dayIndex: this.data.dayIndex
        });
        wx.showToast({ title: '已保存', icon: 'success' });
      } else {
        await cloud.createMoment({
          tripId: this.data.tripId,
          text: this.data.text.trim(),
          images: this.data.images,
          imageThumbs: this.data.imageThumbs,
          videos: this.data.videos,
          location: this.data.location.trim(),
          dayIndex: this.data.dayIndex,
          isPrivate: this.data.privacySettings.defaultMomentPrivate === true
        });
        wx.showToast({ title: '发布成功', icon: 'success' });
      }
      if (!this.data.isEditing) drafts.clearDraft('moment', this.data.tripId || 'general');
      setTimeout(() => wx.navigateBack(), 1000);
    } catch (e) {
      console.error('发布失败:', e);
      wx.showToast({ title: e.message || '操作失败，请重试', icon: 'none' });
      this.setData({ publishing: false });
    }
  }
});
