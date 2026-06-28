const cloud = require('../../utils/cloud');
const theme = require('../../utils/theme');

const QUICK_ACTIONS = [
  { id: 'trip', label: '创建行程', text: '帮我创建武汉三日游', icon: '/images/icons/trip-plan.png' },
  { id: 'expense', label: '快速记账', text: '晚餐 320 元，大家 AA，我先付', icon: '/images/icons/trip-ledger.png' },
  { id: 'budget', label: '查预算', text: '帮我看看这趟预算还剩多少，有没有超支', icon: '/images/icons/wallet.png' },
  { id: 'summary', label: '旅行总结', text: '生成当前行程的旅行总结', icon: '/images/icons/archive.png' },
  { id: 'packing', label: '生成清单', text: '按当前行程生成行李清单', icon: '/images/icons/packing.png' },
  { id: 'weather', label: '天气建议', text: '这趟行程天气怎么样，衣服怎么带？', icon: '/images/icons/date.png' }
];

const PACKING_CATEGORY_LABELS = {
  clothing: '衣物',
  toiletries: '洗漱',
  electronics: '电子',
  documents: '证件',
  medicine: '药品',
  other: '其他'
};

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(dateText, count) {
  const date = new Date(`${dateText}T00:00:00`);
  date.setDate(date.getDate() + count);
  return formatDate(date);
}

function parseDays(value) {
  const map = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
  return Math.min(14, Math.max(1, Number(value) || map[value] || 3));
}

Page({
  data: {
    trips: [],
    selectedTripId: '',
    selectedTripName: '自由咨询',
    inputText: '',
    sending: false,
    quickActions: QUICK_ACTIONS,
    messages: [{ id: 'welcome', role: 'assistant', text: '我可以帮你创建行程、整理清单，也能记账、算分摊和查预算。' }],
    pendingCard: null,
    cardSaving: false,
    scrollIntoView: 'welcome',
    keyboardHeight: 0,
    chatBottomSpace: 150
  },

  onShow() {
    theme.applyToPage(this);
    const tabBar = typeof this.getTabBar === 'function' && this.getTabBar();
    if (tabBar) {
      tabBar.setData({ selected: 2 });
      if (tabBar.refreshUnread) tabBar.refreshUnread();
    }
    this.loadTrips();
  },

  async loadTrips() {
    try {
      const { trips } = await cloud.getMyTrips();
      const activeTrips = (trips || []).filter(trip => trip.status !== 'archived');
      const storedId = wx.getStorageSync('_aiSelectedTripId') || '';
      const selected = activeTrips.find(trip => trip._id === storedId) || activeTrips[0];
      this.setData({
        trips: activeTrips,
        selectedTripId: selected ? selected._id : '',
        selectedTripName: selected ? selected.name : '自由咨询'
      });
    } catch (error) {
      console.warn('AI 加载行程失败:', error);
    }
  },

  onTripContextTap(e) {
    const tripId = e.currentTarget.dataset.id || '';
    const trip = this.data.trips.find(item => item._id === tripId);
    wx.setStorageSync('_aiSelectedTripId', tripId);
    this.setData({ selectedTripId: tripId, selectedTripName: trip ? trip.name : '自由咨询' });
  },

  onInput(e) { this.setData({ inputText: e.detail.value }); },

  onKeyboardHeightChange(e) {
    const height = Math.max(0, Number(e.detail && e.detail.height) || 0);
    this.setData({
      keyboardHeight: height,
      chatBottomSpace: height ? height + 128 : 150
    }, () => this.revealBottom(40));
  },

  onQuickAction(e) {
    const action = this.data.quickActions.find(item => item.id === e.currentTarget.dataset.id);
    if (!action) return;
    this.setData({ inputText: action.text }, () => this.onSend());
  },

  appendMessage(role, text) {
    const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this.setData({ messages: [...this.data.messages, { id, role, text }], scrollIntoView: id });
  },

  revealBottom(delay = 80) {
    setTimeout(() => {
      this.setData({ scrollIntoView: 'chat-bottom-anchor' });
    }, delay);
  },

  selectedTrip() {
    return this.data.trips.find(trip => trip._id === this.data.selectedTripId) || null;
  },

  parseTripDraft(text) {
    const match = text.match(/(?:创建|新建|规划)(?:一个|一份)?\s*([^\d一二两三四五六七八九十]{2,12}?)([\d一二两三四五六七八九十]+)日?(?:天|游)/);
    if (!match) return null;
    const city = match[1].replace(/^(?:帮我|去)/, '').trim();
    const days = parseDays(match[2]);
    if (!city) return null;
    const startDate = formatDate(new Date());
    return { type: 'trip_draft', city, days, name: `${city}${days}日游`, startDate, endDate: addDays(startDate, days - 1) };
  },

  isLedgerIntent(text) {
    return /记账|账本|花了|支出|消费|预算|aa|平摊|分摊|谁付|付款|多少|合计|¥|￥|\d+(?:\.\d+)?\s*(?:元|块)/i.test(text);
  },

  isPackingIntent(text) {
    return /行李|清单|打包|带什么|要带|收拾|物品|装备/i.test(text);
  },

  isSummaryIntent(text) {
    return /总结|回顾|归档|旅行报告|旅途报告|生成.*回忆/i.test(text);
  },

  isPlanDraftIntent(text) {
    return /(?:写入|保存|加入|生成|创建).*(?:日程|行程草案|安排)|(?:把|帮我把).*(?:安排到|写到).*(?:行程|日程)/i.test(text);
  },

  async onSend() {
    const text = String(this.data.inputText || '').trim();
    if (!text || this.data.sending) return;
    this.appendMessage('user', text);
    this.setData({ inputText: '', sending: true, pendingCard: null });
    try {
      const tripDraft = this.parseTripDraft(text);
      if (tripDraft) {
        this.setData({ pendingCard: tripDraft, sending: false });
        this.appendMessage('assistant', '我先把行程信息整理好了，确认后再创建。');
        this.revealBottom();
        return;
      }
      if (this.isPackingIntent(text)) {
        const result = await cloud.generatePackingSuggestions();
        const suggestions = (result.suggestions || []).slice(0, 35).map((item, index) => ({
          ...item,
          selected: true,
          categoryLabel: PACKING_CATEGORY_LABELS[item.category] || '其他',
          key: `${item.category || 'other'}_${index}_${String(item.name || '').slice(0, 8)}`
        }));
        if (!suggestions.length) throw new Error('这次没有生成可用清单，可以换个说法再试。');
        this.setData({
          pendingCard: {
            type: 'packing_draft',
            trip: result.currentTrip || null,
            suggestions
          },
          sending: false
        });
        this.appendMessage('assistant', `我按${result.currentTrip ? `「${result.currentTrip.name}」` : '当前行程'}整理了一份行李建议，你可以确认后加入清单。`);
        this.revealBottom();
        return;
      }
      if (this.isSummaryIntent(text)) {
        const selectedTrip = this.selectedTrip();
        if (!selectedTrip) throw new Error('请先选择一个行程，我才能生成旅行总结。');
        this.setData({
          pendingCard: { type: 'summary_link', trip: selectedTrip },
          sending: false
        });
        this.appendMessage('assistant', `我可以把「${selectedTrip.name}」整理成旅行总结，里面会汇总日程、动态、照片和账本。`);
        this.revealBottom();
        return;
      }
      if (this.isLedgerIntent(text)) {
        if (!this.data.selectedTripId) throw new Error('请先选择一个行程，我才知道要查哪本账。');
        const result = await cloud.tripLedgerAssistant(this.data.selectedTripId, text);
        if (result.type === 'answer') this.appendMessage('assistant', result.answer);
        else {
          this.setData({ pendingCard: { type: 'expense_draft', ...result.draft } });
          this.appendMessage('assistant', '这笔支出已整理好，确认后才会写入账本。');
          this.revealBottom();
        }
        this.setData({ sending: false });
        return;
      }
      const selectedTrip = this.selectedTrip();
      if (selectedTrip && this.isPlanDraftIntent(text)) {
        const plan = await cloud.generateTripPlan(selectedTrip._id, selectedTrip.city, selectedTrip.totalDays, text);
        this.setData({ pendingCard: { type: 'plan_draft', plan, trip: selectedTrip }, sending: false });
        this.appendMessage('assistant', '行程草案已生成，确认后再写入日程。');
        this.revealBottom();
        return;
      }
      const answer = await cloud.globalTravelAssistant(text, this.data.selectedTripId);
      this.appendMessage('assistant', answer);
      this.setData({ sending: false });
    } catch (error) {
      this.appendMessage('assistant', error.message || '暂时没有处理成功，可以换个说法再试。');
      this.setData({ sending: false });
    }
  },

  onTripStartDateChange(e) {
    const card = this.data.pendingCard;
    if (!card || card.type !== 'trip_draft') return;
    const startDate = e.detail.value;
    this.setData({ pendingCard: { ...card, startDate, endDate: addDays(startDate, card.days - 1) } });
  },

  async onConfirmCard() {
    const card = this.data.pendingCard;
    if (!card || this.data.cardSaving) return;
    this.setData({ cardSaving: true });
    try {
      if (card.type === 'trip_draft') {
        const result = await cloud.createTrip({ name: card.name, city: card.city, startDate: card.startDate, endDate: card.endDate, totalDays: card.days, totalBudget: 0, categoryBudgets: {} });
        wx.setStorageSync('_aiSelectedTripId', result.tripId);
        this.appendMessage('assistant', `已创建“${card.name}”，接下来可以继续让我安排具体行程。`);
        await this.loadTrips();
      } else if (card.type === 'expense_draft') {
        await cloud.addExpense({ ...card, tripId: this.data.selectedTripId, createdAt: new Date().toISOString() });
        this.appendMessage('assistant', `已记账：${card.description} ¥${card.amount}。`);
      } else if (card.type === 'plan_draft') {
        const trip = card.trip;
        const detail = await cloud.getTripDetail(trip._id);
        for (const day of card.plan.days || []) {
          const dayIndex = Number(day.dayIndex) || 1;
          const existing = (detail.dayPlans || []).find(item => item.dayIndex === dayIndex);
          const date = cloud.dateRange(trip.startDate, trip.endDate)[dayIndex - 1];
          const items = (day.items || []).map(item => ({ ...item, sortId: `ai_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}` }));
          await cloud.upsertDayPlan(existing && existing._id, trip._id, dayIndex, date, items);
        }
        this.appendMessage('assistant', '行程草案已写入日程。');
      } else if (card.type === 'packing_draft') {
        const selected = (card.suggestions || [])
          .filter(item => item.selected)
          .map(({ name, category }) => ({ name, category }));
        if (!selected.length) throw new Error('请至少保留一件物品');
        const result = await cloud.addGeneratedPackingItems(selected);
        this.appendMessage('assistant', `已加入行李清单：新增 ${result.added || 0} 件${result.skipped ? `，跳过 ${result.skipped} 件重复物品` : ''}。`);
      } else if (card.type === 'summary_link') {
        wx.navigateTo({ url: `/pages/trip-summary/trip-summary?tripId=${card.trip._id}` });
        this.appendMessage('assistant', '已打开旅行总结。');
      }
      this.setData({ pendingCard: null, cardSaving: false });
      wx.showToast({ title: '已完成', icon: 'success' });
    } catch (error) {
      this.setData({ cardSaving: false });
      wx.showToast({ title: error.message || '操作失败', icon: 'none' });
    }
  },

  onTogglePackingItem(e) {
    const index = Number(e.currentTarget.dataset.index);
    const card = this.data.pendingCard;
    if (!card || card.type !== 'packing_draft' || !card.suggestions[index]) return;
    const suggestions = card.suggestions.map((item, i) => i === index ? { ...item, selected: !item.selected } : item);
    this.setData({ pendingCard: { ...card, suggestions } });
  },

  onCancelCard() { this.setData({ pendingCard: null, cardSaving: false }); }
});
