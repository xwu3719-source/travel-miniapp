const cloud = require('../../utils/cloud');

Page({
  data: {
    tripId: '',
    trip: null,
    members: [],
    expenses: [],
    settlements: [],
    transfers: [],
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
      const db = cloud.db;
      const tripId = this.data.tripId;

      const trip = cloud.getDoc(await db.collection('trips').doc(tripId).get());

      const { data: members } = await db.collection('trip_members').where({ tripId }).get();
      const { data: expenses } = await db.collection('expenses').where({ tripId }).get();
      expenses.forEach(e => {
        e.icon = cloud.categoryIcon(e.category);
      });

      const settlements = members.map(m => {
        // 私人消费（自己付的）
        const privateExpenses = expenses.filter(e => e.type === 'private' && e.paidBy === m.openid);
        const privateTotal = privateExpenses.reduce((sum, e) => sum + e.amount, 0);

        // 公共：自己垫付了多少
        const paidForShared = expenses
          .filter(e => e.type === 'shared' && e.paidBy === m.openid)
          .reduce((sum, e) => sum + e.amount, 0);

        // 公共：自己应付多少（分摊到的份额）
        let sharedDue = 0;
        expenses.filter(e => e.type === 'shared').forEach(e => {
          const splitters = e.splitAmong || [];
          if (splitters.includes(m.openid)) {
            sharedDue += e.amount / splitters.length;
          }
        });

        // 公共：垫付 - 应付 = 净额
        // 正数 = 垫多了，别人欠他；负数 = 垫少了，他欠别人
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

      // 计算转账方案：匹配债权人和债务人
      const transfers = this.computeTransfers(settlements);

      this.setData({ trip, members, expenses, settlements, transfers, loading: false });
    } catch (e) {
      console.error('结算失败:', e);
      this.setData({ loading: false });
    }
  },

  // 最小化转账笔数：贪心匹配
  computeTransfers(settlements) {
    const creditors = []; // 应收（正余额）
    const debtors = [];   // 应付（负余额）

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
  }
});
