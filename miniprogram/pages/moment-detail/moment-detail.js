const cloud = require('../../utils/cloud');
const theme = require('../../utils/theme');

Page({
  behaviors: [require('../../behaviors/voice-recorder')],
  data: {
    themeStyle: '',
    themeClass: 'theme-blue',
    momentId: '',
    moment: null,
    myOpenid: '',
    commentInput: '',
    commentImage: '',
    commentLocation: null,
    menuOpen: false,
    replyTo: null,
    editingCid: '',
    commentFocus: false
  },

  onLoad(options) {
    this.setData({ momentId: options.momentId }

  onShow() {
    theme.applyToPage(this);
  },);
    this.loadMoment();
    wx.setInnerAudioOption({ obeyMuteSwitch: false });
  },

  async loadMoment() {
    try {
      const openid = await cloud.getOpenid();
      const moment = await cloud.getMomentById(this.data.momentId);
      if (!moment) {
        wx.showToast({ title: '动态不存在', icon: 'none' });
        return setTimeout(() => wx.navigateBack(), 1200);
      }
      moment.formattedTime = cloud.formatDate(moment.createdAt);
      moment.liked = moment.likes && moment.likes.includes(openid);
      moment.favorited = moment.favorites && moment.favorites.includes(openid);
      moment.isOwner = moment.authorId === openid;
      await cloud.resolveMoments([moment]);
      this.setData({ moment, myOpenid: openid });
    } catch (e) {
      console.error('加载动态失败:', e);
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  async onLike() {
    const { moment, myOpenid } = this.data;
    if (!myOpenid) return wx.showToast({ title: '请先登录', icon: 'none' });
    if (this._likePending) return;
    const previousLikes = (moment.likes || []).slice();
    const liked = !previousLikes.includes(myOpenid);
    const likes = liked ? [...previousLikes, myOpenid] : previousLikes.filter(openid => openid !== myOpenid);
    this._likePending = true;
    this.setData({ 'moment.likes': likes, 'moment.liked': liked });
    try {
      const result = await cloud.toggleLike(moment._id);
      this.setData({
        'moment.likes': result.likes,
        'moment.liked': result.liked
      });
    } catch (e) {
      console.error('点赞失败:', e);
      this.setData({
        'moment.likes': previousLikes,
        'moment.liked': previousLikes.includes(myOpenid)
      });
      wx.showToast({ title: '操作失败，请重试', icon: 'none' });
    } finally {
      this._likePending = false;
    }
  },

  async onToggleFavorite() {
    const { moment, myOpenid } = this.data;
    if (!myOpenid) return wx.showToast({ title: '请先登录', icon: 'none' });
    if (this._favoritePending) return;
    const previousFavorites = (moment.favorites || []).slice();
    const favorited = !previousFavorites.includes(myOpenid);
    const favorites = favorited
      ? [...previousFavorites, myOpenid]
      : previousFavorites.filter(openid => openid !== myOpenid);
    this._favoritePending = true;
    this.setData({ 'moment.favorites': favorites, 'moment.favorited': favorited });
    try {
      const result = await cloud.toggleFavoriteMoment(moment._id);
      this.setData({
        'moment.favorites': result.favorites,
        'moment.favorited': result.favorited
      });
    } catch (e) {
      console.error('收藏失败:', e);
      this.setData({
        'moment.favorites': previousFavorites,
        'moment.favorited': previousFavorites.includes(myOpenid)
      });
      wx.showToast({ title: '操作失败，请重试', icon: 'none' });
    } finally {
      this._favoritePending = false;
    }
  },

  onCommentInput(e) {
    this.setData({ commentInput: e.detail.value });
  },

  async onChooseCommentImage() {
    try {
      const res = await wx.chooseImage({
        count: 1,
        sizeType: ['original'],
        sourceType: ['album', 'camera']
      });
      const action = await wx.showActionSheet({ itemList: ['发送原图', '压缩发送'] });
      const useOriginal = action.tapIndex === 0;
      wx.showLoading({ title: useOriginal ? '上传原图' : '压缩中' });
      const filePath = useOriginal
        ? res.tempFilePaths[0]
        : await cloud.createImageThumbnail(res.tempFilePaths[0], 70);
      const fileID = await cloud.uploadImage(filePath, 'comments');
      this.setData({ commentImage: fileID });
    } catch (e) {
      if (!String(e.errMsg || '').includes('cancel')) {
        console.warn('选择图片失败:', e);
      }
    } finally {
      wx.hideLoading();
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

  async onPlayCommentVoice(e) {
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
    try {
      const playUrl = await cloud.getTempFileUrl(url);
      if (!playUrl) {
        clearPlaying();
        innerAudio.destroy();
        return wx.showToast({ title: '音频已过期', icon: 'none' });
      }
      innerAudio.src = playUrl;
      innerAudio.play();
    } catch (e) {
      clearPlaying();
      innerAudio.destroy();
      wx.showToast({ title: '播放失败', icon: 'none' });
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
      const url = await cloud.getTempFileUrl(fileId);
      if (!url) { wx.showToast({ title: '视频已过期', icon: 'none' }); return; }
      wx.previewMedia({ sources: [{ url, type: 'video' }] });
    } catch (e) {
      console.error('播放视频失败:', e);
      wx.showToast({ title: '播放失败', icon: 'none' });
    }
  },

  onPreviewCommentImage(e) {
    const { url } = e.currentTarget.dataset;
    wx.previewImage({ urls: [url], current: url });
  },

  async onPreviewImage(e) {
    const { url, urls } = e.currentTarget.dataset;
    const fileIds = Array.isArray(urls) ? urls.filter(Boolean) : String(urls || url || '').split(',').filter(Boolean);
    // 确保所有图片都转成临时 HTTPS 链接
    const tempUrls = await Promise.all(fileIds.map(id => cloud.getTempFileUrl(id)));
    const validUrls = tempUrls.filter(u => u && u.startsWith('https://'));
    if (validUrls.length === 0) {
      return wx.showToast({ title: '图片加载失败', icon: 'none' });
    }
    // 找到当前图片在列表中的位置
    const idx = fileIds.indexOf(url);
    const current = (idx >= 0 && tempUrls[idx]) ? tempUrls[idx] : validUrls[0];
    wx.previewImage({ urls: validUrls, current });
  },

  onTapComment(e) {
    if (this._commentLongPressed) {
      this._commentLongPressed = false;
      return;
    }
    const index = e.currentTarget.dataset.index;
    const comment = this.data.moment.comments[index];
    if (!comment) return;
    this.setData({ commentFocus: false }, () => {
      this.setData({
        replyTo: { index, _cid: comment._cid, openid: comment.openid, nickName: comment.nickName },
        editingCid: '',
        commentFocus: true
      });
    });
  },

  onLongPressComment(e) {
    this._commentLongPressed = true;
    setTimeout(() => { this._commentLongPressed = false; }, 500);
    const index = e.currentTarget.dataset.index;
    const comment = this.data.moment.comments[index];
    if (!comment) return;
    const { myOpenid, moment } = this.data;
    const isMyComment = comment.openid === myOpenid;
    const isMomentAuthor = moment.authorId === myOpenid;

    const itemList = [];
    if (isMyComment) itemList.push('编辑', '删除');
    else if (isMomentAuthor) itemList.push('删除');
    if (!itemList.length) return;

    wx.showActionSheet({
      itemList,
      success: (res) => {
        const selected = itemList[res.tapIndex];
        if (selected === '编辑') {
          this.setData({
            editingCid: comment._cid,
            commentInput: comment.text || '',
            commentImage: '',
            commentVoice: '',
            commentVoiceDuration: 0,
            commentLocation: null,
            replyTo: null,
            commentFocus: true
          });
        } else if (selected === '删除') {
          wx.showModal({
            title: '删除评论',
            content: '确认删除这条评论？',
            confirmColor: '#ef4444',
            success: async (modalRes) => {
              if (!modalRes.confirm) return;
              try {
                const result = await cloud.deleteComment(this.data.momentId, comment._cid);
                this.setData({ 'moment.comments': result.comments });
                wx.showToast({ title: '已删除', icon: 'success' });
              } catch (err) {
                wx.showToast({ title: err.message || '删除失败', icon: 'none' });
              }
            }
          });
        }
      }
    });
  },

  async onPostComment() {
    const text = this.data.commentInput.trim();
    const image = this.data.commentImage;
    const voice = this.data.commentVoice;
    const voiceDuration = this.data.commentVoiceDuration;
    const location = this.data.commentLocation;
    const editingCid = this.data.editingCid;

    // 编辑模式
    if (editingCid) {
      if (!text) return;
      if (this._commentPending) return;
      const previousComments = (this.data.moment.comments || []).slice();
      this._commentPending = true;
      this.setData({
        editingCid: '',
        commentInput: '',
        commentImage: '',
        commentVoice: '',
        commentVoiceDuration: 0,
        commentLocation: null,
        replyTo: null,
        commentFocus: false
      });
      try {
        const result = await cloud.editComment(this.data.momentId, editingCid, text);
        this.setData({ 'moment.comments': result.comments });
        wx.showToast({ title: '已编辑', icon: 'success' });
      } catch (err) {
        console.error('编辑评论失败:', err);
        this.setData({
          'moment.comments': previousComments,
          editingCid,
          commentInput: text,
          commentFocus: true
        });
        wx.showToast({ title: err.message || '编辑失败', icon: 'none' });
      } finally {
        this._commentPending = false;
      }
      return;
    }

    if (!text && !image && !voice && !location) return;

    if (this._commentPending) return;
    const previousComments = (this.data.moment.comments || []).slice();
    const comment = { text };
    if (image) comment.image = image;
    if (voice) { comment.voice = voice; comment.voiceDuration = voiceDuration; }
    if (location) comment.location = location;
    // 回复某人
    const replyTo = this.data.replyTo;
    if (replyTo) {
      comment.replyTo = { _cid: replyTo._cid, openid: replyTo.openid, nickName: replyTo.nickName };
    }
    const app = getApp();
    const userInfo = (app.globalData && app.globalData.userInfo) || {};
    const optimisticComment = {
      ...comment,
      _cid: 'temp_' + Date.now(),
      openid: this.data.myOpenid,
      nickName: userInfo.nickName || '我',
      createdAt: new Date().toISOString()
    };
    this._commentPending = true;
    this.setData({
      'moment.comments': [...previousComments, optimisticComment],
      commentInput: '',
      commentImage: '',
      commentVoice: '',
      commentVoiceDuration: 0,
      commentLocation: null,
      replyTo: null,
      commentFocus: false
    });
    try {
      const result = await cloud.addComment(this.data.momentId, comment);
      this.setData({ 'moment.comments': result.comments });
    } catch (err) {
      console.error('评论失败:', err);
      this.setData({
        'moment.comments': previousComments,
        commentInput: text,
        commentImage: image,
        commentVoice: voice,
        commentVoiceDuration: voiceDuration,
        commentLocation: location,
        replyTo: replyTo,
        commentFocus: true
      });
      wx.showToast({ title: '评论失败', icon: 'none' });
    } finally {
      this._commentPending = false;
    }
  },


  onCancelEdit() {
    this.setData({
      editingCid: '',
      commentInput: '',
      commentImage: '',
      commentVoice: '',
      commentVoiceDuration: 0,
      commentLocation: null,
      replyTo: null,
      commentFocus: false
    });
  },

  onPageTap() {
    const updates = {};
    if (this.data.menuOpen) updates.menuOpen = false;
    if (this.data.replyTo) updates.replyTo = null;
    if (this.data.commentFocus) updates.commentFocus = false;
    if (Object.keys(updates).length) this.setData(updates);
    wx.hideKeyboard();
  },

  onToggleMenu() {
    this.setData({ menuOpen: !this.data.menuOpen });
  },

  preventBubble() {},

  onAuthorTap(e) {
    const { openid, nickName, avatarUrl } = e.currentTarget.dataset;
    cloud.navigateToUserProfile(openid, { nickName, avatarUrl });
  },

  onEditMoment() {
    this.setData({ menuOpen: false });
    const { moment } = this.data;
    wx.navigateTo({ url: `/pages/add-moment/add-moment?tripId=${moment.tripId}&momentId=${moment._id}` });
  },

  onTogglePrivate() {
    const { moment } = this.data;
    cloud.toggleMomentPrivate(moment._id).then((newVal) => {
      wx.showToast({ title: newVal ? '已设为私密' : '已设为公开', icon: 'success' });
      this.setData({ 'moment.isPrivate': newVal });
    }).catch(() => wx.showToast({ title: '操作失败', icon: 'none' }));
  },

  onShareMoment() {
    const { moment } = this.data;
    if (!moment || !moment._id) return;
    wx.navigateTo({
      url: `/pages/share-moment/share-moment?momentId=${encodeURIComponent(moment._id)}`,
      success: ({ eventChannel }) => {
        eventChannel.on('shared', ({ count, shareCount }) => {
          const current = Number(this.data.moment.shareCount) || 0;
          const next = Number.isFinite(Number(shareCount)) ? Number(shareCount) : current + (Number(count) || 0);
          this.setData({ 'moment.shareCount': next });
        });
      }
    });
  },

  onDeleteMoment() {
    wx.showModal({
      title: '删除动态',
      content: '确认删除这条动态？',
      confirmColor: '#ef4444',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await cloud.deleteMoment(this.data.moment._id);
          wx.showToast({ title: '已删除', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 1000);
        } catch (err) {
          wx.showToast({ title: '删除失败', icon: 'none' });
        }
      }
    });
  }
});
