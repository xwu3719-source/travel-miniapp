const cloud = require('../../utils/cloud');

Page({
  data: {
    activeTrips: [],
    historyTrips: [],
    currentTripId: '',
    currentTrip: null,
    dashboard: null,
    dashboardLoading: false,
    unreadSummary: { unreadMessages: 0, unreadGroupMessages: 0, pendingFriendRequests: 0, unreadNotifications: 0 },
    loading: true,
    showHistory: false,
    refreshing: false,
    batchMode: false,
    selectedIds: [],
    swipedId: '',
    showHeaderMenu: false,
    touchStartX: 0,
    touchStartY: 0
  },

  onShow() {
    // 兜底：如果 onLaunch 还没跑完或跳转未生效，再次检查
    const app = getApp();
    if (app.globalData.needsOnboarding) {
      wx.reLaunch({ url: '/pages/welcome/welcome' });
      return;
    }

    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      const tabBar = this.getTabBar();
      tabBar.setData({ selected: 0 });
      if (tabBar.refreshUnread) tabBar.refreshUnread();
    }
    this.loadTrips();
  },

  onRefresh() {
    this.setData({ refreshing: true });
    this.loadTrips().then(() => this.setData({ refreshing: false }));
  },

  async loadTrips() {
    if (!this.data.activeTrips.length && !this.data.historyTrips.length) {
      this.setData({ loading: true });
    }
    try {
      const { memberships, trips, currentTripId } = await cloud.getMyTrips();

      if (!memberships.length) {
        this.setData({ activeTrips: [], historyTrips: [], currentTripId: '', currentTrip: null, dashboard: null, loading: false });
        return;
      }

      // 附加成员角色到每个行程
      const roleByTripId = {};
      memberships.forEach(m => { roleByTripId[m.tripId] = m.role || 'member'; });

      // 分离活跃和归档
      const active = [];
      const history = [];
      trips.forEach(trip => {
        trip.myRole = roleByTripId[trip._id] || 'member';
        if (trip.status === 'archived') {
          history.push(trip);
        } else {
          active.push(trip);
        }
      });

      const currentTrip = active.find(trip => trip._id === currentTripId) || active[0] || null;
      this.setData({
        activeTrips: active,
        historyTrips: history,
        currentTripId: currentTrip ? currentTrip._id : '',
        currentTrip,
        loading: false
      });
      this.loadDashboard(currentTrip);
    } catch (e) {
      console.error('加载行程失败:', e);
      this.setData({ loading: false });
    }
  },

  async loadDashboard(trip) {
    if (!trip || !trip._id) {
      this.setData({ dashboard: null });
      return;
    }
    this.setData({ dashboardLoading: true });
    try {
      const [snapshot, unread, feed] = await Promise.all([
        cloud.getTripSnapshot(trip._id, ['plans', 'expenses']),
        cloud.getUnreadSummary().catch(() => ({})),
        cloud.getMomentFeed({ tripId: trip._id, limit: 3 }).catch(() => ({ moments: [] }))
      ]);
      const today = new Date().toISOString().slice(0, 10);
      const plans = snapshot.plans || [];
      const todayPlan = plans.find(day => day.date === today) || plans.find(day => (day.items || []).length);
      const todayItems = (todayPlan && todayPlan.items || []).slice(0, 3).map((item, index) => ({
        ...item,
        dashboardKey: item.sortId || `${todayPlan.dayIndex || 'day'}_${index}_${item.title || ''}`
      }));
      const expenses = snapshot.expenses || [];
      const total = expenses.reduce((sum, item) => {
        const amount = Number(item.amount) || 0;
        const refunded = Number(item.refunded) || 0;
        return sum + Math.max(0, amount - refunded);
      }, 0);
      const budget = Number(trip.totalBudget) || 0;
      const budgetPercent = budget ? Math.min(100, Math.round(total / budget * 100)) : 0;
      const budgetRemain = budget ? Math.round((budget - total) * 100) / 100 : 0;
      const unreadSummary = {
        unreadMessages: Number(unread.unreadMessages) || 0,
        unreadGroupMessages: Number(unread.unreadGroupMessages) || 0,
        pendingFriendRequests: Number(unread.pendingFriendRequests) || 0,
        unreadNotifications: Number(unread.unreadNotifications) || 0
      };
      const unreadTotal = unreadSummary.unreadMessages + unreadSummary.unreadGroupMessages + unreadSummary.pendingFriendRequests + unreadSummary.unreadNotifications;
      const moments = feed.moments || [];
      const reminders = this.buildDashboardReminders(trip, { todayItems, total, budget, budgetPercent, unreadTotal });
      this.setData({
        unreadSummary,
        dashboard: {
          trip,
          todayLabel: todayPlan ? (todayPlan.date === today ? '今日安排' : `Day ${todayPlan.dayIndex}`) : '今日安排',
          todayItems,
          total: total.toFixed(2),
          budget,
          budgetPercent,
          budgetRemain,
          budgetRemainText: Math.abs(budgetRemain).toFixed(2),
          unreadTotal,
          moments: moments.slice(0, 3).map(item => ({
            id: item._id,
            text: item.text || '新动态',
            image: (item.imageThumbs && item.imageThumbs[0]) || (item.images && item.images[0]) || ''
          })),
          reminders
        },
        dashboardLoading: false
      });
    } catch (error) {
      console.warn('首页仪表盘加载失败:', error);
      this.setData({ dashboardLoading: false });
    }
  },

  buildDashboardReminders(trip, state) {
    const reminders = [];
    if (!state.todayItems.length) {
      reminders.push({ type: 'plan', text: '今天还没有明确安排，可以先加一个集合点。' });
    }
    if (state.budget && state.budgetPercent >= 100) {
      reminders.push({ type: 'budget', text: `预算已超支，当前已花 ¥${state.total.toFixed ? state.total.toFixed(2) : state.total}` });
    } else if (state.budget && state.budgetPercent >= 80) {
      reminders.push({ type: 'budget', text: `预算已用 ${state.budgetPercent}%，建议看下账本。` });
    } else if (!state.budget) {
      reminders.push({ type: 'budget', text: '还没设置预算，设置后账本会自动预警。' });
    }
    if (state.unreadTotal > 0) {
      reminders.push({ type: 'message', text: `有 ${state.unreadTotal} 条消息/通知待处理。` });
    }
    if (trip.endDate && new Date().toISOString().slice(0, 10) > trip.endDate) {
      reminders.push({ type: 'archive', text: '行程已结束，可以生成旅行总结并归档。' });
    }
    return reminders.slice(0, 3);
  },

  onTripTap(e) {
    const { id } = e.currentTarget.dataset;
    if (this.data.swipedId === id) {
      return this.setData({ swipedId: '' });
    }
    wx.navigateTo({ url: `/pages/trip-detail/trip-detail?tripId=${id}` });
  },

  onCopyHistoryTrip(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    wx.navigateTo({ url: `/pages/trip-create/trip-create?copyFromTripId=${id}` });
  },

  onSaveHistoryTemplate(e) {
    const { id } = e.currentTarget.dataset;
    const trip = this.data.historyTrips.find(item => item._id === id);
    if (!trip) return;
    wx.showModal({
      title: '保存为模板',
      content: '',
      editable: true,
      placeholderText: `${trip.name}模板`,
      confirmText: '保存',
      confirmColor: '#5b9ff5',
      success: async res => {
        if (!res.confirm) return;
        const name = String(res.content || `${trip.name}模板`).trim();
        try {
          await cloud.saveTripTemplate(id, name);
          wx.showToast({ title: '模板已保存', icon: 'none' });
        } catch (error) {
          wx.showToast({ title: error.message || '保存模板失败', icon: 'none' });
        }
      }
    });
  },

  async onSetCurrentTrip(e) {
    const { id } = e.currentTarget.dataset;
    if (!id || id === this.data.currentTripId) return;
    try {
      await cloud.setCurrentTrip(id);
      const activeTrips = this.data.activeTrips.map(trip => ({ ...trip, isCurrent: trip._id === id }));
      const currentTrip = activeTrips.find(trip => trip._id === id) || null;
      this.setData({ currentTripId: id, currentTrip, activeTrips });
      this.loadDashboard(currentTrip);
      wx.showToast({ title: '已设为当前行程', icon: 'none' });
    } catch (error) {
      wx.showToast({ title: error.message || '设置失败', icon: 'none' });
    }
  },

  onTouchStart(e) {
    this.setData({
      touchStartX: e.touches[0].clientX,
      touchStartY: e.touches[0].clientY
    });
  },

  onTouchMove(e) {
    const deltaX = e.touches[0].clientX - this.data.touchStartX;
    const deltaY = e.touches[0].clientY - this.data.touchStartY;
    const id = e.currentTarget.dataset.id;

    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 10) {
      if (deltaX < -40) {
        this.setData({ swipedId: id });
      } else if (deltaX > 40) {
        this.setData({ swipedId: '' });
      }
    }
  },

  async onDeleteTrip(e) {
    const { id } = e.currentTarget.dataset;
    const trip = this.data.activeTrips.find(t => t._id === id);
    wx.showModal({
      title: '删除行程',
      content: `确定删除「${trip ? trip.name : ''}」吗？行程和所有关联数据将永久删除，不可恢复。`,
      confirmColor: '#ef4444',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await cloud.deleteTrip(id);
          this.setData({ swipedId: '' });
          this.loadTrips();
          wx.showToast({ title: '已删除', icon: 'success' });
        } catch (e) {
          wx.showToast({ title: e.message || '删除失败', icon: 'none' });
        }
      }
    });
  },

  async onLeaveTrip(e) {
    const { id } = e.currentTarget.dataset;
    const trip = this.data.activeTrips.find(t => t._id === id);
    wx.showModal({
      title: '退出行程',
      content: `确定退出「${trip ? trip.name : ''}」吗？退出后不再看到行程动态和数据。`,
      confirmColor: '#64748b',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await cloud.leaveTrip(id);
          this.setData({ swipedId: '' });
          this.loadTrips();
          wx.showToast({ title: '已退出', icon: 'success' });
        } catch (e) {
          wx.showToast({ title: e.message || '退出失败', icon: 'none' });
        }
      }
    });
  },

  onCreateTap() {
    wx.navigateTo({ url: '/pages/trip-create/trip-create' });
  },

  onJoinTap() {
    wx.navigateTo({ url: '/pages/join/join' });
  },

  onDashboardTripTap() {
    if (this.data.currentTripId) wx.navigateTo({ url: `/pages/trip-detail/trip-detail?tripId=${this.data.currentTripId}` });
  },

  onDashboardAction(e) {
    const action = e.currentTarget.dataset.action;
    const tripId = this.data.currentTripId;
    if (action === 'ai') wx.navigateTo({ url: '/pages/ai-assistant/ai-assistant' });
    if (action === 'messages') wx.switchTab({ url: '/pages/messages/messages' });
    if (!tripId) return;
    if (action === 'plan') wx.navigateTo({ url: `/pages/trip-detail/trip-detail?tripId=${tripId}` });
    if (action === 'ledger') wx.navigateTo({ url: `/pages/ledger/ledger?tripId=${tripId}` });
    if (action === 'summary') wx.navigateTo({ url: `/pages/trip-summary/trip-summary?tripId=${tripId}` });
  },

  onMomentPreviewTap(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: `/pages/moment-detail/moment-detail?momentId=${id}` });
  },

  onToggleHeaderMenu() {
    this.setData({ showHeaderMenu: !this.data.showHeaderMenu });
  },

  onCloseHeaderMenu() {
    this.setData({ showHeaderMenu: false });
  },

  onCreateFromMenu() {
    this.setData({ showHeaderMenu: false });
    this.onCreateTap();
  },

  onJoinFromMenu() {
    this.setData({ showHeaderMenu: false });
    this.onJoinTap();
  },

  onBatchFromMenu() {
    this.setData({ showHeaderMenu: false });
    this.onToggleBatchMode();
  },

  preventBubble() {},

  onToggleBatchMode() {
    const entering = !this.data.batchMode;
    if (entering) {
      const activeTrips = this.data.activeTrips.map(t => ({ ...t, selected: false }));
      this.setData({ batchMode: true, activeTrips, selectedIds: [], swipedId: '', showHeaderMenu: false });
    } else {
      const activeTrips = this.data.activeTrips.map(t => {
        delete t.selected;
        return t;
      });
      this.setData({ batchMode: false, activeTrips, selectedIds: [] });
    }
  },

  onToggleSelect(e) {
    const { id } = e.currentTarget.dataset;
    const index = this.data.activeTrips.findIndex(t => t._id === id);
    if (index === -1) return;
    const selected = !this.data.activeTrips[index].selected;
    const selectedIds = selected
      ? [...this.data.selectedIds, id]
      : this.data.selectedIds.filter(i => i !== id);
    this.setData({
      [`activeTrips[${index}].selected`]: selected,
      selectedIds
    });
  },

  async onBatchDelete() {
    if (!this.data.selectedIds.length) return;
    wx.showModal({
      title: '批量删除',
      content: `确定删除选中的 ${this.data.selectedIds.length} 个行程吗？所有关联数据将永久删除。`,
      confirmColor: '#ef4444',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          const tripIds = this.data.selectedIds;
          await cloud.deleteTrips(tripIds);
          this.setData({ batchMode: false, selectedIds: [] });
          this.loadTrips();
          wx.showToast({ title: '已删除', icon: 'success' });
        } catch (e) {
          wx.showToast({ title: e.message || '删除失败', icon: 'none' });
        }
      }
    });
  },

  async onBatchLeave() {
    if (!this.data.selectedIds.length) return;
    wx.showModal({
      title: '退出行程',
      content: `确定退出选中的 ${this.data.selectedIds.length} 个行程吗？退出后不再看到行程动态和数据。`,
      confirmColor: '#64748b',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          let done = 0;
          for (const tripId of this.data.selectedIds) {
            try {
              await cloud.leaveTrip(tripId);
              done++;
            } catch (e) {
              // 跳过创建者不能退出的行程
            }
          }
          this.setData({ batchMode: false, selectedIds: [] });
          this.loadTrips();
          wx.showToast({ title: done > 0 ? `已退出 ${done} 个行程` : '无需退出', icon: 'success' });
        } catch (e) {
          wx.showToast({ title: e.message || '退出失败', icon: 'none' });
        }
      }
    });
  },

  onToggleHistory() {
    this.setData({ showHistory: !this.data.showHistory });
  },

  getDayLabel(trip) {
    if (!trip.startDate || !trip.endDate) return '';
    const start = trip.startDate.slice(5);
    const end = trip.endDate.slice(5);
    return `${start} — ${end}  ·  ${trip.totalDays || '?'}天`;
  }
});
