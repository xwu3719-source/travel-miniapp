const cloud = require('../../utils/cloud');

const recorderManager = wx.getRecorderManager();

Page({
  data: {
    tripId: '',
    trip: null,
    members: [],
    currentTab: 'plan', // plan / expense / moment
    currentDay: 0,      // 0 = 全部, 1-N = 第几天

    // 行程
    dayPlans: [],
    planDays: [],

    // 消费
    expenses: [],
    expenseSummary: { total: 0, shared: 0, private: 0 },

    // 动态
    moments: [],
    myOpenid: '',

    // 评论状态
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

    // 弹窗
    showPlanModal: false,
    editingPlanItem: null,
    planForm: { time: '', title: '', location: '', notes: '', type: 'spot' },

    // 设置
    showSetting: false,
    isCreator: false,
    inviteCode: '',
    refreshing: false,
    momentsPageSize: 10,
    momentsHasMore: true,
    momentsLoadingMore: false
  },

  onLoad(options) {
    this.setData({ tripId: options.tripId });

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
    this.loadAll();
  },

  async loadAll() {
    const tripId = this.data.tripId;
    try {
      const db = cloud.db;
      const openid = await cloud.getOpenid();

      // 加载行程详情
      const tripRes = await db.collection('trips').doc(tripId).get();
      const trip = cloud.getDoc(tripRes);
      if (!trip) {
        wx.showToast({ title: '行程不存在', icon: 'none' });
        return setTimeout(() => wx.navigateBack(), 1200);
      }

      // 加载成员
      const { data: members } = await db.collection('trip_members')
        .where({ tripId })
        .get();

      this.setData({ myOpenid: openid });

      const isCreator = members.some(m => m.openid === openid && m.role === 'creator');
      const creatorMember = members.find(m => m.role === 'creator');
      const inviteCode = creatorMember ? creatorMember.inviteCode : '';

      // 加载行程计划
      const { data: dayPlans } = await db.collection('day_plans')
        .where({ tripId })
        .orderBy('dayIndex', 'asc')
        .get();

      const planDays = [];
      for (let i = 1; i <= trip.totalDays; i++) {
        const date = cloud.dateRange(trip.startDate, trip.endDate)[i - 1];
        planDays.push({ dayIndex: i, date, label: `Day ${i}` });
      }

      this.setData({
        trip, members, isCreator, inviteCode,
        dayPlans, planDays,
        currentDay: 0
      });

      this.loadExpenses();
      this.loadMoments();
    } catch (e) {
      console.error('加载行程失败:', e);
    }
  },

  async loadExpenses() {
    try {
      const db = cloud.db;
      const { data: expenses } = await db.collection('expenses')
        .where({ tripId: this.data.tripId })
        .orderBy('createdAt', 'desc')
        .get();

      let total = 0, shared = 0, pri = 0;
      expenses.forEach(e => {
        e.icon = cloud.categoryIcon(e.category);
        total += e.amount || 0;
        if (e.type === 'shared') shared += e.amount || 0;
        else pri += e.amount || 0;
      });

      this.setData({
        expenses,
        expenseSummary: { total, shared, private: pri }
      });
    } catch (e) {
      console.warn('加载消费失败:', e);
    }
  },

  async loadMoments() {
    try {
      const db = cloud.db;
      const { data: moments } = await db.collection('moments')
        .where({ tripId: this.data.tripId })
        .orderBy('createdAt', 'desc')
        .limit(this.data.momentsPageSize)
        .get();
      const myOpenid = this.data.myOpenid;
      const app = getApp();
      const userInfo = app.globalData.userInfo;
      const visible = moments.filter(m => !m.isPrivate || m.authorId === myOpenid);
      visible.forEach(m => {
        m.formattedTime = cloud.formatDate(m.createdAt);
        m.favorited = m.favorites && m.favorites.includes(myOpenid);
        m.liked = m.likes && m.likes.includes(myOpenid);
        if (m.authorId === myOpenid && userInfo) {
          if (userInfo.avatarUrl) m.authorAvatar = userInfo.avatarUrl;
          if (userInfo.nickName) m.authorName = userInfo.nickName;
        }
      });
      this.setData({
        moments: visible,
        momentsHasMore: moments.length >= this.data.momentsPageSize
      });
    } catch (e) {
      console.warn('加载动态失败:', e);
    }
  },

  async onLoadMoreMoments() {
    if (!this.data.momentsHasMore || this.data.momentsLoadingMore) return;
    this.setData({ momentsLoadingMore: true });
    try {
      const db = cloud.db;
      const { data: more } = await db.collection('moments')
        .where({ tripId: this.data.tripId })
        .orderBy('createdAt', 'desc')
        .limit(this.data.momentsPageSize)
        .skip(this.data.moments.length)
        .get();
      const myOpenid = this.data.myOpenid;
      const app = getApp();
      const userInfo = app.globalData.userInfo;
      const visibleMore = more.filter(m => !m.isPrivate || m.authorId === myOpenid);
      visibleMore.forEach(m => {
        m.formattedTime = cloud.formatDate(m.createdAt);
        m.favorited = m.favorites && m.favorites.includes(myOpenid);
        m.liked = m.likes && m.likes.includes(myOpenid);
        if (m.authorId === myOpenid && userInfo) {
          if (userInfo.avatarUrl) m.authorAvatar = userInfo.avatarUrl;
          if (userInfo.nickName) m.authorName = userInfo.nickName;
        }
      });
      this.setData({
        moments: [...this.data.moments, ...visibleMore],
        momentsHasMore: more.length >= this.data.momentsPageSize,
        momentsLoadingMore: false
      });
    } catch (e) {
      console.warn('加载更多动态失败:', e);
      this.setData({ momentsLoadingMore: false });
    }
  },

  // Tab 切换
  onTabTap(e) {
    const { tab } = e.currentTarget.dataset;
    this.setData({ currentTab: tab });
  },

  // 日期切换
  onDayTap(e) {
    const { day } = e.currentTarget.dataset;
    this.setData({ currentDay: day });
  },

  // 获取某天的 plans
  getDayPlans(dayIndex) {
    const dp = this.data.dayPlans.find(p => p.dayIndex === dayIndex);
    return dp ? dp.items || [] : [];
  },

  // 获取当前显示的 plans
  getFilteredPlans() {
    if (this.data.currentDay === 0) {
      return this.data.dayPlans;
    }
    return this.data.dayPlans.filter(p => p.dayIndex === this.data.currentDay);
  },

  // 添加行程项
  onAddPlanItem(e) {
    const { day } = e.currentTarget.dataset;
    this.setData({
      showPlanModal: true,
      editingPlanItem: null,
      currentDay: day || this.data.currentDay || 1,
      planForm: { time: '', title: '', location: '', notes: '', type: 'spot' }
    });
  },

  onPlanFormInput(e) {
    const { field } = e.currentTarget.dataset;
    const pf = { ...this.data.planForm };
    pf[field] = e.detail.value;
    this.setData({ planForm: pf });
  },

  onChooseLocation() {
    wx.chooseLocation({
      success: (res) => {
        const pf = { ...this.data.planForm };
        pf.location = res.name || res.address || '';
        this.setData({ planForm: pf });
      },
      fail: (err) => {
        if (err.errMsg && err.errMsg.indexOf('cancel') === -1) {
          wx.showToast({ title: '选点失败，请在设置中授权位置权限', icon: 'none' });
        }
      }
    });
  },

  async onSavePlanItem() {
    const { planForm, tripId, currentDay } = this.data;
    if (!planForm.title.trim()) return wx.showToast({ title: '请输入活动名称', icon: 'none' });

    const db = cloud.db;
    const trip = this.data.trip;

    // 找到或创建 day_plan
    let dp = this.data.dayPlans.find(p => p.dayIndex === currentDay);
    const items = dp ? [...dp.items, { ...planForm, time: planForm.time || '', location: planForm.location || '', notes: planForm.notes || '' }] : [{ ...planForm, time: planForm.time || '', location: planForm.location || '', notes: planForm.notes || '' }];
    const date = cloud.dateRange(trip.startDate, trip.endDate)[currentDay - 1];

    try {
      if (dp && dp._id) {
        await db.collection('day_plans').doc(dp._id).update({ data: { items } });
      } else {
        await db.collection('day_plans').add({
          data: { tripId, dayIndex: currentDay, date, items }
        });
      }
      this.setData({ showPlanModal: false });
      wx.showToast({ title: '已添加', icon: 'success' });
      this.loadAll();
    } catch (e) {
      console.error('保存行程项失败:', e);
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
  },

  // 关闭弹窗
  onClosePlanModal() {
    this.setData({ showPlanModal: false });
  },

  preventBubble() {},

  // 删除行程项
  async onDeletePlanItem(e) {
    const { day, index } = e.currentTarget.dataset;
    const dp = this.data.dayPlans.find(p => p.dayIndex === day);
    if (!dp || !dp._id) return;

    const items = dp.items.filter((_, i) => i !== index);

    wx.showModal({
      title: '删除该项行程？',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          if (items.length === 0) {
            await cloud.collection('day_plans').doc(dp._id).remove();
          } else {
            await cloud.collection('day_plans').doc(dp._id).update({ data: { items } });
          }
          wx.showToast({ title: '已删除', icon: 'success' });
          this.loadAll();
        } catch (e) {
          wx.showToast({ title: '删除失败', icon: 'none' });
        }
      }
    });
  },

  // 删除行程
  async onDelete() {
    wx.showModal({
      title: '删除行程',
      content: '行程和所有关联数据（计划、消费、动态）将被永久删除，不可恢复。确认删除？',
      confirmText: '删除',
      confirmColor: '#ef4444',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          const db = cloud.db;
          const tripId = this.data.tripId;

          // 删除关联数据
          const delCollection = async (name) => {
            const { data } = await db.collection(name).where({ tripId }).get();
            for (const doc of data) {
              await db.collection(name).doc(doc._id).remove();
            }
          };

          await delCollection('trip_members');
          await delCollection('day_plans');
          await delCollection('expenses');
          await delCollection('moments');
          await db.collection('trips').doc(tripId).remove();

          wx.showToast({ title: '已删除', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 1000);
        } catch (e) {
          console.error('删除失败:', e);
          wx.showToast({ title: '删除失败', icon: 'none' });
        }
      }
    });
  },

  // 编辑行程
  onEditTrip() {
    wx.navigateTo({ url: `/pages/trip-create/trip-create?tripId=${this.data.tripId}` });
  },

  // 归档
  async onArchive() {
    wx.showModal({
      title: '归档行程',
      content: '归档后行程将移入历史记录，确认？',
      success: async (res) => {
        if (!res.confirm) return;
        await cloud.collection('trips').doc(this.data.tripId).update({ data: { status: 'archived' } });
        wx.showToast({ title: '已归档', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 1000);
      }
    });
  },

  // 取消归档
  async onUnarchive() {
    wx.showModal({
      title: '取消归档',
      content: '将此行程恢复到进行中？',
      success: async (res) => {
        if (!res.confirm) return;
        await cloud.collection('trips').doc(this.data.tripId).update({ data: { status: 'active' } });
        wx.showToast({ title: '已恢复', icon: 'success' });
        this.loadAll();
      }
    });
  },

  // 复制邀请码
  onCopyInviteCode() {
    wx.setClipboardData({
      data: this.data.inviteCode,
      success: () => wx.showToast({ title: '邀请码已复制', icon: 'success' })
    });
  },

  // 导航
  onAddExpense() {
    wx.navigateTo({ url: `/pages/add-expense/add-expense?tripId=${this.data.tripId}&members=${JSON.stringify(this.data.members)}` });
  },

  onGoSettlement() {
    wx.navigateTo({ url: `/pages/settlement/settlement?tripId=${this.data.tripId}` });
  },

  onGoMembers() {
    wx.navigateTo({ url: `/pages/members/members?tripId=${this.data.tripId}` });
  },

  onRefresh() {
    this.setData({ refreshing: true });
    this.loadAll().then(() => this.setData({ refreshing: false }));
  },

  onLikeMoment(e) {
    const { id } = e.currentTarget.dataset;
    const openid = this.data.myOpenid;
    const db = cloud.db;
    cloud.getDoc(db.collection('moments').doc(id).get()).then(moment => {
      const likes = moment.likes || [];
      const idx = likes.indexOf(openid);
      if (idx > -1) likes.splice(idx, 1);
      else likes.push(openid);
      return db.collection('moments').doc(id).update({ data: { likes } });
    }).then(() => this.loadMoments()).catch(() => {});
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

  onEditMoment(e) {
    const { id } = e.currentTarget.dataset;
    this.setData({ menuId: '' });
    wx.navigateTo({ url: `/pages/add-moment/add-moment?tripId=${this.data.tripId}&momentId=${id}` });
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
    wx.navigateTo({ url: `/pages/add-moment/add-moment?tripId=${this.data.tripId}` });
  }
});
