const cloud = require('../../utils/cloud');

Page({
  data: {
    userInfo: {},
    myOpenid: '',
    myMoments: [],
    commentMoments: [],
    favMoments: [],
    likedMoments: [],
    currentTab: 'my',
    loading: true,
    refreshing: false
  },

  onShow() {
    wx.setInnerAudioOption({ obeyMuteSwitch: false });
    this.loadAll();
  },

  onRefresh() {
    this.setData({ refreshing: true });
    this.loadAll().then(() => this.setData({ refreshing: false }));
  },

  async loadAll() {
    try {
      const app = getApp();
      const myOpenid = await cloud.getOpenid();
      const cloudProfile = await cloud.getUserProfile(myOpenid);
      const userInfo = cloudProfile ? {
        nickName: cloudProfile.nickName || '',
        avatarUrl: cloudProfile.avatarUrl || '',
        rawAvatarUrl: cloudProfile.rawAvatarUrl || '',
        avatarFileId: cloudProfile.rawAvatarUrl || '',
        signature: cloudProfile.signature || ''
      } : (app.globalData.userInfo || {});
      if (app.globalData) app.globalData.userInfo = userInfo;
      this.setData({ userInfo, myOpenid, loading: true });

      const { memberships, trips } = await cloud.getMyTrips();
      const tripMap = {};

      if (memberships.length > 0) {
        const tripIds = memberships.map(m => m.tripId);
        trips.forEach(t => { tripMap[t._id] = t.name; });

        const feed = await cloud.getMomentFeed({ tripIds, authorId: myOpenid, limit: 50 });
        const allMoments = feed.moments;

        allMoments.forEach(m => {
          m.formattedTime = cloud.formatDate(m.createdAt);
          m.tripName = tripMap[m.tripId] || '';
          m.liked = m.likes && m.likes.includes(myOpenid);
          m.favorited = m.favorites && m.favorites.includes(myOpenid);
        });

        await cloud.resolveMoments(allMoments);

        // 我的评论：我评论过的动态
        const commentMoments = allMoments.filter(m => {
          const comments = m.comments || [];
          const myComment = comments.find(c => c.openid === myOpenid);
          if (myComment) {
            if (myComment.text) {
              m.myComment = myComment.text;
              m.commentType = 'text';
            } else if (myComment.image) {
              m.myComment = '[图片]';
              m.commentImage = myComment.image;
              m.commentType = 'image';
            } else if (myComment.voice) {
              m.myComment = '[语音]';
              m.commentVoice = myComment.voice;
              m.commentDuration = myComment.voiceDuration || 0;
              m.commentType = 'voice';
            } else if (myComment.location) {
              m.myComment = myComment.location.name || '';
              m.commentType = 'location';
            }
            m.commentTime = cloud.formatDate(myComment.createdAt);
            return true;
          }
          return false;
        });

        await cloud.resolveVoiceUrls(commentMoments, 'commentVoice');
        this.setData({
          myMoments: allMoments.filter(m => m.authorId === myOpenid),
          commentMoments,
          favMoments: allMoments.filter(m => m.favorites && m.favorites.includes(myOpenid) && (!m.isPrivate || m.authorId === myOpenid)),
          likedMoments: allMoments.filter(m => m.likes && m.likes.includes(myOpenid) && (!m.isPrivate || m.authorId === myOpenid))
        });
      } else {
        this.setData({ myMoments: [], commentMoments: [], favMoments: [], likedMoments: [] });
      }

      this.setData({ loading: false });
    } catch (e) {
      console.error('加载个人空间失败:', e);
      this.setData({ loading: false });
    }
  },

  onMomentTap(e) {
    const { id } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/moment-detail/moment-detail?momentId=${id}` });
  },

  onTabTap(e) {
    this.setData({ currentTab: e.currentTarget.dataset.tab });
  },

  onEditMoment(e) {
    const { id } = e.currentTarget.dataset;
    const moment = this.data.myMoments.find(m => m._id === id);
    if (!moment) return;
    wx.navigateTo({ url: `/pages/add-moment/add-moment?tripId=${moment.tripId}&momentId=${id}` });
  },

  async onTogglePrivate(e) {
    const { id } = e.currentTarget.dataset;
    const moment = this.data.myMoments.find(m => m._id === id);
    if (!moment) return;
    try {
      const newVal = await cloud.toggleMomentPrivate(id);
      wx.showToast({ title: newVal ? '已设为私密' : '已设为公开', icon: 'success' });
      this.loadAll();
    } catch (e) {
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
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

  onPreviewMomentImage(e) {
    const { url, urls } = e.currentTarget.dataset;
    const imageUrls = Array.isArray(urls) ? urls.filter(Boolean) : String(urls || url || '').split(',').filter(Boolean);
    if (url && imageUrls.length) wx.previewImage({ urls: imageUrls, current: url });
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

  onDeleteMoment(e) {
    const { id } = e.currentTarget.dataset;
    wx.showModal({
      title: '删除动态',
      content: '确认删除这条动态？',
      confirmColor: '#ef4444',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await cloud.deleteMoment(id);
          wx.showToast({ title: '已删除', icon: 'success' });
          this.loadAll();
        } catch (err) {
          wx.showToast({ title: '删除失败', icon: 'none' });
        }
      }
    });
  },

  preventBubble() {},

  onAuthorTap(e) {
    const { openid, nickName, avatarUrl } = e.currentTarget.dataset;
    cloud.navigateToUserProfile(openid, { nickName, avatarUrl });
  },

  async onToggleFavorite(e) {
    const { id } = e.currentTarget.dataset;
    const myOpenid = this.data.myOpenid;
    if (!myOpenid) return wx.showToast({ title: '请先登录', icon: 'none' });
    try {
      await cloud.toggleFavoriteMoment(id);
      this.loadAll();
    } catch (e) {
      console.error('收藏失败:', e);
      wx.showToast({ title: '操作失败，请重试', icon: 'none' });
    }
  },

});
