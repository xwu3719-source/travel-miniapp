const cloud = require('../../utils/cloud');
const chart = require('../../utils/chart');

const recorderManager = wx.getRecorderManager();

Page({
  data: {
    tripId: '',
    trip: null,
    members: [],
    currentTab: 'plan',
    currentDay: 0,      // 0 = 全部, 1-N = 第几天
    showDayDropdown: false,

    // 行程
    dayPlans: [],
    planDays: [],

    // 天气
    weather: [],
    weatherLoading: false,
    weatherError: '',
    tripReminders: [],

    // 倒计时
    countdown: { status: '', text: '' },

    // 消费
    expenses: [],
    expenseSummary: { total: 0, shared: 0, private: 0 },
    expensesLoaded: false,
    dailyBudget: 0,
    todaySpent: 0,
    categoryBreakdown: [],

    // 动态
    moments: [],
    myOpenid: '',
    momentsLoaded: false,

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
    swipedPlanKey: '',
    planForm: { time: '', title: '', location: '', notes: '', type: 'spot' },
    planTypes: [
      { id: 'spot', label: '景点' },
      { id: 'food', label: '餐饮' },
      { id: 'hotel', label: '住宿' },
      { id: 'transport', label: '交通' },
      { id: 'shopping', label: '购物' },
      { id: 'other', label: '其他' }
    ],

    // 设置
    showSetting: false,
    showManageMenu: false,
    isCreator: false,
    inviteCode: '',
    refreshing: false,
    momentsPageSize: 10,
    momentsHasMore: true,
    momentsLoadingMore: false
  },

  onLoad(options) {
    this.setData({ tripId: options.tripId });
    wx.setInnerAudioOption({ obeyMuteSwitch: false });

    recorderManager.onStop((res) => {
      if (!this._ownsCommentRecording) return;
      this._ownsCommentRecording = false;
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
      if (!this._ownsCommentRecording) return;
      this._ownsCommentRecording = false;
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
      const [openid, detail] = await Promise.all([
        cloud.getOpenid(),
        cloud.getTripDetail(tripId)
      ]);
      const { trip, members, dayPlans: rawDayPlans } = detail;
      const dayPlans = this.ensurePlanItemSortIds(rawDayPlans || []);
      if (!trip) {
        wx.showToast({ title: '行程不存在', icon: 'none' });
        return setTimeout(() => wx.navigateBack(), 1200);
      }

      this.setData({ myOpenid: openid });

      const isCreator = members.some(m => m.openid === openid && m.role === 'creator');
      const creatorMember = members.find(m => m.role === 'creator');
      const inviteCode = creatorMember ? creatorMember.inviteCode : '';

      const planDays = [];
      for (let i = 1; i <= trip.totalDays; i++) {
        const date = cloud.dateRange(trip.startDate, trip.endDate)[i - 1];
        planDays.push({ dayIndex: i, date, label: `Day ${i}` });
      }

      this.setData({
        trip, members, isCreator, inviteCode,
        dayPlans, planDays,
        currentDay: 0,
        tripReminders: this.buildTripReminders(trip, dayPlans, null)
      });

      // 倒计时
      this.computeCountdown(trip);

      // 天气：后台异步加载，不阻塞首屏
      if (trip.city) this.loadWeather(trip.city);

      // 基础内容先显示，头像昵称在后台补齐，避免阻塞首屏。
      const memberOpenids = members.map(m => m.openid).filter(Boolean);
      if (memberOpenids.length > 0) {
        cloud.batchGetUsers(memberOpenids).then(userMap => {
          members.forEach(m => {
            const u = userMap[m.openid];
            if (u) {
              if (u.avatarUrl) m.avatarUrl = u.avatarUrl;
              if (u.nickName) m.nickName = u.nickName;
            }
          });
          this.setData({ members });
        }).catch(() => {
          cloud.resolveUserAvatars(members).then(() => this.setData({ members })).catch(() => {});
        });
      }

      if (this.data.currentTab === 'expense') this.loadExpenses();
      if (this.data.currentTab === 'moments') this.loadMoments();
    } catch (e) {
      console.error('加载行程失败:', e);
    }
  },

  async loadWeather(city = this.data.trip && this.data.trip.city) {
    if (!city || this.data.weatherLoading) return;
    this.setData({ weatherLoading: true, weatherError: '' });
    try {
      const weather = await cloud.getWeather(city);
      // 只保留行程日期范围内的天气
      const { trip } = this.data;
      if (trip && trip.startDate && trip.endDate && weather.length) {
        const start = trip.startDate;
        const end = trip.endDate;
        const filtered = weather.filter(w => w.date >= start && w.date <= end);
        this.setData({ weather: filtered, weatherLoading: false, weatherError: '' });
      } else {
        this.setData({ weather, weatherLoading: false, weatherError: '' });
      }
    } catch (error) {
      console.error('[weather] 加载失败:', error);
      this.setData({
        weather: [],
        weatherLoading: false,
        weatherError: error.message || '天气加载失败'
      });
    }
  },

  onRetryWeather() {
    this.loadWeather();
  },

  async loadExpenses() {
    try {
      const { expenses } = await cloud.getTripSnapshot(this.data.tripId, ['expenses']);

      let total = 0, shared = 0, pri = 0;
      const catMap = {};
      const todayStr = new Date().toISOString().slice(0, 10);
      let todaySpent = 0;

      expenses.forEach(e => {
        e.icon = cloud.categoryIcon(e.category);
        const amount = Number(e.amount) || 0;
        const refunded = Number(e.refunded) || 0;
        e.netAmount = Math.max(0, Math.round((amount - refunded) * 100) / 100);
        e.refundText = refunded > 0 ? `已抵扣 ¥${refunded.toFixed(2)} · 净额 ¥${e.netAmount.toFixed(2)}` : '';
        const splitCount = Array.isArray(e.splitAmong) ? e.splitAmong.length : 0;
        e.splitText = e.type === 'shared' && splitCount
          ? `${splitCount} 人分摊 · 人均 ¥${(Math.round(e.netAmount / splitCount * 100) / 100).toFixed(2)}`
          : '';
        total += e.netAmount;
        if (e.type === 'shared') shared += e.netAmount;
        else pri += e.netAmount;

        const cat = e.category || 'other';
        if (!catMap[cat]) catMap[cat] = 0;
        catMap[cat] += e.netAmount;

        // 今日消费
        if (e.createdAt && e.createdAt.slice(0, 10) === todayStr) {
          todaySpent += e.netAmount;
        }
      });

      const labels = { transport: '交通', hotel: '住宿', food: '餐饮', tickets: '门票', shopping: '购物', other: '其他' };
      const breakdown = Object.entries(catMap)
        .map(([key, amount]) => ({ key, label: labels[key] || key, amount, percent: total > 0 ? Math.round(amount / total * 100) : 0 }))
        .sort((a, b) => b.amount - a.amount);

      // 每日预算
      const trip = this.data.trip;
      const totalDays = trip ? (trip.totalDays || 1) : 1;
      const budget = trip ? (trip.totalBudget || 0) : 0;
      const dailyBudget = budget > 0 ? Math.round(budget / totalDays) : 0;
      const budgetPercent = budget > 0 ? Math.min(100, Math.round(total / budget * 100)) : 0;

      this.setData({
        expenses,
        expenseSummary: { total, shared, private: pri, budgetPercent, budget },
        expensesLoaded: true,
        dailyBudget,
        todaySpent,
        categoryBreakdown: breakdown,
        tripReminders: this.buildTripReminders(this.data.trip, this.data.dayPlans, { total, budget, budgetPercent })
      });

      // 渲染迷你饼图
      if (breakdown.length > 0 && total > 0) {
        setTimeout(() => {
          chart.drawPieChart('miniPieChart', breakdown, total, { width: 200, height: 200, innerRadius: 0.5 }).catch(() => {});
        }, 300);
      }
    } catch (e) {
      console.warn('加载消费失败:', e);
    }
  },

  buildTripReminders(trip, dayPlans, expenseSummary) {
    if (!trip) return [];
    const reminders = [];
    const today = new Date().toISOString().slice(0, 10);
    const planItems = (dayPlans || []).flatMap(day => day.items || []);
    const untimedCount = planItems.filter(item => !item.time).length;

    if (trip.status === 'archived') {
      reminders.push({
        type: 'archive',
        title: '这趟已经归档',
        text: '可以查看旅行总结、复制为新行程或保存为模板。',
        action: '看总结'
      });
    } else if (trip.startDate && today < trip.startDate) {
      const days = Math.ceil((new Date(`${trip.startDate}T00:00:00`) - new Date(`${today}T00:00:00`)) / 86400000);
      if (days <= 3) {
        reminders.push({
          type: 'time',
          title: `距出发还有 ${days} 天`,
          text: planItems.length ? '可以再检查集合时间、证件和行李清单。' : '还没有日程安排，建议先放一个集合点。',
          action: planItems.length ? '看总结' : '去规划'
        });
      }
    } else if (trip.startDate && trip.endDate && today >= trip.startDate && today <= trip.endDate) {
      reminders.push({
        type: 'active',
        title: '旅行进行中',
        text: '记得顺手补动态和账本，结束后会自动变成旅行回忆。',
        action: '看总结'
      });
    }

    if (!planItems.length && trip.status !== 'archived') {
      reminders.push({
        type: 'plan',
        title: '还没有行程安排',
        text: '可以先添加每天的关键地点，不用一次填完。',
        action: '去规划'
      });
    } else if (untimedCount >= 3 && trip.status !== 'archived') {
      reminders.push({
        type: 'plan',
        title: '有活动没写时间',
        text: `${untimedCount} 个安排还没有时间，出发前可以顺一下。`,
        action: '去规划'
      });
    }

    const budget = Number(expenseSummary && expenseSummary.budget) || Number(trip.totalBudget) || 0;
    const total = Number(expenseSummary && expenseSummary.total) || 0;
    if (budget > 0 && total > 0) {
      const percent = Math.round(total / budget * 100);
      if (percent >= 100) {
        reminders.push({
          type: 'budget-danger',
          title: '预算已超支',
          text: `已用 ${percent}% · 超出 ¥${(total - budget).toFixed(2)}，建议先看账本结算。`,
          action: '看账本'
        });
      } else if (percent >= 80) {
        reminders.push({
          type: 'budget',
          title: '预算快用完了',
          text: `已用 ${percent}% · 剩余 ¥${(budget - total).toFixed(2)}。`,
          action: '看账本'
        });
      }
    } else if (!budget && trip.status !== 'archived') {
      reminders.push({
        type: 'budget',
        title: '还没设置预算',
        text: '设置预算后，账本会提示快超支和公共支出占比。',
        action: '看账本'
      });
    }
    return reminders.slice(0, 3);
  },

  async loadMoments() {
    try {
      const feed = await cloud.getMomentFeed({ tripId: this.data.tripId, limit: this.data.momentsPageSize });
      const moments = feed.moments;
      const myOpenid = this.data.myOpenid;
      const visible = moments.filter(m => !m.isPrivate || m.authorId === myOpenid);
      visible.forEach(m => {
        m.formattedTime = cloud.formatDate(m.createdAt);
        m.favorited = m.favorites && m.favorites.includes(myOpenid);
        m.liked = m.likes && m.likes.includes(myOpenid);
      });
      this.setData({
        moments: visible,
        momentsHasMore: moments.length >= this.data.momentsPageSize,
        momentsLoaded: true
      });
      await cloud.resolveMoments(visible);
      this.setData({ moments: visible });
    } catch (e) {
      console.warn('加载动态失败:', e);
    }
  },

  async onLoadMoreMoments() {
    if (!this.data.momentsHasMore || this.data.momentsLoadingMore) return;
    this.setData({ momentsLoadingMore: true });
    try {
      const feed = await cloud.getMomentFeed({ tripId: this.data.tripId, limit: this.data.momentsPageSize, offset: this.data.moments.length });
      const more = feed.moments;
      const myOpenid = this.data.myOpenid;
      const visibleMore = more.filter(m => !m.isPrivate || m.authorId === myOpenid);
      visibleMore.forEach(m => {
        m.formattedTime = cloud.formatDate(m.createdAt);
        m.favorited = m.favorites && m.favorites.includes(myOpenid);
        m.liked = m.likes && m.likes.includes(myOpenid);
      });
      await cloud.resolveMoments(visibleMore);
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
    if (tab === 'expense' && !this.data.expensesLoaded) this.loadExpenses();
    if (tab === 'moments' && !this.data.momentsLoaded) this.loadMoments();
  },

  ensurePlanItemSortIds(dayPlans) {
    const stamp = Date.now().toString(36);
    return (dayPlans || []).map(dp => ({
      ...dp,
      items: (dp.items || []).map((item, index) => ({
        ...item,
        sortId: item.sortId || `plan_${dp._id || dp.dayIndex}_${index}_${stamp}`
      }))
    }));
  },

  // 日期下拉
  onToggleDayDropdown() {
    this.setData({ showDayDropdown: !this.data.showDayDropdown });
  },

  onDaySelect(e) {
    const { day } = e.currentTarget.dataset;
    this.setData({ currentDay: day, showDayDropdown: false });
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
    if (this.data.trip && this.data.trip.status === 'archived') return;
    const { day } = e.currentTarget.dataset;
    this.setData({
      showPlanModal: true,
      editingPlanItem: null,
      currentDay: day || this.data.currentDay || 1,
      planForm: { time: '', title: '', location: '', notes: '', type: 'spot' }
    });
  },

  onPlanTouchStart(e) {
    const touch = e.touches && e.touches[0];
    if (!touch) return;
    this._planTouchStartX = touch.clientX;
    this._planTouchStartY = touch.clientY;
  },

  onPlanTouchEnd(e) {
    const touch = e.changedTouches && e.changedTouches[0];
    if (!touch || this._planTouchStartX == null) return;
    const dx = touch.clientX - this._planTouchStartX;
    const dy = touch.clientY - this._planTouchStartY;
    const key = `${e.currentTarget.dataset.day}-${e.currentTarget.dataset.index}`;
    this._planTouchStartX = null;
    this._planTouchStartY = null;
    if (Math.abs(dx) < Math.abs(dy)) return;
    if (dx < -36) this.setData({ swipedPlanKey: key });
    else if (dx > 24 || Math.abs(dx) < 8) this.setData({ swipedPlanKey: '' });
  },

  onEditPlanItem(e) {
    if (this.data.trip && this.data.trip.status === 'archived') return;
    const day = Number(e.currentTarget.dataset.day);
    const index = Number(e.currentTarget.dataset.index);
    const plan = this.data.dayPlans.find(dp => dp.dayIndex === day);
    const item = plan && plan.items && plan.items[index];
    if (!plan || !item) return;
    this.setData({
      showPlanModal: true,
      swipedPlanKey: '',
      currentDay: day,
      editingPlanItem: { day, index, dpId: plan._id },
      planForm: {
        time: item.time || '',
        title: item.title || '',
        location: item.location || '',
        locationAddress: item.locationAddress || '',
        latitude: item.latitude,
        longitude: item.longitude,
        notes: item.notes || '',
        type: item.type || 'spot',
        sortId: item.sortId
      }
    });
  },

  onPlanFormInput(e) {
    const { field } = e.currentTarget.dataset;
    const pf = { ...this.data.planForm };
    pf[field] = e.detail.value;
    this.setData({ planForm: pf });
  },

  onPlanTimeChange(e) {
    this.setData({ 'planForm.time': e.detail.value || '' });
  },

  onPlanTypeSelect(e) {
    this.setData({ 'planForm.type': e.currentTarget.dataset.type || 'other' });
  },

  onChooseLocation() {
    wx.chooseLocation({
      success: (res) => {
        const pf = { ...this.data.planForm };
        pf.location = res.name || res.address || '';
        pf.locationAddress = res.address || '';
        pf.latitude = res.latitude;
        pf.longitude = res.longitude;
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
    if (this.data.trip && this.data.trip.status === 'archived') {
      return wx.showToast({ title: '历史行程为只读', icon: 'none' });
    }
    const { planForm, tripId, currentDay } = this.data;
    if (!planForm.title.trim()) return wx.showToast({ title: '请输入活动名称', icon: 'none' });

    const trip = this.data.trip;

    // 找到或创建 day_plan
    let dp = this.data.dayPlans.find(p => p.dayIndex === currentDay);
    const savedItem = {
      ...planForm,
      sortId: planForm.sortId || `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      time: planForm.time || '',
      location: planForm.location || '',
      notes: planForm.notes || ''
    };
    let items;
    if (this.data.editingPlanItem && dp) {
      items = [...(dp.items || [])];
      items[this.data.editingPlanItem.index] = savedItem;
    } else {
      items = dp ? [...dp.items, savedItem] : [savedItem];
    }
    const date = cloud.dateRange(trip.startDate, trip.endDate)[currentDay - 1];

    try {
      await cloud.upsertDayPlan(dp && dp._id, tripId, currentDay, date, items);
      const edited = !!this.data.editingPlanItem;
      this.setData({ showPlanModal: false, editingPlanItem: null, swipedPlanKey: '' });
      wx.showToast({ title: edited ? '已更新' : '已添加', icon: 'success' });
      this.loadAll();
    } catch (e) {
      console.error('保存行程项失败:', e);
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
  },

  // 关闭弹窗
  onClosePlanModal() {
    this.setData({ showPlanModal: false, editingPlanItem: null });
  },

  preventBubble() {},

  // 删除行程项
  async onDeletePlanItem(e) {
    if (this.data.trip && this.data.trip.status === 'archived') return;
    const { day, index } = e.currentTarget.dataset;
    const dp = this.data.dayPlans.find(p => p.dayIndex === day);
    if (!dp || !dp._id) return;

    const items = dp.items.filter((_, i) => i !== Number(index));

    wx.showModal({
      title: '删除该项行程？',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await cloud.deleteDayPlanItem(dp._id, items.length === 0 ? null : items);
          this.setData({ swipedPlanKey: '' });
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
    this.setData({ showManageMenu: false });
    wx.showModal({
      title: '删除行程',
      content: '行程和所有关联数据（计划、消费、动态）将被永久删除，不可恢复。确认删除？',
      confirmText: '删除',
      confirmColor: '#ef4444',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await cloud.deleteTrip(this.data.tripId);
          wx.showToast({ title: '已删除', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 1000);
        } catch (e) {
          console.error('删除失败:', e);
          const msg = e.message || e.errMsg || '删除失败';
          wx.showToast({ title: msg, icon: 'none', duration: 2500 });
        }
      }
    });
  },

  // 编辑行程
  onEditTrip() {
    this.setData({ showManageMenu: false });
    wx.navigateTo({ url: `/pages/trip-create/trip-create?tripId=${this.data.tripId}` });
  },

  onCopyTrip() {
    this.setData({ showManageMenu: false });
    wx.navigateTo({ url: `/pages/trip-create/trip-create?copyFromTripId=${this.data.tripId}` });
  },

  onSaveAsTemplate() {
    this.setData({ showManageMenu: false });
    const trip = this.data.trip || {};
    wx.showModal({
      title: '保存为模板',
      content: '',
      editable: true,
      placeholderText: `${trip.name || '行程'}模板`,
      confirmText: '保存',
      confirmColor: '#5b9ff5',
      success: async res => {
        if (!res.confirm) return;
        const name = String(res.content || `${trip.name || '行程'}模板`).trim();
        try {
          await cloud.saveTripTemplate(this.data.tripId, name);
          wx.showToast({ title: '模板已保存', icon: 'none' });
        } catch (error) {
          wx.showToast({ title: error.message || '保存模板失败', icon: 'none' });
        }
      }
    });
  },

  onToggleManageMenu() {
    this.setData({ showManageMenu: !this.data.showManageMenu });
  },

  onCloseManageMenu() {
    this.setData({ showManageMenu: false });
  },

  // 归档
  async onArchive() {
    this.setData({ showManageMenu: false });
    wx.showModal({
      title: '归档行程',
      content: '归档后行程将移入历史记录，确认？',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await cloud.setTripStatus(this.data.tripId, 'archived');
          wx.showToast({ title: '已归档', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 1000);
        } catch (e) {
          wx.showToast({ title: e.message || '操作失败', icon: 'none' });
        }
      }
    });
  },

  // 取消归档
  async onUnarchive() {
    this.setData({ showManageMenu: false });
    wx.showModal({
      title: '取消归档',
      content: '将此行程恢复到进行中？',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await cloud.setTripStatus(this.data.tripId, 'active');
          wx.showToast({ title: '已恢复', icon: 'success' });
          this.loadAll();
        } catch (e) {
          wx.showToast({ title: e.message || '操作失败', icon: 'none' });
        }
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
    if (this.data.trip && this.data.trip.status === 'archived') return;
    wx.navigateTo({ url: `/pages/add-expense/add-expense?tripId=${this.data.tripId}&members=${encodeURIComponent(JSON.stringify(this.data.members))}` });
  },

  onGoSettlement() {
    wx.navigateTo({ url: `/pages/settlement/settlement?tripId=${this.data.tripId}` });
  },

  onGoSummary() {
    wx.navigateTo({ url: `/pages/trip-summary/trip-summary?tripId=${this.data.tripId}` });
  },

  onGoVotes() {
    wx.navigateTo({ url: `/pages/trip-votes/trip-votes?tripId=${this.data.tripId}` });
  },

  onReminderTap(e) {
    const action = e.currentTarget.dataset.action;
    if (action === '去规划') {
      this.setData({ currentTab: 'plan' });
    } else if (action === '看账本') {
      this.setData({ currentTab: 'expense' });
      if (!this.data.expensesLoaded) this.loadExpenses();
    } else {
      this.onGoSummary();
    }
  },

  onGoMembers() {
    wx.navigateTo({ url: `/pages/members/members?tripId=${this.data.tripId}` });
  },

  onExpenseDetail(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    wx.navigateTo({ url: `/pages/expense-detail/expense-detail?tripId=${this.data.tripId}&expenseId=${id}` });
  },

  onRefresh() {
    this.setData({ refreshing: true });
    this.loadAll().then(() => this.setData({ refreshing: false }));
  },

  async onLikeMoment(e) {
    const { id } = e.currentTarget.dataset;
    const openid = this.data.myOpenid;
    if (!openid) return wx.showToast({ title: '请先登录', icon: 'none' });
    this._likePendingIds = this._likePendingIds || new Set();
    if (this._likePendingIds.has(id)) return;
    const index = this.data.moments.findIndex(moment => moment._id === id);
    if (index < 0) return;
    const previousLikes = (this.data.moments[index].likes || []).slice();
    const liked = !previousLikes.includes(openid);
    const likes = liked ? [...previousLikes, openid] : previousLikes.filter(id => id !== openid);
    this._likePendingIds.add(id);
    this.setData({
      [`moments[${index}].likes`]: likes,
      [`moments[${index}].liked`]: liked
    });
    try {
      const result = await cloud.toggleLike(id);
      const currentIndex = this.data.moments.findIndex(moment => moment._id === id);
      if (currentIndex >= 0) {
        this.setData({
          [`moments[${currentIndex}].likes`]: result.likes,
          [`moments[${currentIndex}].liked`]: result.liked
        });
      }
    } catch (e) {
      console.error('点赞失败:', e);
      const currentIndex = this.data.moments.findIndex(moment => moment._id === id);
      if (currentIndex >= 0) {
        this.setData({
          [`moments[${currentIndex}].likes`]: previousLikes,
          [`moments[${currentIndex}].liked`]: previousLikes.includes(openid)
        });
      }
      wx.showToast({ title: '操作失败，请重试', icon: 'none' });
    } finally {
      this._likePendingIds.delete(id);
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
    const previousFavorites = (this.data.moments[index].favorites || []).slice();
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
      const currentIndex = this.data.moments.findIndex(moment => moment._id === id);
      if (currentIndex >= 0) {
        this.setData({
          [`moments[${currentIndex}].favorites`]: result.favorites,
          [`moments[${currentIndex}].favorited`]: result.favorited
        });
      }
    } catch (e) {
      console.error('收藏失败:', e);
      const currentIndex = this.data.moments.findIndex(moment => moment._id === id);
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

  onToggleVoice() {
    if (this.data.commentRecording) {
      recorderManager.stop();
      this._clearRecordingTimer();
    } else {
      this._ownsCommentRecording = true;
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

  async onPostComment(e) {
    const { id } = e.currentTarget.dataset;
    const text = this.data.commentText.trim();
    const image = this.data.commentImage;
    const voice = this.data.commentVoice;
    const voiceDuration = this.data.commentVoiceDuration;
    const location = this.data.commentLocation;
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
    const currentMember = this.data.members.find(member => member.openid === this.data.myOpenid);
    const optimisticComment = {
      ...comment,
      openid: this.data.myOpenid,
      nickName: (currentMember && currentMember.nickName) || '我',
      createdAt: new Date().toISOString()
    };
    this._commentPendingIds.add(id);
    this.setData({
      [`moments[${index}].comments`]: [...previousComments, optimisticComment],
      commentText: '',
      commentImage: '',
      commentVoice: '',
      commentVoiceDuration: 0,
      commentLocation: null
    });
    try {
      const result = await cloud.addComment(id, comment);
      const currentIndex = this.data.moments.findIndex(moment => moment._id === id);
      if (currentIndex >= 0) this.setData({ [`moments[${currentIndex}].comments`]: result.comments });
    } catch (err) {
      console.error('评论失败:', err);
      const currentIndex = this.data.moments.findIndex(moment => moment._id === id);
      if (currentIndex >= 0) this.setData({ [`moments[${currentIndex}].comments`]: previousComments });
      this.setData({ commentText: text, commentImage: image, commentVoice: voice, commentVoiceDuration: voiceDuration, commentLocation: location });
      wx.showToast({ title: '评论失败', icon: 'none' });
    } finally {
      this._commentPendingIds.delete(id);
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

  // 倒计时
  computeCountdown(trip) {
    if (!trip || !trip.startDate || !trip.endDate) return;
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const start = trip.startDate;
    const end = trip.endDate;
    if (today < start) {
      const days = Math.ceil((new Date(start) - now) / 86400000);
      this.setData({ countdown: { status: 'upcoming', text: `距出发还有 ${days} 天` } });
    } else if (today >= start && today <= end) {
      const dayNum = Math.ceil((now - new Date(start)) / 86400000) + 1;
      this.setData({ countdown: { status: 'active', text: `旅行中 · Day ${dayNum}` } });
    } else {
      this.setData({ countdown: { status: 'done', text: '行程已结束' } });
    }
  },

  onAuthorTap(e) {
    const { openid, nickName, avatarUrl } = e.currentTarget.dataset;
    cloud.navigateToUserProfile(openid, { nickName, avatarUrl });
  },

  onAddMoment() {
    if (this.data.trip && this.data.trip.status === 'archived') return;
    wx.navigateTo({ url: `/pages/add-moment/add-moment?tripId=${this.data.tripId}` });
  }
});
