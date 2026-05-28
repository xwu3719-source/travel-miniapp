const cloud = require('../../utils/cloud');

const recorderManager = wx.getRecorderManager();

Page({
  data: {
    momentId: '',
    moment: null,
    myOpenid: '',
    commentInput: '',
    commentImage: '',
    commentVoice: '',
    commentVoiceDuration: 0,
    commentLocation: null,
    commentRecording: false,
    recordingDuration: 0,
    _recordingTimer: null,
    menuOpen: false
  },

  onLoad(options) {
    this.setData({ momentId: options.momentId });
    this.loadMoment();
    wx.setInnerAudioOption({ obeyMuteSwitch: false });

    recorderManager.onStop((res) => {
      this.setData({ commentRecording: false, recordingDuration: 0 });
      this._clearRecordingTimer();
      if (!res.tempFilePath) return;
      cloud.uploadFile(res.tempFilePath, 'mp3', 'voices').then(fileID => {
        this.setData({
          commentVoice: fileID,
          commentVoiceDuration: Math.round((res.duration || 0) / 1000)
        });
      }).catch(() => {
        wx.showToast({ title: '语音上传失败', icon: 'none' });
      });
    });

    recorderManager.onError(() => {
      this.setData({ commentRecording: false, recordingDuration: 0 });
      this._clearRecordingTimer();
      wx.showToast({ title: '录音失败', icon: 'none' });
    });
  },

  async loadMoment() {
    try {
      const openid = await cloud.getOpenid();
      const db = cloud.db;
      const moment = cloud.getDoc(await db.collection('moments').doc(this.data.momentId).get());
      if (!moment) {
        wx.showToast({ title: '动态不存在', icon: 'none' });
        return setTimeout(() => wx.navigateBack(), 1200);
      }
      moment.formattedTime = cloud.formatDate(moment.createdAt);
      moment.liked = moment.likes && moment.likes.includes(openid);
      moment.favorited = moment.favorites && moment.favorites.includes(openid);
      moment.isOwner = moment.authorId === openid;
      if (moment.isOwner) {
        const app = getApp();
        const userInfo = app.globalData.userInfo;
        if (userInfo) {
          if (userInfo.avatarUrl) moment.authorAvatar = userInfo.avatarUrl;
          if (userInfo.nickName) moment.authorName = userInfo.nickName;
        }
      }
      await cloud.resolveCommentVoices([moment]);
      this.setData({ moment, myOpenid: openid });
    } catch (e) {
      console.error('加载动态失败:', e);
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  onLike() {
    const { moment, myOpenid } = this.data;
    const db = cloud.db;
    const likes = moment.likes || [];
    const idx = likes.indexOf(myOpenid);
    if (idx > -1) likes.splice(idx, 1);
    else likes.push(myOpenid);
    db.collection('moments').doc(moment._id).update({ data: { likes } }).then(() => {
      this.setData({
        'moment.likes': likes,
        'moment.liked': idx === -1
      });
    }).catch(() => {});
  },

  async onToggleFavorite() {
    const { moment, myOpenid } = this.data;
    const db = cloud.db;
    const favorites = moment.favorites || [];
    const idx = favorites.indexOf(myOpenid);
    if (idx > -1) favorites.splice(idx, 1);
    else favorites.push(myOpenid);
    try {
      await db.collection('moments').doc(moment._id).update({ data: { favorites } });
      this.setData({
        'moment.favorites': favorites,
        'moment.favorited': idx === -1
      });
    } catch (e) {
      console.error('收藏失败:', e);
    }
  },

  onCommentInput(e) {
    this.setData({ commentInput: e.detail.value });
  },

  async onChooseCommentImage() {
    try {
      const res = await wx.chooseImage({
        count: 1,
        sizeType: ['compressed'],
        sourceType: ['album', 'camera']
      });
      const fileID = await cloud.uploadImage(res.tempFilePaths[0], 'comments');
      this.setData({ commentImage: fileID });
    } catch (e) {
      console.warn('选择图片失败:', e);
    }
  },

  onRemoveCommentImage() {
    this.setData({ commentImage: '' });
  },

  onChooseCommentLocation() {
    wx.chooseLocation({
      success: (res) => {
        this.setData({
          commentLocation: {
            name: res.name || res.address || '',
            address: res.address || '',
            lat: res.latitude,
            lng: res.longitude
          }
        });
      },
      fail: (err) => {
        if (err.errMsg && err.errMsg.indexOf('cancel') === -1) {
          wx.showToast({ title: '选点失败，请在设置中授权位置权限', icon: 'none' });
        }
      }
    });
  },

  onRemoveCommentLocation() {
    this.setData({ commentLocation: null });
  },

  onToggleVoice() {
    if (this.data.commentRecording) {
      recorderManager.stop();
      this._clearRecordingTimer();
    } else {
      this.setData({ commentRecording: true, recordingDuration: 0 });
      this._recordingTimer = setInterval(() => {
        this.setData({ recordingDuration: this.data.recordingDuration + 1 });
      }, 1000);
      recorderManager.start({ format: 'mp3' });
    }
  },

  _clearRecordingTimer() {
    if (this._recordingTimer) {
      clearInterval(this._recordingTimer);
      this._recordingTimer = null;
    }
  },

  onRemoveCommentVoice() {
    this.setData({ commentVoice: '', commentVoiceDuration: 0 });
  },

  onPlayCommentVoice(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    if (this._currentAudio) { this._currentAudio.stop(); this._currentAudio.destroy(); this._currentAudio = null; }
    this.setData({ voicePlayingUrl: url });
    const innerAudio = wx.createInnerAudioContext();
    this._currentAudio = innerAudio;
    innerAudio.obeyMuteSwitch = false;
    const clearPlaying = () => {
      if (this._currentAudio === innerAudio) this._currentAudio = null;
      this.setData({ voicePlayingUrl: '' });
    };
    innerAudio.onEnded(() => { clearPlaying(); innerAudio.destroy(); });
    innerAudio.onError((err) => {
      console.error('语音播放失败:', err);
      clearPlaying();
      wx.showToast({ title: '播放失败', icon: 'none' });
      innerAudio.destroy();
    });
    if (url.startsWith('cloud://')) {
      wx.cloud.getTempFileURL({ fileList: [url] }).then(res => {
        const item = res.fileList[0];
        if (item && item.tempFileURL) {
          innerAudio.src = item.tempFileURL;
          innerAudio.play();
        } else {
          clearPlaying();
          wx.showToast({ title: '音频已过期', icon: 'none' });
        }
      }).catch(() => {
        clearPlaying();
        innerAudio.destroy();
        wx.showToast({ title: '播放失败', icon: 'none' });
      });
    } else {
      innerAudio.src = url;
      innerAudio.play();
    }
  },

  onOpenCommentLocation(e) {
    const { lat, lng, name } = e.currentTarget.dataset;
    wx.openLocation({ latitude: Number(lat), longitude: Number(lng), name, scale: 16 });
  },

  async onPlayMomentVideo(e) {
    const { fileId } = e.currentTarget.dataset;
    if (!fileId) return;
    try {
      const res = await wx.cloud.getTempFileURL({ fileList: [fileId] });
      const item = res.fileList[0];
      if (!item.tempFileURL) { wx.showToast({ title: '视频已过期', icon: 'none' }); return; }
      wx.previewMedia({ sources: [{ url: item.tempFileURL, type: 'video' }] });
    } catch (e) {
      console.error('播放视频失败:', e);
      wx.showToast({ title: '播放失败', icon: 'none' });
    }
  },

  onPreviewCommentImage(e) {
    const { url } = e.currentTarget.dataset;
    wx.previewImage({ urls: [url], current: url });
  },

  onPreviewImage(e) {
    const { url, urls } = e.currentTarget.dataset;
    wx.previewImage({ urls: urls.split(','), current: url });
  },

  async onPostComment() {
    const text = this.data.commentInput.trim();
    const image = this.data.commentImage;
    const voice = this.data.commentVoice;
    const voiceDuration = this.data.commentVoiceDuration;
    const location = this.data.commentLocation;
    if (!text && !image && !voice && !location) return;

    const openid = await cloud.getOpenid();
    const app = getApp();
    const userInfo = app.globalData.userInfo || {};

    try {
      const db = cloud.db;
      const moment = cloud.getDoc(await db.collection('moments').doc(this.data.momentId).get());
      const comments = moment.comments || [];
      const comment = {
        openid,
        nickName: userInfo.nickName || '我',
        text,
        createdAt: new Date().toISOString()
      };
      if (image) comment.image = image;
      if (voice) { comment.voice = voice; comment.voiceDuration = voiceDuration; }
      if (location) comment.location = location;
      comments.push(comment);

      await db.collection('moments').doc(this.data.momentId).update({ data: { comments } });
      this.setData({ commentInput: '', commentImage: '', commentVoice: '', commentVoiceDuration: 0, commentLocation: null, 'moment.comments': comments });
    } catch (err) {
      console.error('评论失败:', err);
      wx.showToast({ title: '评论失败', icon: 'none' });
    }
  },

  onPageTap() {
    if (this.data.menuOpen) {
      this.setData({ menuOpen: false });
    }
  },

  onToggleMenu() {
    this.setData({ menuOpen: !this.data.menuOpen });
  },

  preventBubble() {},

  onAuthorTap(e) {
    const { openid } = e.currentTarget.dataset;
    if (openid) wx.navigateTo({ url: `/pages/user-profile/user-profile?openid=${openid}` });
  },

  onEditMoment() {
    this.setData({ menuOpen: false });
    const { moment } = this.data;
    wx.navigateTo({ url: `/pages/add-moment/add-moment?tripId=${moment.tripId}&momentId=${moment._id}` });
  },

  onTogglePrivate() {
    const { moment } = this.data;
    const newVal = !moment.isPrivate;
    cloud.collection('moments').doc(moment._id).update({ data: { isPrivate: newVal } }).then(() => {
      wx.showToast({ title: newVal ? '已设为私密' : '已设为公开', icon: 'success' });
      this.setData({ 'moment.isPrivate': newVal });
    }).catch(() => wx.showToast({ title: '操作失败', icon: 'none' }));
  },

  onDeleteMoment() {
    wx.showModal({
      title: '删除动态',
      content: '确认删除这条动态？',
      confirmColor: '#ef4444',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await cloud.collection('moments').doc(this.data.moment._id).remove();
          wx.showToast({ title: '已删除', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 1000);
        } catch (err) {
          wx.showToast({ title: '删除失败', icon: 'none' });
        }
      }
    });
  }
});
