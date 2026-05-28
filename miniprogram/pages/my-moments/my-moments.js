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
    this.loadAll();
  },

  onRefresh() {
    this.setData({ refreshing: true });
    this.loadAll().then(() => this.setData({ refreshing: false }));
  },

  async loadAll() {
    try {
      const app = getApp();
      const userInfo = app.globalData.userInfo || {};
      const myOpenid = await cloud.getOpenid();
      this.setData({ userInfo, myOpenid, loading: true });

      const db = cloud.db;
      const { data: memberships } = await db.collection('trip_members')
        .where({ openid: myOpenid })
        .get();

      const tripIds = memberships.map(m => m.tripId);
      const tripMap = {};

      if (tripIds.length > 0) {
        const { data: trips } = await db.collection('trips')
          .where({ _id: db.command.in(tripIds) })
          .get();
        trips.forEach(t => { tripMap[t._id] = t.name; });

        const { data: allMoments } = await db.collection('moments')
          .where({ tripId: db.command.in(tripIds) })
          .orderBy('createdAt', 'desc')
          .limit(100)
          .get();

        allMoments.forEach(m => {
          m.formattedTime = cloud.formatDate(m.createdAt);
          m.tripName = tripMap[m.tripId] || '';
          m.liked = m.likes && m.likes.includes(myOpenid);
          m.favorited = m.favorites && m.favorites.includes(myOpenid);
          if (m.authorId === myOpenid && userInfo) {
            if (userInfo.avatarUrl) m.authorAvatar = userInfo.avatarUrl;
            if (userInfo.nickName) m.authorName = userInfo.nickName;
          }
        });

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
    const newVal = !moment.isPrivate;
    try {
      await cloud.db.collection('moments').doc(id).update({ data: { isPrivate: newVal } });
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

  onDeleteMoment(e) {
    const { id } = e.currentTarget.dataset;
    wx.showModal({
      title: '删除动态',
      content: '确认删除这条动态？',
      confirmColor: '#ef4444',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await cloud.collection('moments').doc(id).remove();
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
    const { openid } = e.currentTarget.dataset;
    if (openid) wx.navigateTo({ url: `/pages/user-profile/user-profile?openid=${openid}` });
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
      this.loadAll();
    } catch (e) {
      console.error('收藏失败:', e);
    }
  },

});
