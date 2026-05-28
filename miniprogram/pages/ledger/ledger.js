const cloud = require('../../utils/cloud');

Page({
  data: {
    trips: [],
    selectedTripId: '',
    selectedTrip: null,
    expenses: [],
    filteredExpenses: [],
    filterType: 'all',
    filterCategory: 'all',
    summary: { total: 0, shared: 0, private: 0 },
    categoryBreakdown: [],
    refreshing: false,
    categories: [
      { key: 'all', icon: '📋', label: '全部' },
      { key: 'transport', icon: '🚄', label: '交通' },
      { key: 'hotel', icon: '🏨', label: '住宿' },
      { key: 'food', icon: '🍜', label: '餐饮' },
      { key: 'tickets', icon: '🎫', label: '门票' },
      { key: 'shopping', icon: '🛍', label: '购物' },
      { key: 'other', icon: '📦', label: '其他' }
    ]
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 });
    }
    this.loadTrips();
  },

  async loadTrips() {
    try {
      const openid = await cloud.getOpenid();
      const db = cloud.db;

      const { data: memberships } = await db.collection('trip_members')
        .where({ openid })
        .get();

      if (!memberships.length) {
        this.setData({ trips: [] });
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
      }
    } catch (e) {
      console.error('加载行程失败:', e);
    }
  },

  onTripSelect(e) {
    const { id } = e.currentTarget.dataset;
    this.selectTrip(id);
  },

  selectTrip(tripId) {
    const trip = this.data.trips.find(t => t._id === tripId);
    this.setData({ selectedTripId: tripId, selectedTrip: trip, filterType: 'all', filterCategory: 'all' });
    this.loadExpenses(tripId);
  },

  async loadExpenses(tripId) {
    const { data: expenses } = await cloud.collection('expenses')
      .where({ tripId })
      .orderBy('createdAt', 'desc')
      .get();

    let total = 0, shared = 0, pri = 0;
    const catMap = {};

    expenses.forEach(e => {
      e.icon = cloud.categoryIcon(e.category);
      total += e.amount || 0;
      if (e.type === 'shared') shared += e.amount || 0;
      else pri += e.amount || 0;

      const cat = e.category || 'other';
      if (!catMap[cat]) catMap[cat] = 0;
      catMap[cat] += e.amount || 0;
    });

    // 分类占比
    const labels = {
      transport: '交通', hotel: '住宿', food: '餐饮',
      tickets: '门票', shopping: '购物', other: '其他'
    };
    const breakdown = Object.entries(catMap)
      .map(([key, amount]) => ({
        key,
        label: labels[key] || key,
        amount,
        percent: total > 0 ? Math.round(amount / total * 100) : 0
      }))
      .sort((a, b) => b.amount - a.amount);

    this.setData({
      expenses,
      summary: { total, shared, private: pri },
      categoryBreakdown: breakdown
    });
    this.applyFilters();
  },

  onTypeFilter(e) {
    const { type } = e.currentTarget.dataset;
    this.setData({ filterType: type });
    this.applyFilters();
  },

  onCategoryFilter(e) {
    const { cat } = e.currentTarget.dataset;
    this.setData({ filterCategory: cat });
    this.applyFilters();
  },

  applyFilters() {
    let list = this.data.expenses;
    if (this.data.filterType !== 'all') {
      list = list.filter(e => e.type === this.data.filterType);
    }
    if (this.data.filterCategory !== 'all') {
      list = list.filter(e => e.category === this.data.filterCategory);
    }
    this.setData({ filteredExpenses: list });
  },

  onRefresh() {
    this.setData({ refreshing: true });
    if (this.data.selectedTripId) {
      this.loadExpenses(this.data.selectedTripId).then(() => this.setData({ refreshing: false }));
    } else {
      this.setData({ refreshing: false });
    }
  },

  async onAddExpense() {
    if (!this.data.selectedTripId) {
      return wx.showToast({ title: '请先选择行程', icon: 'none' });
    }
    const tripId = this.data.selectedTripId;
    const db = cloud.db;
    const { data: members } = await db.collection('trip_members').where({ tripId }).get();
    wx.navigateTo({ url: `/pages/add-expense/add-expense?tripId=${tripId}&members=${encodeURIComponent(JSON.stringify(members))}` });
  }
});
