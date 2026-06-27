const cloud = require('../../utils/cloud');

Page({
  data: {
    tripId: '',
    trip: null,
    members: [],
    expenses: [],
    settlements: [],
    transfers: [],
    settlementHistory: [],
    settlementSelections: {},
    selectedSettlementSummary: { count: 0, total: '0.00' },
    lastSettlementVoucher: null,
    showHistory: false,
    loading: true,
    refreshing: false
  },

  onLoad(options) {
    this.setData({ tripId: options.tripId });
  },

  onShow() {
    this.calculate();
  },

  onRefresh() {
    this.setData({ refreshing: true });
    this.calculate().then(() => this.setData({ refreshing: false }));
  },

  async calculate() {
    this.setData({ loading: true });
    try {
      const tripId = this.data.tripId;
      const snapshot = await cloud.getTripSnapshot(tripId, ['trip', 'members', 'expenses']);
      const trip = snapshot.trip;
      const members = snapshot.members || [];
      const memberOpenids = members.map(m => m.openid).filter(Boolean);
      if (memberOpenids.length > 0) {
        try {
          const userMap = await cloud.batchGetUsers(memberOpenids);
          members.forEach(m => {
            const u = userMap[m.openid];
            if (u) {
              if (u.avatarUrl) m.avatarUrl = u.avatarUrl;
              if (u.nickName) m.nickName = u.nickName;
            }
          });
        } catch (e) { /* 非关键 */ }
      }
      await cloud.resolveUserAvatars(members);

      const allExpenses = snapshot.expenses || [];
      allExpenses.forEach(e => {
        e.icon = cloud.categoryIcon(e.category);
        const amount = Number(e.amount) || 0;
        const refunded = Number(e.refunded) || 0;
        e.netAmount = Math.max(0, Math.round((amount - refunded) * 100) / 100);
        e.refundText = refunded > 0 ? `已抵扣 ¥${refunded.toFixed(2)}` : '';
      });

      // 分离已结算和未结算
      const unsettledExpenses = allExpenses.filter(e => !e.settled);
      const settledExpenses = allExpenses.filter(e => e.settled);

      // 只基于未结算的公共消费计算分摊
      const sharedUnsettled = unsettledExpenses.filter(e => e.type === 'shared');

      const settlements = members.map(m => {
        const privateExpenses = unsettledExpenses.filter(e => e.type === 'private' && e.paidBy === m.openid);
        const privateTotal = privateExpenses.reduce((sum, e) => sum + e.netAmount, 0);

        const paidForShared = sharedUnsettled
          .filter(e => e.paidBy === m.openid)
          .reduce((sum, e) => sum + e.netAmount, 0);

        let sharedDue = 0;
        sharedUnsettled.forEach(e => {
          const splitters = (e.splitAmong && e.splitAmong.length > 0)
            ? e.splitAmong
            : members.map(member => member.openid).filter(Boolean);
          if (splitters.includes(m.openid)) {
            sharedDue += e.netAmount / splitters.length;
          }
        });

        const sharedBalance = paidForShared - sharedDue;
        const totalPaid = privateTotal + paidForShared;
        const totalDue = privateTotal + sharedDue;

        return {
          openid: m.openid,
          nickName: m.nickName,
          avatarUrl: m.avatarUrl,
          privateTotal,
          paidForShared: Math.round(paidForShared * 100) / 100,
          sharedDue: Math.round(sharedDue * 100) / 100,
          sharedBalance: Math.round(sharedBalance * 100) / 100,
          totalPaid: Math.round(totalPaid * 100) / 100,
          totalDue: Math.round(totalDue * 100) / 100
        };
      });

      const transfers = this.computeTransfers(settlements);

      // 初始化全选
      const allSharedIds = sharedUnsettled.map(e => e._id);
      const selections = {};
      allSharedIds.forEach(id => { selections[id] = true; });

      this.setData({
        trip, members,
        expenses: allExpenses,
        unsettledShared: sharedUnsettled,
        settledExpenses,
        settlements, transfers,
        settlementSelections: selections,
        selectedSettlementSummary: this.getSelectedSettlementSummary(sharedUnsettled, selections),
        loading: false
      });

      // 加载结算历史
      this.loadSettlementHistory();
    } catch (e) {
      console.error('结算失败:', e);
      this.setData({ loading: false });
    }
  },

  async loadSettlementHistory() {
    try {
      const res = await cloud.getSettlementHistory(this.data.tripId);
      const history = (res && res.records) || [];
      // 格式化时间
      history.forEach(h => {
        if (h.createdAt) {
          const d = new Date(h.createdAt);
          h.formattedTime = (d.getMonth() + 1) + '月' + d.getDate() + '日 ' +
            String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
        }
      });
      this.setData({ settlementHistory: history });
    } catch (e) {
      console.warn('加载结算历史失败:', e);
    }
  },

  // 最小化转账笔数：贪心匹配
  computeTransfers(settlements) {
    const creditors = [];
    const debtors = [];

    settlements.forEach(s => {
      if (s.sharedBalance > 0.01) {
        creditors.push({ openid: s.openid, nickName: s.nickName, avatarUrl: s.avatarUrl, amount: s.sharedBalance });
      } else if (s.sharedBalance < -0.01) {
        debtors.push({ openid: s.openid, nickName: s.nickName, avatarUrl: s.avatarUrl, amount: -s.sharedBalance });
      }
    });

    creditors.sort((a, b) => b.amount - a.amount);
    debtors.sort((a, b) => b.amount - a.amount);

    const transfers = [];
    let ci = 0, di = 0;

    while (ci < creditors.length && di < debtors.length) {
      const amount = Math.min(creditors[ci].amount, debtors[di].amount);
      if (amount < 0.01) break;

      transfers.push({
        from: debtors[di].nickName,
        fromOpenid: debtors[di].openid,
        fromAvatar: debtors[di].avatarUrl,
        to: creditors[ci].nickName,
        toOpenid: creditors[ci].openid,
        toAvatar: creditors[ci].avatarUrl,
        amount: Math.round(amount * 100) / 100
      });

      creditors[ci].amount -= amount;
      debtors[di].amount -= amount;

      if (creditors[ci].amount < 0.01) ci++;
      if (debtors[di].amount < 0.01) di++;
    }

    return transfers;
  },

  onToggleSettleItem(e) {
    const id = e.currentTarget.dataset.id;
    const selections = { ...this.data.settlementSelections };
    selections[id] = !selections[id];
    this.setData({
      settlementSelections: selections,
      selectedSettlementSummary: this.getSelectedSettlementSummary(this.data.unsettledShared || [], selections)
    });
  },

  getSelectedSettlementSummary(expenses, selections) {
    const selected = (expenses || []).filter(item => selections && selections[item._id]);
    const total = selected.reduce((sum, item) => sum + (Number(item.netAmount) || Number(item.amount) || 0), 0);
    return { count: selected.length, total: total.toFixed(2) };
  },

  onSelectAllSettlement() {
    const selections = {};
    (this.data.unsettledShared || []).forEach(item => { selections[item._id] = true; });
    this.setData({
      settlementSelections: selections,
      selectedSettlementSummary: this.getSelectedSettlementSummary(this.data.unsettledShared || [], selections)
    });
  },

  onClearSettlement() {
    const selections = {};
    (this.data.unsettledShared || []).forEach(item => { selections[item._id] = false; });
    this.setData({
      settlementSelections: selections,
      selectedSettlementSummary: this.getSelectedSettlementSummary(this.data.unsettledShared || [], selections)
    });
  },

  buildSelectedSettlementPlan() {
    const selectedIds = Object.entries(this.data.settlementSelections)
      .filter(([_, v]) => v)
      .map(([id]) => id);
    const filteredExpenses = this.data.unsettledShared.filter(e => selectedIds.includes(e._id));
    const members = this.data.members;
    const miniSettlements = members.map(m => {
      const paidForShared = filteredExpenses
        .filter(e => e.paidBy === m.openid)
        .reduce((sum, e) => sum + e.netAmount, 0);
      let sharedDue = 0;
      filteredExpenses.forEach(e => {
        const splitters = (e.splitAmong && e.splitAmong.length > 0)
          ? e.splitAmong
          : members.map(member => member.openid).filter(Boolean);
        if (splitters.includes(m.openid)) sharedDue += e.netAmount / splitters.length;
      });
      return {
        openid: m.openid,
        nickName: m.nickName,
        avatarUrl: m.avatarUrl,
        sharedBalance: Math.round((paidForShared - sharedDue) * 100) / 100
      };
    });
    return {
      selectedIds,
      filteredExpenses,
      transfers: this.computeTransfers(miniSettlements)
    };
  },

  async onRecordSettlement() {
    const { selectedIds, filteredExpenses, transfers: miniTransfers } = this.buildSelectedSettlementPlan();

    if (selectedIds.length === 0) {
      return wx.showToast({ title: '请选择要结算的消费', icon: 'none' });
    }

    const confirmed = await new Promise(resolve => {
      wx.showModal({
        title: '确认结算',
        content: `将结算 ${selectedIds.length} 笔公共消费\n涉及 ${miniTransfers.length} 笔转账\n总金额 ¥${miniTransfers.reduce((s, t) => s + t.amount, 0).toFixed(2)}\n结算后不可撤销`,
        confirmText: '确认结算',
        cancelText: '取消',
        success: (r) => resolve(r.confirm)
      });
    });
    if (!confirmed) return;

    try {
      wx.showLoading({ title: '结算中...' });
      await cloud.recordSettlement(this.data.tripId, selectedIds, miniTransfers);
      wx.hideLoading();
      wx.showToast({ title: '结算完成', icon: 'success' });
      this.setData({
        lastSettlementVoucher: this.buildSettlementVoucher(selectedIds, miniTransfers, filteredExpenses)
      });
      setTimeout(() => this.calculate(), 800);
    } catch (e) {
      wx.hideLoading();
      console.error('结算失败:', e);
      wx.showToast({ title: '结算失败', icon: 'none' });
    }
  },

  onToggleHistory() {
    this.setData({ showHistory: !this.data.showHistory });
  },

  buildSettlementVoucher(expenseIds, transfers, expenses) {
    const totalTransfer = (transfers || []).reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const totalExpense = (expenses || []).reduce((sum, item) => sum + Number(item.netAmount || item.amount || 0), 0);
    return {
      tripName: this.data.trip && this.data.trip.name || '本次行程',
      count: expenseIds.length,
      totalExpense: totalExpense.toFixed(2),
      totalTransfer: totalTransfer.toFixed(2),
      transfers: transfers || [],
      createdAt: new Date().toISOString()
    };
  },

  formatVoucher(voucher) {
    if (!voucher) return '';
    const lines = [
      `「${voucher.tripName}」结算凭证`,
      `结算账单：${voucher.count || 0} 笔 · 公共消费 ¥${voucher.totalExpense || '0.00'}`,
      `转账合计：¥${voucher.totalTransfer || '0.00'}`,
      '',
      ...(voucher.transfers && voucher.transfers.length
        ? voucher.transfers.map(item => `${item.from} → ${item.to}：¥${Number(item.amount || 0).toFixed(2)}`)
        : ['无需转账']),
      '',
      '由 拾途 ST 生成'
    ];
    return lines.join('\n');
  },

  onCopyTransferList() {
    const { selectedIds, filteredExpenses, transfers } = this.buildSelectedSettlementPlan();
    if (!selectedIds.length) return wx.showToast({ title: '请选择账单', icon: 'none' });
    const voucher = this.buildSettlementVoucher(selectedIds, transfers, filteredExpenses);
    wx.setClipboardData({
      data: this.formatVoucher(voucher),
      success: () => wx.showToast({ title: '转账清单已复制', icon: 'success' })
    });
  },

  onCopyLastVoucher() {
    wx.setClipboardData({
      data: this.formatVoucher(this.data.lastSettlementVoucher),
      success: () => wx.showToast({ title: '凭证已复制', icon: 'success' })
    });
  },

  onCopyHistoryVoucher(e) {
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.settlementHistory[index];
    if (!item) return;
    const voucher = {
      tripName: this.data.trip && this.data.trip.name || '本次行程',
      count: (item.settledExpenseIds || []).length,
      totalExpense: Number(item.totalSettled || 0).toFixed(2),
      totalTransfer: (item.transfers || []).reduce((sum, t) => sum + Number(t.amount || 0), 0).toFixed(2),
      transfers: item.transfers || []
    };
    wx.setClipboardData({
      data: this.formatVoucher(voucher),
      success: () => wx.showToast({ title: '历史凭证已复制', icon: 'success' })
    });
  },

  onPreviewReceipt(e) {
    const fileId = e.currentTarget.dataset.fileId;
    if (fileId) wx.previewImage({ urls: [fileId], current: fileId });
  }
});
