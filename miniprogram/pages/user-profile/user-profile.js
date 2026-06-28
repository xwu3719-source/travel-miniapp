const cloud = require('../../utils/cloud');
const theme = require('../../utils/theme');

Page({
  data: {
    themeStyle: '',
    themeClass: 'theme-blue',
    targetOpenid: '',
    user: null,
    myOpenid: '',
    isFollowing: false,
    isFollowedBy: false,
    followStats: { following: 0, followers: 0 },
    momentCount: 0,
    moments: [],
    profileHidden: false,
    canPrivateMessage: true,
    loading: true,
    initialUser: null
  },

  onLoad(options) {
    const safeDecode = (value) => {
      try { return decodeURIComponent(value || ''); }

  onShow() {
    theme.applyToPage(this);
  }, catch (_) { return value || ''; }
    };
    const initialUser = {
      openid: options.openid || '',
      nickName: safeDecode(options.nickName),
      avatarUrl: safeDecode(options.avatarUrl)
    };
    this.setData({
      targetOpenid: initialUser.openid,
      initialUser,
      user: (initialUser.nickName || initialUser.avatarUrl) ? initialUser : null
    });
    this.loadAll();
  },

  async loadAll() {
    try {
      const myOpenid = await cloud.getOpenid();
      const { targetOpenid } = this.data;
      this.setData({ myOpenid });

      // 加载用户信息（users 集合可能还没有该用户的记录，用默认值兜底）
      let user = await cloud.getUserProfile(targetOpenid);
      if (!user) {
        user = { openid: targetOpenid, nickName: '未设置', avatarUrl: '' };
      }
      const privacySettings = {
        allowProfileView: true,
        allowPrivateMessage: true,
        ...(user.privacySettings || {})
      };
      const profileHidden = myOpenid !== targetOpenid && privacySettings.allowProfileView === false;
      const canPrivateMessage = myOpenid !== targetOpenid && privacySettings.allowPrivateMessage !== false;

      // 关注状态（双向）+ 统计
      const [social, followStats] = await Promise.all([
        cloud.getSocialRelationship(targetOpenid),
        cloud.getFollowStats(targetOpenid)
      ]);
      const isFollowing = social.following || false;
      const isFollowedBy = social.followedBy || false;

      // 公开动态
      let moments = [];
      if (!profileHidden) {
        const feed = await cloud.getMomentFeed({ authorId: targetOpenid, limit: 20 });
        moments = feed.moments || [];
      }

      moments.forEach(m => {
        m.formattedTime = cloud.formatDate(m.createdAt);
      });
      await cloud.resolveMoments(moments);
      const fallbackProfile = await this.findProfileFallback(targetOpenid, moments);
      user = this.mergeProfile(user, this.data.initialUser, fallbackProfile, targetOpenid);

      this.setData({
        user, isFollowing, isFollowedBy, followStats,
        momentCount: moments.length,
        moments,
        profileHidden,
        canPrivateMessage,
        loading: false
      });
    } catch (e) {
      console.error('加载用户主页失败:', e);
      this.setData({ loading: false });
    }
  },

  mergeProfile(user, sourceProfile, fallback, openid) {
    const merged = user || { openid, nickName: '', avatarUrl: '' };
    if (sourceProfile && sourceProfile.openid === openid) {
      if (sourceProfile.nickName) merged.nickName = sourceProfile.nickName;
      if (sourceProfile.avatarUrl) merged.avatarUrl = sourceProfile.avatarUrl;
    }
    const missingName = !merged.nickName || merged.nickName === '未设置' || merged.nickName === '未知用户';
    if (missingName && fallback.nickName) merged.nickName = fallback.nickName;
    if (!merged.avatarUrl && fallback.avatarUrl) merged.avatarUrl = fallback.avatarUrl;
    if (!merged.nickName) merged.nickName = '未设置';
    return merged;
  },

  async findProfileFallback(openid, moments) {
    const fallback = { openid, nickName: '', avatarUrl: '' };
    const useName = (name) => {
      if (name && name !== '未设置' && name !== '未知用户') fallback.nickName = name;
    };

    const moment = (moments || []).find(m => m.authorName || m.authorAvatar);
    if (moment) {
      useName(moment.authorName);
      if (moment.authorAvatar) fallback.avatarUrl = moment.authorAvatar;
    }

    await cloud.resolveUserAvatars([fallback]);
    return fallback;
  },

  async onToggleFollow() {
    const { myOpenid, targetOpenid, isFollowing } = this.data;
    if (myOpenid === targetOpenid) return;
    // 取关时需要确认
    if (isFollowing) {
      wx.showModal({
        title: '取消关注',
        content: '确定要取消关注吗？',
        confirmColor: '#ef4444',
        success: async (res) => {
          if (!res.confirm) return;
          try {
            const followed = await cloud.toggleFollow(myOpenid, targetOpenid);
            this.setData({ isFollowing: followed, isFollowedBy: false });
            wx.showToast({ title: '已取消关注', icon: 'success' });
            this.loadAll();
          } catch (e) {
            wx.showToast({ title: '操作失败', icon: 'none' });
          }
        }
      });
      return;
    }
    try {
      const followed = await cloud.toggleFollow(myOpenid, targetOpenid);
      this.setData({ isFollowing: followed });
      wx.showToast({ title: '已关注', icon: 'success' });
      this.loadAll();
    } catch (e) {
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  onGoFollowList(e) {
    const { type } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/follow-list/follow-list?openid=${this.data.targetOpenid}&type=${type}` });
  },

  onMomentTap(e) {
    const { id } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/moment-detail/moment-detail?momentId=${id}` });
  },

  onAvatarError() {
    this.setData({ 'user.avatarUrl': '' });
  },

  onPreviewAvatar() {
    const avatarUrl = this.data.user && this.data.user.avatarUrl;
    if (!avatarUrl) return;
    wx.previewImage({ urls: [avatarUrl], current: avatarUrl });
  },

  onPreviewMomentImage(e) {
    const { url, urls } = e.currentTarget.dataset;
    const imageUrls = Array.isArray(urls) ? urls.filter(Boolean) : String(urls || url || '').split(',').filter(Boolean);
    if (url && imageUrls.length) wx.previewImage({ urls: imageUrls, current: url });
  },

  onOpenChat() {
    const { targetOpenid, user, myOpenid, canPrivateMessage } = this.data;
    if (!targetOpenid || targetOpenid === myOpenid) return;
    if (!canPrivateMessage) return wx.showToast({ title: '对方已关闭私信', icon: 'none' });
    const nickName = encodeURIComponent((user && user.nickName) || '');
    const avatarUrl = encodeURIComponent((user && user.avatarUrl) || '');
    wx.navigateTo({
      url: `/pages/private-chat/private-chat?openid=${encodeURIComponent(targetOpenid)}&nickName=${nickName}&avatarUrl=${avatarUrl}`
    });
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
  }
});
