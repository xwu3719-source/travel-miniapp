const cloud = require('../../utils/cloud');
const theme = require('../../utils/theme');

Page({
  behaviors: [require('../../behaviors/voice-recorder')],
  data: {
    trips: [],
    selectedTripId: '',
    selectedTripName: '',
    moments: [],
    myOpenid: '',
    userInfo: { nickName: '', avatarUrl: '' },
    loading: true,
    refreshing: false,
    commentingId: '',
    commentToolsId: '',
    commentText: '',
    commentImage: '',
    commentLocation: null,
    menuId: '',
    pageSize: 10,
    momentOffset: 0,
    hasMore: true,
    loadingMore: false,
    showTripFilter: false,
    hiddenMomentOpenids: [],
    replyTo: null,
    feedMode: 'trip'
  },

  onLoad() {
    wx.setInnerAudioOption({ obeyMuteSwitch: false });
  },

  onShow() {
    theme.applyToPage(this);
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      const tabBar = this.getTabBar();
      tabBar.setData({ selected: 1 });
      if (tabBar.refreshUnread) tabBar.refreshUnread();
    }
    const needsRefresh = wx.getStorageSync('_momentsNeedsRefresh') === true;
    const now = Date.now();
    if (needsRefresh) wx.removeStorageSync('_momentsNeedsRefresh');
    if (!needsRefresh && this.data.moments.length > 0 && this._lastPageLoadAt && now - this._lastPageLoadAt < 15000) {
      return;
    }
    this._lastPageLoadAt = now;
    this.loadMyProfile();
    this.loadTrips();
  },

  onRefresh() {
    this._lastPageLoadAt = Date.now();
    wx.removeStorageSync('_momentsNeedsRefresh');
    this.setData({ refreshing: true });
    this.loadMoments().then(() => this.setData({ refreshing: false }));
  },

  async loadTrips() {
    try {
      const [openid, preferences, tripResult] = await Promise.all([
        cloud.getOpenid(),
        cloud.getSocialPreferences(),
        cloud.getMyTrips()
      ]);
      this.setData({ myOpenid: openid, hiddenMomentOpenids: preferences.hiddenMomentOpenids || [] });
      const { memberships, trips } = tripResult;

      if (!memberships.length) {
        this.setData({
          trips: [],
          selectedTripId: '',
          selectedTripName: '',
          moments: [],
          hasMore: false,
          loading: false
        });
        return;
      }
      const activeTrips = trips.filter(t => t.status === 'active');

      const nextSelectedTripId = activeTrips.some(t => t._id === this.data.selectedTripId)
        ? this.data.selectedTripId
        : (activeTrips[0] ? activeTrips[0]._id : '');
      const selectedTrip = activeTrips.find(t => t._id === nextSelectedTripId);
      this.setData({
        trips: activeTrips,
        selectedTripId: nextSelectedTripId,
        selectedTripName: selectedTrip ? selectedTrip.name : ''
      });

      if (activeTrips.length) {
        this.loadMoments();
      } else {
        this.setData({ selectedTripId: '', selectedTripName: '', moments: [], hasMore: false, loading: false });
      }
    } catch (e) {
      console.error('加载行程失败:', e);
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载行程失败', icon: 'none' });
    }
  },

  async loadMyProfile() {
    try {
      const app = getApp();
      if (app.globalData && app.globalData.userInfo) {
        this.setData({ userInfo: app.globalData.userInfo });
      }
      const openid = await cloud.getOpenid();
      const profile = await cloud.getUserProfile(openid);
      if (!profile) return;
      const userInfo = {
        nickName: profile.nickName || (this.data.userInfo && this.data.userInfo.nickName) || '',
        avatarUrl: profile.avatarUrl || (this.data.userInfo && this.data.userInfo.avatarUrl) || '',
        rawAvatarUrl: profile.rawAvatarUrl || (this.data.userInfo && this.data.userInfo.rawAvatarUrl) || '',
        avatarFileId: profile.rawAvatarUrl || (this.data.userInfo && this.data.userInfo.avatarFileId) || '',
        signature: typeof profile.signature === 'string'
          ? profile.signature
          : ((this.data.userInfo && this.data.userInfo.signature) || '')
      };
      if (app.globalData) app.globalData.userInfo = userInfo;
      this.setData({ userInfo });
    } catch (e) {
      console.warn('加载我的动态头像失败:', e);
    }
  },

  selectTrip(tripId) {
    const selectedTrip = this.data.trips.find(t => t._id === tripId);
    this.setData({
      selectedTripId: tripId || '',
      selectedTripName: selectedTrip ? selectedTrip.name : '',
      commentingId: '',
      menuId: '',
      momentOffset: 0
    });
    this.loadMoments();
  },

  onSwitchFeedMode(e) {
    const mode = e.currentTarget.dataset.mode;
    if (mode === this.data.feedMode) return;
    this.setData({
      feedMode: mode,
      momentOffset: 0,
      hasMore: true,
      commentingId: '',
      replyTo: null,
      commentText: '',
      commentImage: '',
      commentVoice: '',
      commentVoiceDuration: 0,
      commentLocation: null,
      commentRecording: false
    });
    this.loadMoments();
  },

  onOpenTripFilter() {
    if (!this.data.trips.length) {
      wx.showToast({ title: '还没有加入行程', icon: 'none' });
      return;
    }
    this.setData({ showTripFilter: true });
  },

  onCloseTripFilter() {
    this.setData({ showTripFilter: false });
  },

  onTripFilterSelect(e) {
    this.setData({ showTripFilter: false });
    this.selectTrip(e.currentTarget.dataset.id || '');
  },

  async loadMoments() {
    const isFriendsMode = this.data.feedMode === 'friends';
    if (!isFriendsMode && !this.data.trips.length) {
      this.setData({ moments: [], hasMore: false, loading: false });
      return;
    }
    try {
      let feed;
      if (isFriendsMode) {
        feed = await cloud.getMomentFeed({ friendsOnly: true, limit: this.data.pageSize, offset: 0 });
      } else {
        const tripIds = this.data.selectedTripId
          ? [this.data.selectedTripId]
          : this.data.trips.map(t => t._id);
        feed = await cloud.getMomentFeed({ tripIds, limit: this.data.pageSize, offset: 0 });
      }
      const moments = feed.moments;

      const myOpenid = this.data.myOpenid;
      const tripNameMap = this.tripNameMap();
      const hiddenOpenids = new Set(this.data.hiddenMomentOpenids || []);
      const visibleMoments = moments.filter(m =>
        (!m.isPrivate || m.authorId === myOpenid) && !hiddenOpenids.has(m.authorId)
      );
      visibleMoments.forEach(m => {
        m.formattedTime = cloud.formatDate(m.createdAt);
        m.liked = m.likes && m.likes.includes(myOpenid);
        m.favorited = m.favorites && m.favorites.includes(myOpenid);
        m.tripName = tripNameMap[m.tripId] || '';
      });

      this.setData({
        moments: visibleMoments,
        loading: false,
        momentOffset: feed.totalRead,
        hasMore: feed.totalRead >= this.data.pageSize
      });
      await cloud.resolveMoments(visibleMoments);
      this.setData({ moments: visibleMoments });
    } catch (e) {
      console.warn('加载动态失败:', e);
      this.setData({ loading: false });
    }
  },

  async onLoadMore() {
    if (!this.data.hasMore || this.data.loadingMore) return;
    this.setData({ loadingMore: true });
    const isFriendsMode = this.data.feedMode === 'friends';
    try {
      let feed;
      if (isFriendsMode) {
        feed = await cloud.getMomentFeed({ friendsOnly: true, limit: this.data.pageSize, offset: this.data.momentOffset });
      } else {
        const tripIds = this.data.selectedTripId
          ? [this.data.selectedTripId]
          : this.data.trips.map(t => t._id);
        feed = await cloud.getMomentFeed({ tripIds, limit: this.data.pageSize, offset: this.data.momentOffset });
      }
      const more = feed.moments;

      const myOpenid = this.data.myOpenid;
      const tripNameMap = this.tripNameMap();
      const hiddenOpenids = new Set(this.data.hiddenMomentOpenids || []);
      const visibleMore = more.filter(m =>
        (!m.isPrivate || m.authorId === myOpenid) && !hiddenOpenids.has(m.authorId)
      );
      visibleMore.forEach(m => {
        m.formattedTime = cloud.formatDate(m.createdAt);
        m.liked = m.likes && m.likes.includes(myOpenid);
        m.favorited = m.favorites && m.favorites.includes(myOpenid);
        m.tripName = tripNameMap[m.tripId] || '';
      });

      await cloud.resolveMoments(visibleMore);
      this.setData({
        moments: [...this.data.moments, ...visibleMore],
        momentOffset: this.data.momentOffset + feed.totalRead,
        hasMore: feed.totalRead >= this.data.pageSize,
        loadingMore: false
      });
    } catch (e) {
      console.warn('加载更多失败:', e);
      this.setData({ loadingMore: false });
    }
  },

  tripNameMap() {
    const map = {};
    this.data.trips.forEach(t => { map[t._id] = t.name; });
    return map;
  },

  async onLike(e) {
    const { id } = e.currentTarget.dataset;
    const myOpenid = this.data.myOpenid;
    if (!myOpenid) return wx.showToast({ title: '请先登录', icon: 'none' });
    this._likePendingIds = this._likePendingIds || new Set();
    if (this._likePendingIds.has(id)) return;
    const index = this.data.moments.findIndex(moment => moment._id === id);
    if (index < 0) return;
    const moment = this.data.moments[index];
    const previousLikes = (moment.likes || []).slice();
    const liked = !previousLikes.includes(myOpenid);
    const likes = liked
      ? [...previousLikes, myOpenid]
      : previousLikes.filter(openid => openid !== myOpenid);
    this._likePendingIds.add(id);
    this.setData({
      [`moments[${index}].likes`]: likes,
      [`moments[${index}].liked`]: liked
    });
    try {
      const result = await cloud.toggleLike(id);
      const currentIndex = this.data.moments.findIndex(item => item._id === id);
      if (currentIndex >= 0) {
        this.setData({
          [`moments[${currentIndex}].likes`]: result.likes,
          [`moments[${currentIndex}].liked`]: result.liked
        });
      }
    } catch (e) {
      console.error('点赞失败:', e);
      const currentIndex = this.data.moments.findIndex(item => item._id === id);
      if (currentIndex >= 0) {
        this.setData({
          [`moments[${currentIndex}].likes`]: previousLikes,
          [`moments[${currentIndex}].liked`]: previousLikes.includes(myOpenid)
        });
      }
      wx.showToast({ title: '操作失败，请重试', icon: 'none' });
    } finally {
      this._likePendingIds.delete(id);
    }
  },

  onToggleCommentInput(e) {
    const { id } = e.currentTarget.dataset;
    if (this.data.commentingId === id) {
      this.setData({ commentingId: '', commentToolsId: '', commentText: '', commentImage: '', commentVoice: '', commentVoiceDuration: 0, commentLocation: null, commentRecording: false, replyTo: null });
    } else {
      this.setData({ commentingId: id, commentToolsId: '', commentText: '', commentImage: '', commentVoice: '', commentVoiceDuration: 0, commentLocation: null, commentRecording: false, replyTo: null });
    }
  },

  onToggleCommentTools(e) {
    const { id } = e.currentTarget.dataset;
    this.setData({ commentToolsId: this.data.commentToolsId === id ? '' : id });
  },

  onCommentInput(e) {
    this.setData({ commentText: e.detail.value });
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
      this.setData({ commentImage: fileID, commentToolsId: '' });
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
          },
          commentToolsId: ''
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

  onPreviewCommentImage(e) {
    const { url } = e.currentTarget.dataset;
    wx.previewImage({ urls: [url], current: url });
  },

  onPreviewMomentImage(e) {
    const { url, urls } = e.currentTarget.dataset;
    const imageUrls = Array.isArray(urls) ? urls.filter(Boolean) : String(urls || url || '').split(',').filter(Boolean);
    if (url && imageUrls.length) wx.previewImage({ urls: imageUrls, current: url });
  },

  onTapComment(e) {
    const commentIndex = e.currentTarget.dataset.index;
    const momentId = e.currentTarget.dataset.momentId;
    const momentIdx = this.data.moments.findIndex(m => m._id === momentId);
    if (momentIdx < 0) return;
    const comment = this.data.moments[momentIdx].comments[commentIndex];
    if (!comment) return;
    if (this.data.commentingId !== momentId) {
      this.setData({
        commentingId: momentId,
        commentToolsId: '',
        commentText: '',
        commentImage: '',
        commentVoice: '',
        commentVoiceDuration: 0,
        commentLocation: null,
        commentRecording: false
      });
    }
    this.setData({
      replyTo: {
        momentId,
        index: commentIndex,
        _cid: comment._cid,
        openid: comment.openid,
        nickName: comment.nickName
      }
    });
  },

  async onPostComment(e) {
    const { id } = e.currentTarget.dataset;
    const text = this.data.commentText.trim();
    const image = this.data.commentImage;
    const voice = this.data.commentVoice;
    const voiceDuration = this.data.commentVoiceDuration;
    const location = this.data.commentLocation;
    const replyToData = this.data.replyTo;
    if (!text && !image && !voice && !location) return;

    this._commentPendingIds = this._commentPendingIds || new Set();
    if (this._commentPendingIds.has(id)) return;
    const index = this.data.moments.findIndex(moment => moment._id === id);
    if (index < 0) return;
    const previousComments = (this.data.moments[index].comments || []).slice();
    const comment = { text };
    if (image) comment.image = image;
    if (voice) { comment.voice = voice; comment.voiceDuration = voiceDuration; }
    if (location) comment.location = location;
    if (replyToData && replyToData._cid) {
      comment.replyTo = { _cid: replyToData._cid, openid: replyToData.openid, nickName: replyToData.nickName };
    }
    const optimisticComment = {
      ...comment,
      openid: this.data.myOpenid,
      nickName: this.data.userInfo.nickName || '我',
      createdAt: new Date().toISOString()
    };
    this._commentPendingIds.add(id);
    this.setData({
      [`moments[${index}].comments`]: [...previousComments, optimisticComment],
      commentText: '',
      commentImage: '',
      commentVoice: '',
      commentVoiceDuration: 0,
      commentLocation: null,
      commentToolsId: '',
      replyTo: null
    });
    try {
      const result = await cloud.addComment(id, comment);
      const currentIndex = this.data.moments.findIndex(item => item._id === id);
      if (currentIndex >= 0) this.setData({ [`moments[${currentIndex}].comments`]: result.comments });
    } catch (err) {
      console.error('评论失败:', err);
      const currentIndex = this.data.moments.findIndex(item => item._id === id);
      if (currentIndex >= 0) this.setData({ [`moments[${currentIndex}].comments`]: previousComments });
      this.setData({ commentText: text, commentImage: image, commentVoice: voice, commentVoiceDuration: voiceDuration, commentLocation: location, replyTo: replyToData });
      wx.showToast({ title: '评论失败', icon: 'none' });
    } finally {
      this._commentPendingIds.delete(id);
    }
  },

  async onToggleFavorite(e) {
    const { id } = e.currentTarget.dataset;
    const myOpenid = this.data.myOpenid;
    if (!myOpenid) return wx.showToast({ title: '请先登录', icon: 'none' });
    this._favoritePendingIds = this._favoritePendingIds || new Set();
    if (this._favoritePendingIds.has(id)) return;
    const index = this.data.moments.findIndex(moment => moment._id === id);
    if (index < 0) return;
    const moment = this.data.moments[index];
    const previousFavorites = (moment.favorites || []).slice();
    const favorited = !previousFavorites.includes(myOpenid);
    const favorites = favorited
      ? [...previousFavorites, myOpenid]
      : previousFavorites.filter(openid => openid !== myOpenid);
    this._favoritePendingIds.add(id);
    this.setData({
      [`moments[${index}].favorites`]: favorites,
      [`moments[${index}].favorited`]: favorited
    });
    try {
      const result = await cloud.toggleFavoriteMoment(id);
      const currentIndex = this.data.moments.findIndex(item => item._id === id);
      if (currentIndex >= 0) {
        this.setData({
          [`moments[${currentIndex}].favorites`]: result.favorites,
          [`moments[${currentIndex}].favorited`]: result.favorited
        });
      }
    } catch (e) {
      console.error('收藏失败:', e);
      const currentIndex = this.data.moments.findIndex(item => item._id === id);
      if (currentIndex >= 0) {
        this.setData({
          [`moments[${currentIndex}].favorites`]: previousFavorites,
          [`moments[${currentIndex}].favorited`]: previousFavorites.includes(myOpenid)
        });
      }
      wx.showToast({ title: '操作失败，请重试', icon: 'none' });
    } finally {
      this._favoritePendingIds.delete(id);
    }
  },

  onEditMoment(e) {
    const { id } = e.currentTarget.dataset;
    this.setData({ menuId: '' });
    const moment = this.data.moments.find(item => item._id === id);
    const tripId = (moment && moment.tripId) || this.data.selectedTripId;
    wx.navigateTo({ url: `/pages/add-moment/add-moment?tripId=${encodeURIComponent(tripId || '')}&momentId=${encodeURIComponent(id)}` });
  },

  async onTogglePrivate(e) {
    const { id } = e.currentTarget.dataset;
    this.setData({ menuId: '' });
    const moment = this.data.moments.find(m => m._id === id);
    if (!moment) return;
    try {
      const newVal = await cloud.toggleMomentPrivate(id);
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
          await cloud.deleteMoment(id);
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
    const { openid, nickName, avatarUrl } = e.currentTarget.dataset;
    cloud.navigateToUserProfile(openid, { nickName, avatarUrl });
  },

  onGoMySpace() {
    wx.navigateTo({ url: '/pages/my-moments/my-moments' });
  },

  onShareMoment(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    wx.navigateTo({
      url: `/pages/share-moment/share-moment?momentId=${encodeURIComponent(id)}`,
      success: ({ eventChannel }) => {
        eventChannel.on('shared', ({ momentId, count, shareCount }) => {
          const index = this.data.moments.findIndex(item => item._id === momentId);
          if (index < 0) return;
          const current = Number(this.data.moments[index].shareCount) || 0;
          const next = Number.isFinite(Number(shareCount)) ? Number(shareCount) : current + (Number(count) || 0);
          this.setData({ [`moments[${index}].shareCount`]: next });
        });
      }
    });
  },

  async onAddMoment() {
    let tripId = this.data.selectedTripId;
    if (!tripId) {
      if (!this.data.trips.length) return wx.showToast({ title: '请先加入行程', icon: 'none' });
      if (this.data.trips.length === 1) {
        tripId = this.data.trips[0]._id;
      } else {
        try {
          const result = await wx.showActionSheet({
            alertText: '发布到哪个行程？',
            itemList: this.data.trips.map(item => item.name || item.city || '未命名行程')
          });
          tripId = this.data.trips[result.tapIndex]._id;
        } catch (e) {
          return;
        }
      }
    }
    wx.navigateTo({ url: `/pages/add-moment/add-moment?tripId=${tripId}` });
  }
});
