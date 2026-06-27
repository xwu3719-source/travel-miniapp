const cloud = require('../../utils/cloud');

const CATEGORY_LABELS = {
  transport: '交通',
  hotel: '住宿',
  food: '餐饮',
  tickets: '门票',
  shopping: '购物',
  other: '其他'
};

function money(value) {
  return (Math.round((Number(value) || 0) * 100) / 100).toFixed(2);
}

function formatDate(value) {
  return String(value || '').slice(0, 10);
}

function formatTimelineDate(value) {
  const text = formatDate(value);
  if (!text) return '旅途中';
  const parts = text.split('-');
  if (parts.length < 3) return text;
  return `${Number(parts[1])}月${Number(parts[2])}日`;
}

function normalizeTime(value) {
  const text = String(value || '').trim();
  return /^\d{1,2}:\d{2}/.test(text) ? text.slice(0, 5).padStart(5, '0') : '99:99';
}

Page({
  data: {
    tripId: '',
    loading: true,
    trip: null,
    members: [],
    dayPlans: [],
    moments: [],
    metrics: {
      days: 0,
      members: 0,
      planItems: 0,
      moments: 0,
      images: 0,
      total: '0.00',
      shared: '0.00',
      private: '0.00'
    },
    topCategory: null,
    topExpense: null,
    planHighlights: [],
    momentHighlights: [],
    insights: [],
    timeline: [],
    recapText: '',
    recapLoading: false
  },

  onLoad(options) {
    this.setData({ tripId: options.tripId || '' });
    this.loadSummary();
  },

  async loadSummary() {
    const tripId = this.data.tripId;
    if (!tripId) {
      wx.showToast({ title: '缺少行程', icon: 'none' });
      return;
    }
    this.setData({ loading: true });
    try {
      const [detail, snapshot, feed] = await Promise.all([
        cloud.getTripDetail(tripId),
        cloud.getTripSnapshot(tripId, ['expenses']),
        cloud.getMomentFeed({ tripId, limit: 60 })
      ]);
      const trip = detail.trip || {};
      const members = detail.members || [];
      const dayPlans = detail.dayPlans || [];
      const expenses = snapshot.expenses || [];
      const moments = (feed.moments || []).filter(item => !item.isPrivate);
      await cloud.resolveMoments(moments).catch(() => {});

      let total = 0;
      let shared = 0;
      let privateTotal = 0;
      const catMap = {};
      let topExpense = null;

      expenses.forEach(item => {
        const amount = Math.max(0, (Number(item.amount) || 0) - (Number(item.refunded) || 0));
        total += amount;
        if (item.type === 'shared') shared += amount;
        else privateTotal += amount;
        const cat = item.category || 'other';
        catMap[cat] = (catMap[cat] || 0) + amount;
        if (!topExpense || amount > topExpense.amount) {
          topExpense = {
            description: item.description || '支出',
            amount,
            amountText: money(amount),
            categoryLabel: CATEGORY_LABELS[cat] || '其他',
            paidByName: item.paidByName || '未知'
          };
        }
      });

      const topCategoryEntry = Object.entries(catMap).sort((a, b) => b[1] - a[1])[0];
      const topCategory = topCategoryEntry ? {
        key: topCategoryEntry[0],
        label: CATEGORY_LABELS[topCategoryEntry[0]] || '其他',
        amount: money(topCategoryEntry[1]),
        percent: total > 0 ? Math.round(topCategoryEntry[1] / total * 100) : 0
      } : null;

      const planItems = dayPlans.flatMap(day => (day.items || []).map(item => ({
        ...item,
        dayIndex: day.dayIndex,
        date: day.date,
        summaryKey: item.sortId || `${day.dayIndex}_${item.time || ''}_${item.title || ''}`
      })));
      const images = moments.reduce((sum, item) => sum + ((item.images || []).length), 0);
      const momentHighlights = moments.slice(0, 4).map(item => ({
        id: item._id,
        text: item.text || '旅途动态',
        image: (item.imageThumbs && item.imageThumbs[0]) || (item.images && item.images[0]) || '',
        authorName: item.authorName || '旅伴',
        time: cloud.formatDate(item.createdAt)
      }));

      const insights = [];
      if (topCategory) insights.push(`${topCategory.label}是最大开销，占总支出的 ${topCategory.percent}%`);
      if (topExpense) insights.push(`最贵一笔是「${topExpense.description}」，¥${topExpense.amountText}`);
      if (moments.length) insights.push(`这趟留下了 ${moments.length} 条动态和 ${images} 张图片`);
      if (!expenses.length) insights.push('这趟还没有账本记录，可以从历史里继续补记');
      if (!moments.length) insights.push('这趟还没有公开动态，可以补几张旅途照片做回忆');
      const timeline = this.buildTimeline(planItems, moments, expenses);

      this.setData({
        trip,
        members,
        dayPlans,
        moments,
        metrics: {
          days: trip.totalDays || dayPlans.length || 0,
          members: members.length,
          planItems: planItems.length,
          moments: moments.length,
          images,
          total: money(total),
          shared: money(shared),
          private: money(privateTotal)
        },
        topCategory,
        topExpense,
        planHighlights: planItems.slice(0, 6),
        momentHighlights,
        insights,
        timeline,
        loading: false
      });
    } catch (error) {
      console.error('加载旅行总结失败:', error);
      this.setData({ loading: false });
      wx.showToast({ title: error.message || '加载失败', icon: 'none' });
    }
  },

  onMomentTap(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: `/pages/moment-detail/moment-detail?momentId=${id}` });
  },

  buildTimeline(planItems, moments, expenses) {
    const planEvents = (planItems || []).map((item, index) => ({
      id: `plan_${item.summaryKey || index}`,
      type: 'plan',
      icon: '/images/icons/trip-plan.png',
      sortDate: formatDate(item.date),
      sortTime: normalizeTime(item.time),
      displayDate: formatTimelineDate(item.date),
      title: item.title || '行程安排',
      meta: `Day ${item.dayIndex || '-'} · ${item.time || '时间待定'}${item.location ? ` · ${item.location}` : ''}`,
      image: ''
    }));

    const momentEvents = (moments || []).slice(0, 12).map((item, index) => ({
      id: `moment_${item._id || index}`,
      momentId: item._id,
      type: 'moment',
      icon: '/images/icons/trip-moments.png',
      sortDate: formatDate(item.createdAt),
      sortTime: normalizeTime(String(item.createdAt || '').slice(11, 16)),
      displayDate: formatTimelineDate(item.createdAt),
      title: item.text || '旅途动态',
      meta: `${item.authorName || '旅伴'} · ${cloud.formatDate(item.createdAt) || '刚刚'}`,
      image: (item.imageThumbs && item.imageThumbs[0]) || (item.images && item.images[0]) || ''
    }));

    const expenseEvents = (expenses || []).slice(0, 12).map((item, index) => {
      const amount = Math.max(0, (Number(item.amount) || 0) - (Number(item.refunded) || 0));
      return {
        id: `expense_${item._id || index}`,
        type: 'expense',
        icon: '/images/icons/wallet.png',
        sortDate: formatDate(item.createdAt),
        sortTime: normalizeTime(String(item.createdAt || '').slice(11, 16)),
        displayDate: formatTimelineDate(item.createdAt),
        title: item.description || '账本记录',
        meta: `${CATEGORY_LABELS[item.category] || '其他'} · ¥${money(amount)} · ${item.paidByName || '未知'}付款`,
        image: ''
      };
    });

    return [...planEvents, ...momentEvents, ...expenseEvents]
      .sort((a, b) => {
        const dateCompare = String(a.sortDate || '').localeCompare(String(b.sortDate || ''));
        if (dateCompare !== 0) return dateCompare;
        return String(a.sortTime || '').localeCompare(String(b.sortTime || ''));
      })
      .slice(0, 40);
  },

  onTimelineTap(e) {
    const { momentId } = e.currentTarget.dataset;
    if (momentId) wx.navigateTo({ url: `/pages/moment-detail/moment-detail?momentId=${momentId}` });
  },

  onGoLedger() {
    wx.navigateTo({ url: `/pages/ledger/ledger?tripId=${this.data.tripId}` });
  },

  onCopySummary() {
    const { trip, metrics, topCategory, topExpense } = this.data;
    const lines = [
      `「${trip.name || '这趟旅行'}」旅行总结`,
      `${formatDate(trip.startDate)} → ${formatDate(trip.endDate)} · ${metrics.days} 天 · ${metrics.members} 位成员`,
      `总消费 ¥${metrics.total}，公共 ¥${metrics.shared}，私人 ¥${metrics.private}`,
      topCategory ? `最大分类：${topCategory.label} ¥${topCategory.amount}（${topCategory.percent}%）` : '',
      topExpense ? `最贵一笔：${topExpense.description} ¥${topExpense.amountText}` : '',
      `动态 ${metrics.moments} 条，图片 ${metrics.images} 张`
    ].filter(Boolean).join('\n');
    wx.setClipboardData({
      data: lines,
      success: () => wx.showToast({ title: '总结已复制', icon: 'success' })
    });
  },

  buildRecapPrompt() {
    const { trip, metrics, topCategory, topExpense, insights, timeline } = this.data;
    const timelineText = (timeline || []).slice(0, 12)
      .map(item => `${item.displayDate} ${item.title}（${item.meta}）`)
      .join('\n');
    return [
      '你是「拾途 ST」的旅行复盘助手。',
      '请根据下面数据写一段漂亮、自然、不油腻的中文旅行复盘。',
      '要求：4 到 6 句；像朋友帮忙整理回忆；不要使用夸张营销语；可以带一点温柔感；最后给 2 条下次旅行建议。',
      `行程：${trip.name || '未命名行程'}，${formatDate(trip.startDate)} 到 ${formatDate(trip.endDate)}，${metrics.days} 天，${metrics.members} 位成员。`,
      `安排：${metrics.planItems} 个；动态：${metrics.moments} 条；图片：${metrics.images} 张。`,
      `消费：总计 ¥${metrics.total}，公共 ¥${metrics.shared}，私人 ¥${metrics.private}。`,
      topCategory ? `最大消费分类：${topCategory.label} ¥${topCategory.amount}，占 ${topCategory.percent}%。` : '',
      topExpense ? `最贵单笔：${topExpense.description} ¥${topExpense.amountText}。` : '',
      insights.length ? `系统观察：${insights.join('；')}` : '',
      timelineText ? `时间线：\n${timelineText}` : ''
    ].filter(Boolean).join('\n');
  },

  localRecapFallback() {
    const { trip, metrics, insights } = this.data;
    const firstInsight = insights[0] || `这趟一共整理了 ${metrics.planItems} 个安排`;
    const secondInsight = insights[1] || `留下了 ${metrics.moments} 条动态和 ${metrics.images} 张图片`;
    return `「${trip.name || '这趟旅行'}」已经被整理成一份可回看的旅行手账。\n${firstInsight}，${secondInsight}。\n下次可以提前补齐每天的集合时间和预算提醒，让旅途更从容；也可以把好看的照片发到动态里，结束后会更像一本完整的旅行相册。`;
  },

  async onGenerateRecap() {
    if (this.data.recapLoading) return;
    this.setData({ recapLoading: true });
    try {
      const text = await cloud.globalTravelAssistant(this.buildRecapPrompt(), this.data.tripId);
      this.setData({ recapText: (text || '').trim() || this.localRecapFallback(), recapLoading: false });
    } catch (error) {
      console.warn('AI 复盘失败，使用本地总结:', error);
      this.setData({ recapText: this.localRecapFallback(), recapLoading: false });
      wx.showToast({ title: 'AI 暂时不可用，已生成本地复盘', icon: 'none' });
    }
  },

  onCopyRecap() {
    const text = this.data.recapText || this.localRecapFallback();
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '复盘已复制', icon: 'success' })
    });
  }
});
