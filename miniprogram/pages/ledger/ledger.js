const cloud = require('../../utils/cloud');
const chart = require('../../utils/chart');
const exportUtil = require('../../utils/export');
const theme = require('../../utils/theme');

Page({
  data: {
    themeStyle: '',
    themeClass: 'theme-blue',
    trips: [],
    selectedTripId: '',
    selectedTrip: null,
    expenses: [],
    filteredExpenses: [],
    filterType: 'all',
    filterCategory: 'all',
    summary: { total: 0, shared: 0, private: 0 },
    budgetAlerts: [],
    categoryBreakdown: [],
    dailyTrend: [],
    refreshing: false,
    suggestedBudget: 0,
    categories: [
      { key: 'all', icon: '/images/icons/trip-ledger.png', label: '全部' },
      { key: 'transport', icon: '/images/icons/category-transport.png', label: '交通' },
      { key: 'hotel', icon: '/images/icons/category-hotel.png', label: '住宿' },
      { key: 'food', icon: '/images/icons/category-food.png', label: '餐饮' },
      { key: 'tickets', icon: '/images/icons/category-tickets.png', label: '门票' },
      { key: 'shopping', icon: '/images/icons/category-shopping.png', label: '购物' },
      { key: 'other', icon: '/images/icons/category-other.png', label: '其他' }
    ]
  },

  onLoad(options = {}) {
    if (options.tripId) this.setData({ selectedTripId: options.tripId });
  },

  onShow() {
    theme.applyToPage(this);
    this.loadTrips();
  },

  async loadTrips() {
    try {
      const { memberships, trips, currentTripId } = await cloud.getMyTrips();

      if (!memberships.length) {
        this.setData({
          trips: [],
          selectedTripId: '',
          selectedTrip: null,
          expenses: [],
          filteredExpenses: [],
          summary: { total: 0, shared: 0, private: 0 },
          budgetAlerts: [],
          categoryBreakdown: [],
          dailyTrend: []
        });
        return;
      }
      const activeTrips = trips.filter(t => t.status === 'active');
      const defaultTrip = activeTrips.find(t => t._id === currentTripId) || activeTrips[0];

      this.setData({ trips: activeTrips });

      if (activeTrips.length && !this.data.selectedTripId) {
        this.selectTrip(defaultTrip._id);
      } else if (activeTrips.length && !activeTrips.some(t => t._id === this.data.selectedTripId)) {
        this.selectTrip(defaultTrip._id);
      } else if (activeTrips.length) {
        const selectedTrip = activeTrips.find(t => t._id === this.data.selectedTripId) || defaultTrip;
        this.setData({ selectedTripId: selectedTrip._id, selectedTrip });
        this.loadExpenses(this.data.selectedTripId);
      } else {
        this.setData({
          selectedTripId: '',
          selectedTrip: null,
          expenses: [],
          filteredExpenses: [],
          summary: { total: 0, shared: 0, private: 0 },
          budgetAlerts: [],
          categoryBreakdown: [],
          dailyTrend: []
        });
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
    try {
      const { expenses } = await cloud.getTripSnapshot(tripId, ['expenses']);

      let total = 0, shared = 0, pri = 0;
      const catMap = {};
      const dayMap = {};

      expenses.forEach(e => {
        e.icon = cloud.categoryIcon(e.category);
        const amount = Number(e.amount) || 0;
        const refunded = Number(e.refunded) || 0;
        e.netAmount = Math.max(0, Math.round((amount - refunded) * 100) / 100);
        e.refundText = refunded > 0 ? `已抵扣 ¥${refunded.toFixed(2)} · 净额 ¥${e.netAmount.toFixed(2)}` : '';
        const splitCount = Array.isArray(e.splitAmong) ? e.splitAmong.length : 0;
        e.splitCount = splitCount;
        e.perPersonAmount = e.type === 'shared' && splitCount > 0
          ? (Math.round(e.netAmount / splitCount * 100) / 100).toFixed(2)
          : '';
        e.splitText = e.type === 'shared'
          ? (splitCount ? `${splitCount} 人分摊 · 人均 ¥${e.perPersonAmount}` : '未设置分摊人')
          : '不参与公共分摊';
        total += e.netAmount;
        if (e.type === 'shared') shared += e.netAmount;
        else pri += e.netAmount;

        const cat = e.category || 'other';
        if (!catMap[cat]) catMap[cat] = 0;
        catMap[cat] += e.netAmount;

        // 按日期聚合
        if (e.createdAt) {
          const dateKey = e.createdAt.slice(0, 10); // YYYY-MM-DD
          if (!dayMap[dateKey]) dayMap[dateKey] = 0;
          dayMap[dateKey] += e.netAmount;
        }
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

      // 每日趋势（按日期排序，格式化为 M/D）
      const dailyTrend = Object.entries(dayMap)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, amount]) => {
          const parts = date.split('-');
          return { date: (parts[1] || '').replace(/^0/, '') + '/' + (parts[2] || '').replace(/^0/, ''), amount: Math.round(amount * 100) / 100 };
        });

      // 预算建议
      let suggestedBudget = 0;
      const trip = this.data.selectedTrip;
      if (trip && !trip.totalBudget && total > 0) {
        const days = dailyTrend.length || 1;
        const avgPerDay = total / days;
        const remainingEst = Math.max(0, ((trip.totalDays || days) - days));
        suggestedBudget = Math.round(total + avgPerDay * remainingEst);
      }
      const budgetAlerts = this.buildBudgetAlerts(trip, total, shared, pri, breakdown, dailyTrend, suggestedBudget);

      this.setData({
        expenses,
        summary: { total, shared, private: pri },
        categoryBreakdown: breakdown,
        dailyTrend,
        suggestedBudget,
        budgetAlerts
      });
      this.applyFilters();

      // 渲染图表（等 DOM 就绪）
      if (breakdown.length > 0) {
        setTimeout(() => {
          chart.drawPieChart('pieChart', breakdown, total).catch(() => {});
        }, 300);
      }
      if (dailyTrend.length > 0) {
        setTimeout(() => {
          chart.drawBarChart('barChart', dailyTrend).catch(() => {});
        }, 400);
      }
    } catch (e) {
      console.error('加载消费失败:', e);
    }
  },

  buildBudgetAlerts(trip, total, shared, privateTotal, breakdown, dailyTrend, suggestedBudget) {
    const alerts = [];
    const budget = Number(trip && trip.totalBudget) || 0;
    const spent = Math.round((Number(total) || 0) * 100) / 100;
    const usedDays = Math.max(1, (dailyTrend || []).length);
    const totalDays = Math.max(usedDays, Number(trip && trip.totalDays) || usedDays);
    const remainingDays = Math.max(1, totalDays - usedDays + 1);

    if (budget > 0 && spent > 0) {
      const percent = Math.round((spent / budget) * 100);
      if (spent > budget) {
        alerts.push({
          level: 'danger',
          title: '预算已超支',
          text: `已用 ${percent}% · 超出 ¥${(spent - budget).toFixed(2)}，建议先结算高额公共支出。`
        });
      } else if (percent >= 80) {
        alerts.push({
          level: 'warn',
          title: '预算快用完了',
          text: `已用 ${percent}% · 剩余 ¥${(budget - spent).toFixed(2)}，后面每天约可花 ¥${Math.floor((budget - spent) / remainingDays)}。`
        });
      } else {
        alerts.push({
          level: 'good',
          title: '预算状态正常',
          text: `已用 ${percent}% · 还剩 ¥${(budget - spent).toFixed(2)}，节奏还挺舒服。`
        });
      }
    } else if (!budget && spent > 0 && suggestedBudget) {
      alerts.push({
        level: 'info',
        title: '可以设置旅行预算',
        text: `按当前节奏，建议预算约 ¥${suggestedBudget}，后面账本会自动提示超支。`
      });
    }

    const top = breakdown && breakdown[0];
    if (top && spent > 0 && Number(top.percent) >= 45) {
      alerts.push({
        level: 'info',
        title: `${top.label}占比偏高`,
        text: `${top.label}占了 ${top.percent}% · 已花 ¥${Number(top.amount).toFixed(2)}，可以留意是否有重复支出。`
      });
    }
    if (shared > privateTotal * 1.5 && shared > 0) {
      alerts.push({
        level: 'info',
        title: '公共支出较多',
        text: `公共账 ¥${shared.toFixed(2)}，建议旅行中途结算一次，别最后算到头大。`
      });
    }
    return alerts.slice(0, 3);
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
    const { members } = await cloud.getTripSnapshot(tripId, ['members']);
    wx.navigateTo({ url: `/pages/add-expense/add-expense?tripId=${tripId}&members=${encodeURIComponent(JSON.stringify(members))}` });
  },

  onExpenseTap(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || !this.data.selectedTripId) return;
    wx.navigateTo({ url: `/pages/expense-detail/expense-detail?tripId=${this.data.selectedTripId}&expenseId=${id}` });
  },

  onPreviewReceipt(e) {
    const fileId = e.currentTarget.dataset.fileId;
    if (!fileId) return;
    wx.showLoading({ title: '打开凭证...' });
    cloud.getTempFileUrl(fileId).then(url => {
      wx.hideLoading();
      wx.previewImage({ urls: [url || fileId], current: url || fileId });
    }).catch(() => {
      wx.hideLoading();
      wx.showToast({ title: '凭证已过期', icon: 'none' });
    });
  },

  onSetBudget() {
    wx.showToast({ title: '请在行程详情中设置预算', icon: 'none' });
  },

  onGoSettlement() {
    if (!this.data.selectedTripId) return;
    wx.navigateTo({ url: `/pages/settlement/settlement?tripId=${this.data.selectedTripId}` });
  },

  async onExportBill() {
    const { selectedTrip, expenses, summary, categoryBreakdown } = this.data;
    if (!selectedTrip || !expenses.length) return;

    wx.showLoading({ title: '生成账单图片...' });
    try {
      const tempPath = await exportUtil.drawBillSummary(
        'exportCanvas', selectedTrip, expenses, summary, categoryBreakdown
      );
      wx.hideLoading();
      if (!tempPath) {
        wx.showToast({ title: '生成失败', icon: 'none' });
        return;
      }
      wx.showShareImageMenu({
        path: tempPath,
        success: () => wx.showToast({ title: '已分享', icon: 'success' }),
        fail: () => {
          // 降级：保存到相册
          wx.saveImageToPhotosAlbum({
            filePath: tempPath,
            success: () => wx.showToast({ title: '已保存到相册', icon: 'success' }),
            fail: () => wx.showToast({ title: '保存失败', icon: 'none' })
          });
        }
      });
    } catch (e) {
      wx.hideLoading();
      console.error('导出失败:', e);
      wx.showToast({ title: '导出失败', icon: 'none' });
    }
  },

  onLongPressExpense(e) {
    const id = e.currentTarget.dataset.id;
    const item = e.currentTarget.dataset.json;
    if (!id) return;

    const items = ['编辑', '删除'];
    wx.showActionSheet({
      itemList: items,
      itemColor: '#ef4444',
      success: (res) => {
        if (res.tapIndex === 0) {
          this.onEditExpense(id, item);
        } else if (res.tapIndex === 1) {
          this.onDeleteExpense(id);
        }
      }
    });
  },

  async onEditExpense(id, item) {
    if (!id || !this.data.selectedTripId) return;
    wx.navigateTo({ url: `/pages/add-expense/add-expense?tripId=${this.data.selectedTripId}&expenseId=${id}` });
  },

  async onDeleteExpense(id) {
    const confirmed = await new Promise(resolve => {
      wx.showModal({
        title: '确认删除',
        content: '删除后无法恢复',
        confirmColor: '#ef4444',
        success: (r) => resolve(r.confirm)
      });
    });
    if (!confirmed) return;
    try {
      await cloud.deleteExpense(id);
      wx.showToast({ title: '已删除', icon: 'success' });
      this.loadExpenses(this.data.selectedTripId);
    } catch (err) {
      wx.showToast({ title: '删除失败', icon: 'none' });
    }
  }
});
