const cloud = require('../../utils/cloud');

const recorderManager = wx.getRecorderManager();

Page({
  data: {
    trips: [],
    selectedTripId: '',
    moments: [],
    myOpenid: '',
    loading: true,
    refreshing: false,
    commentingId: '',
    commentText: '',
    commentImage: '',
    commentVoice: '',
    commentVoiceDuration: 0,
    commentLocation: null,
    commentRecording: false,
    recordingDuration: 0,
    _recordingTimer: null,
    menuId: '',
    pageSize: 10,
    hasMore: true,
    loadingMore: false
  },

  onLoad() {
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

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
    }
    this.loadTrips();
  },

  onRefresh() {
    this.setData({ refreshing: true });
    this.loadMoments().then(() => this.setData({ refreshing: false }));
  },

  async loadTrips() {
    try {
      const openid = await cloud.getOpenid();
      this.setData({ myOpenid: openid });
      const db = cloud.db;

      const { data: memberships } = await db.collection('trip_members')
        .where({ openid })
        .get();

      if (!memberships.length) {
        this.setData({ trips: [], loading: false });
        return;
      }

      const tripIds = memberships.map(m => m.tripId);
      const { data: trips } = await db.collection('trips')
        .where({ _id: db.command.in(tripIds), status: 'active' })
        .orderBy('createdAt', 'desc')
        .get();

      this.setData({ trips });

      if (trips.length && !this.data.selectedTripId) {
        this.selectTrip(trips[0]._id);
      } else if (this.data.selectedTripId) {
        this.loadMoments();
      }
    } catch (e) {
      console.error('加载失败:', e);
      this.setData({ loading: false });
    }
  },

  onTripSelect(e) {
    this.selectTrip(e.currentTarget.dataset.id);
  },

  selectTrip(tripId) {
    this.setData({ selectedTripId: tripId, commentingId: '' });
    this.loadMoments();
  },

  async loadMoments() {
    if (!this.data.selectedTripId) return;
    try {
      const { data: moments } = await cloud.collection('moments')
        .where({ tripId: this.data.selectedTripId })
        .orderBy('createdAt', 'desc')
        .limit(this.data.pageSize)
        .get();

      const myOpenid = this.data.myOpenid;
      const app = getApp();
      const userInfo = app.globalData.userInfo;
      const visibleMoments = moments.filter(m => !m.isPrivate || m.authorId === myOpenid);
      visibleMoments.forEach(m => {
        m.formattedTime = cloud.formatDate(m.createdAt);
        m.liked = m.likes && m.likes.includes(myOpenid);
        m.favorited = m.favorites && m.favorites.includes(myOpenid);
        if (m.authorId === myOpenid && userInfo) {
          if (userInfo.avatarUrl) m.authorAvatar = userInfo.avatarUrl;
          if (userInfo.nickName) m.authorName = userInfo.nickName;
        }
      });

      this.setData({
        moments: visibleMoments,
        loading: false,
        hasMore: moments.length >= this.data.pageSize
      });
    } catch (e) {
      console.warn('加载动态失败:', e);
      this.setData({ loading: false });
    }
  },

  async onLoadMore() {
    if (!this.data.hasMore || this.data.loadingMore) return;
    this.setData({ loadingMore: true });
    try {
      const { data: more } = await cloud.collection('moments')
        .where({ tripId: this.data.selectedTripId })
        .orderBy('createdAt', 'desc')
        .limit(this.data.pageSize)
        .skip(this.data.moments.length)
        .get();

      const myOpenid = this.data.myOpenid;
      const app = getApp();
      const userInfo = app.globalData.userInfo;
      const visibleMore = more.filter(m => !m.isPrivate || m.authorId === myOpenid);
      visibleMore.forEach(m => {
        m.formattedTime = cloud.formatDate(m.createdAt);
        m.liked = m.likes && m.likes.includes(myOpenid);
        m.favorited = m.favorites && m.favorites.includes(myOpenid);
        if (m.authorId === myOpenid && userInfo) {
          if (userInfo.avatarUrl) m.authorAvatar = userInfo.avatarUrl;
          if (userInfo.nickName) m.authorName = userInfo.nickName;
        }
      });

      this.setData({
        moments: [...this.data.moments, ...visibleMore],
        hasMore: more.length >= this.data.pageSize,
        loadingMore: false
      });
    } catch (e) {
      console.warn('加载更多失败:', e);
      this.setData({ loadingMore: false });
    }
  },

  async onLike(e) {
    const { id } = e.currentTarget.dataset;
    const myOpenid = this.data.myOpenid;
    const db = cloud.db;

    try {
      const moment = cloud.getDoc(await db.collection('moments').doc(id).get());
      const likes = moment.likes || [];
      const idx = likes.indexOf(myOpenid);
      if (idx > -1) likes.splice(idx, 1);
      else likes.push(myOpenid);
      await db.collection('moments').doc(id).update({ data: { likes } });
      this.loadMoments();
    } catch (e) {
      console.error('点赞失败:', e);
    }
  },

  onToggleCommentInput(e) {
    const { id } = e.currentTarget.dataset;
    if (this.data.commentingId === id) {
      this.setData({ commentingId: '', commentText: '', commentImage: '', commentVoice: '', commentVoiceDuration: 0, commentLocation: null, commentRecording: false });
    } else {
      this.setData({ commentingId: id, commentText: '', commentImage: '', commentVoice: '', commentVoiceDuration: 0, commentLocation: null, commentRecording: false });
    }
  },

  onCommentInput(e) {
    this.setData({ commentText: e.detail.value });
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

  async onPlayCommentVoice(e) {
    const { url } = e.currentTarget.dataset;
    if (!url) return;
    try {
      const res = await wx.cloud.getTempFileURL({ fileList: [url] });
      const item = res.fileList[0];
      if (!item.tempFileURL) { wx.showToast({ title: '音频已过期', icon: 'none' }); return; }
      const innerAudio = wx.createInnerAudioContext();
      innerAudio.src = item.tempFileURL;
      innerAudio.play();
      innerAudio.onEnded(() => innerAudio.destroy());
      innerAudio.onError((err) => {
        console.error('语音播放失败:', err);
        wx.showToast({ title: '播放失败', icon: 'none' });
        innerAudio.destroy();
      });
    } catch (e) {
      console.error('获取语音临时链接失败:', e);
      wx.showToast({ title: '播放失败', icon: 'none' });
    }
  },

  onOpenCommentLocation(e) {
    const { lat, lng, name } = e.currentTarget.dataset;
    wx.openLocation({ latitude: Number(lat), longitude: Number(lng), name, scale: 16 });
  },

  onPreviewCommentImage(e) {
    const { url } = e.currentTarget.dataset;
    wx.previewImage({ urls: [url], current: url });
  },

  async onPostComment(e) {
    const { id } = e.currentTarget.dataset;
    const text = this.data.commentText.trim();
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
      const moment = cloud.getDoc(await db.collection('moments').doc(id).get());
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

      await db.collection('moments').doc(id).update({ data: { comments } });
      this.setData({ commentText: '', commentImage: '', commentVoice: '', commentVoiceDuration: 0, commentLocation: null });
      this.loadMoments();
    } catch (err) {
      console.error('评论失败:', err);
      wx.showToast({ title: '评论失败', icon: 'none' });
    }
  },

  async onToggleFavorite(e) {
    const { id } = e.currentTarget.dataset;
    const db = cloud.db;
    const myOpenid = this.data.myOpenid;
    try {
      const moment = cloud.getDoc(await db.collection('moments').doc(id).get());
      const favorites = moment.favorites || [];
      const idx = favorites.indexOf(myOpenid);
      if (idx > -1) favorites.splice(idx, 1);
      else favorites.push(myOpenid);
      await db.collection('moments').doc(id).update({ data: { favorites } });
      this.loadMoments();
    } catch (e) {
      console.error('收藏失败:', e);
    }
  },

  onEditMoment(e) {
    const { id } = e.currentTarget.dataset;
    this.setData({ menuId: '' });
    wx.navigateTo({ url: `/pages/add-moment/add-moment?tripId=${this.data.selectedTripId}&momentId=${id}` });
  },

  async onTogglePrivate(e) {
    const { id } = e.currentTarget.dataset;
    this.setData({ menuId: '' });
    const moment = this.data.moments.find(m => m._id === id);
    if (!moment) return;
    const newVal = !moment.isPrivate;
    try {
      await cloud.db.collection('moments').doc(id).update({ data: { isPrivate: newVal } });
      wx.showToast({ title: newVal ? '已设为私密' : '已设为公开', icon: 'success' });
      this.loadMoments();
    } catch (e) {
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  onDeleteMoment(e) {
    const { id } = e.currentTarget.dataset;
    this.setData({ menuId: '' });
    wx.showModal({
      title: '删除动态',
      content: '确认删除这条动态？',
      confirmColor: '#ef4444',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await cloud.collection('moments').doc(id).remove();
          wx.showToast({ title: '已删除', icon: 'success' });
          this.loadMoments();
        } catch (err) {
          wx.showToast({ title: '删除失败', icon: 'none' });
        }
      }
    });
  },

  onMomentTap(e) {
    if (this.data.menuId || this.data.commentingId) {
      this.setData({ menuId: '', commentingId: '', commentText: '', commentImage: '', commentVoice: '', commentVoiceDuration: 0, commentLocation: null, commentRecording: false });
      return;
    }
    const { id } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/moment-detail/moment-detail?momentId=${id}` });
  },

  onToggleMenu(e) {
    const { id } = e.currentTarget.dataset;
    this.setData({ menuId: this.data.menuId === id ? '' : id });
  },

  preventBubble() {},

  onAuthorTap(e) {
    const { openid } = e.currentTarget.dataset;
    if (openid) wx.navigateTo({ url: `/pages/user-profile/user-profile?openid=${openid}` });
  },

  onAddMoment() {
    if (!this.data.selectedTripId) {
      return wx.showToast({ title: '请先选择行程', icon: 'none' });
    }
    wx.navigateTo({ url: `/pages/add-moment/add-moment?tripId=${this.data.selectedTripId}` });
  }
});
