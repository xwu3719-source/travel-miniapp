const cloud = require('../../utils/cloud');

Page({
  data: {
    activeTrips: [],
    historyTrips: [],
    loading: true,
    showHistory: false,
    refreshing: false,
    batchMode: false,
    selectedIds: [],
    swipedId: '',
    touchStartX: 0,
    touchStartY: 0
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 });
    }
    this.loadTrips();
  },

  onRefresh() {
    this.setData({ refreshing: true });
    this.loadTrips().then(() => this.setData({ refreshing: false }));
  },

  async loadTrips() {
    this.setData({ loading: true });
    try {
      const openid = await cloud.getOpenid();
      const db = cloud.db;

      // 查用户的所有成员关系
      const { data: memberships } = await db.collection('trip_members')
        .where({ openid })
        .get();

      if (!memberships.length) {
        this.setData({ activeTrips: [], historyTrips: [], loading: false });
        return;
      }

      const tripIds = memberships.map(m => m.tripId);

      // 获取行程详情
      const { data: trips } = await db.collection('trips')
        .where({ _id: db.command.in(tripIds) })
        .orderBy('createdAt', 'desc')
        .get();

      // 分离活跃和归档
      const active = [];
      const history = [];
      trips.forEach(trip => {
        if (trip.status === 'archived') {
          history.push(trip);
        } else {
          active.push(trip);
        }
      });

      this.setData({ activeTrips: active, historyTrips: history, loading: false });
    } catch (e) {
      console.error('加载行程失败:', e);
      this.setData({ loading: false });
    }
  },

  onTripTap(e) {
    const { id } = e.currentTarget.dataset;
    if (this.data.swipedId === id) {
      return this.setData({ swipedId: '' });
    }
    wx.navigateTo({ url: `/pages/trip-detail/trip-detail?tripId=${id}` });
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
          const db = cloud.db;
          const delRelated = async (coll) => {
            const { data } = await db.collection(coll).where({ tripId: id }).get();
            for (const doc of data) {
              await db.collection(coll).doc(doc._id).remove();
            }
          };
          await delRelated('trip_members');
          await delRelated('day_plans');
          await delRelated('expenses');
          await delRelated('moments');
          await db.collection('trips').doc(id).remove();
          this.setData({ swipedId: '' });
          this.loadTrips();
          wx.showToast({ title: '已删除', icon: 'success' });
        } catch (e) {
          console.error('删除失败:', e);
          wx.showToast({ title: '删除失败', icon: 'none' });
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

  onToggleBatchMode() {
    const entering = !this.data.batchMode;
    if (entering) {
      const activeTrips = this.data.activeTrips.map(t => ({ ...t, selected: false }));
      this.setData({ batchMode: true, activeTrips, selectedIds: [], swipedId: '' });
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
          const db = cloud.db;
          const _ = db.command;
          const tripIds = this.data.selectedIds;
          const delRelated = async (coll, field = 'tripId') => {
            const { data } = await db.collection(coll).where({ [field]: _.in(tripIds) }).get();
            for (const doc of data) {
              await db.collection(coll).doc(doc._id).remove();
            }
          };
          await delRelated('trip_members');
          await delRelated('day_plans');
          await delRelated('expenses');
          await delRelated('moments');
          await db.collection('trips').where({ _id: _.in(tripIds) }).remove();
          this.setData({ batchMode: false, selectedIds: [] });
          this.loadTrips();
          wx.showToast({ title: '已删除', icon: 'success' });
        } catch (e) {
          console.error('批量删除失败:', e);
          wx.showToast({ title: '删除失败', icon: 'none' });
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
