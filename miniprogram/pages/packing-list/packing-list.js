const cloud = require('../../utils/cloud');

const SUBCATEGORIES = {
  clothing: [
    { id: 'all', label: '全部' },
    { id: 'top', label: '上装', keys: ['T恤', '衬衫', '外套', '卫衣', '夹克', '西装', '毛衣', '背心', '马甲', 'Polo'] },
    { id: 'bottom', label: '下装', keys: ['裤', '裙', '短裤', '牛仔裤'] },
    { id: 'under', label: '内衣', keys: ['内衣', '内裤', '袜子', '文胸', 'bra', '打底'] },
    { id: 'shoes', label: '鞋帽', keys: ['鞋', '帽', '围巾', '手套', '拖鞋', '凉鞋'] }
  ],
  toiletries: [
    { id: 'all', label: '全部' },
    { id: 'face', label: '面部', keys: ['洗面', '卸妆', '防晒', '护肤', '面霜', '爽肤水', '乳液', '精华', '面膜'] },
    { id: 'oral', label: '口腔', keys: ['牙刷', '牙膏', '漱口水', '牙线'] },
    { id: 'body', label: '洗护', keys: ['沐浴', '洗发', '毛巾', '浴巾', '香皂', '身体乳', '护发素', '梳子'] }
  ],
  electronics: [
    { id: 'all', label: '全部' },
    { id: 'charge', label: '充电', keys: ['充电', '线', '插头', '适配器', '移动电源', '充电宝', '数据线'] },
    { id: 'audio', label: '影音', keys: ['耳机', '音箱', '相机', '自拍杆', '稳定器'] },
    { id: 'work', label: '办公', keys: ['电脑', '平板', 'iPad', '笔记本', 'U盘', '鼠标'] }
  ],
  documents: [
    { id: 'all', label: '全部' },
    { id: 'idcard', label: '身份证件', keys: ['身份证', '护照', '驾照', '签证', '通行证'] },
    { id: 'ticket', label: '票务', keys: ['机票', '车票', '火车票', '船票', '门票', '登机牌'] },
    { id: 'hotel', label: '住宿', keys: ['酒店', '民宿', '预定', '订单', '确认函'] }
  ],
  medicine: [
    { id: 'all', label: '全部' },
    { id: 'inner', label: '内服', keys: ['感冒', '退烧', '止痛', '消炎', '肠胃', '晕车', '过敏', '维生素'] },
    { id: 'outer', label: '外用', keys: ['创可贴', '药膏', '喷雾', '膏药', '贴', '碘伏', '酒精', '棉签'] },
    { id: 'firstaid', label: '急救', keys: ['急救', '绷带', '止血', '消毒', '纱布', '温度计'] }
  ],
  other: [{ id: 'all', label: '全部' }]
};

const CATEGORY_DEFS = [
  { id: 'clothing', label: '衣物', count: 0 },
  { id: 'toiletries', label: '洗漱', count: 0 },
  { id: 'electronics', label: '电子', count: 0 },
  { id: 'documents', label: '证件', count: 0 },
  { id: 'medicine', label: '药品', count: 0 },
  { id: 'other', label: '其他', count: 0 }
];

Page({
  data: {
    allItems: [],
    displayItems: [],
    packingText: '',
    packingChecked: 0,
    packingPercent: 0,
    packingPercentText: '0%',
    activeCategory: 'clothing',
    activeCategoryLabel: '衣物',
    activeSub: 'all',
    activeSubLabel: '全部',
    searchText: '',
    swipedItemId: '',
    categories: CATEGORY_DEFS,
    currentSubs: SUBCATEGORIES.clothing,
    historyVisible: false,
    historyLoading: false,
    histories: [],
    currentTripId: '',
    currentTripName: '',
    currentTripCity: '',
    requiresCurrentTrip: false,
    aiGenerating: false,
    aiPreviewVisible: false,
    packingSuggestions: [],
    selectedSuggestionCount: 0
  },

  onShow() {
    this.loadPackingList();
  },

  noop() {},

  packingStats(items) {
    const checked = items.filter(item => item.checked).length;
    const total = items.length;
    const percent = total ? Math.round(checked / total * 100) : 0;
    return {
      packingChecked: checked,
      packingPercent: percent,
      packingPercentText: `${percent}%`
    };
  },

  categoryLabel(categoryId) {
    const category = CATEGORY_DEFS.find(item => item.id === categoryId);
    return category ? category.label : '其他';
  },

  decorateSubs(categoryId, items) {
    const categoryItems = items.filter(item => (item.category || 'other') === categoryId);
    return (SUBCATEGORIES[categoryId] || SUBCATEGORIES.other).map(sub => ({
      ...sub,
      count: sub.id === 'all'
        ? categoryItems.length
        : categoryItems.filter(item => (sub.keys || []).some(key => item.name.includes(key))).length
    }));
  },

  updateLocalItems(items, callback) {
    const categories = CATEGORY_DEFS.map(category => ({
      ...category,
      count: items.filter(item => (item.category || 'other') === category.id).length
    }));
    const currentSubs = this.decorateSubs(this.data.activeCategory, items);
    this.setData({
      allItems: items,
      categories,
      currentSubs,
      ...this.packingStats(items)
    }, () => {
      this.applyFilter();
      if (callback) callback();
    });
  },

  async loadPackingList() {
    if (this._loadingPacking) return;
    this._loadingPacking = true;
    try {
      const context = await cloud.getPackingContext();
      const items = context.items || [];
      const order = ['clothing', 'toiletries', 'electronics', 'documents', 'medicine', 'other'];
      items.sort((a, b) => order.indexOf(a.category || 'other') - order.indexOf(b.category || 'other'));
      this.setData({
        currentTripId: context.currentTrip ? context.currentTrip._id : '',
        currentTripName: context.currentTrip ? context.currentTrip.name : '',
        currentTripCity: context.currentTrip ? context.currentTrip.city : '',
        requiresCurrentTrip: !!context.requiresCurrentTrip
      });
      this.updateLocalItems(items);
    } catch (error) {
      console.warn('加载行李清单失败:', error);
      wx.showToast({ title: '清单加载失败', icon: 'none' });
    } finally {
      this._loadingPacking = false;
    }
  },

  applyFilter() {
    const { allItems, activeCategory, activeSub, searchText } = this.data;
    let displayItems;
    if (searchText.trim()) {
      const keyword = searchText.trim().toLowerCase();
      displayItems = allItems.filter(item => item.name.toLowerCase().includes(keyword));
    } else {
      displayItems = allItems.filter(item => (item.category || 'other') === activeCategory);
      if (activeSub !== 'all') {
        const sub = (SUBCATEGORIES[activeCategory] || []).find(item => item.id === activeSub);
        if (sub && sub.keys) {
          displayItems = displayItems.filter(item => sub.keys.some(key => item.name.includes(key)));
        }
      }
    }
    this.setData({ displayItems });
  },

  onSelectCategory(event) {
    const { id } = event.currentTarget.dataset;
    if (!id || id === this.data.activeCategory) return;
    this.setData({
      activeCategory: id,
      activeCategoryLabel: this.categoryLabel(id),
      activeSub: 'all',
      activeSubLabel: '全部',
      currentSubs: this.decorateSubs(id, this.data.allItems),
      swipedItemId: ''
    }, () => this.applyFilter());
  },

  onSelectSub(event) {
    const { sub } = event.currentTarget.dataset;
    const definition = (SUBCATEGORIES[this.data.activeCategory] || []).find(item => item.id === sub);
    this.setData({
      activeSub: sub,
      activeSubLabel: definition ? definition.label : '全部',
      swipedItemId: ''
    }, () => this.applyFilter());
  },

  onSearchInput(event) {
    this.setData({ searchText: event.detail.value || '', swipedItemId: '' }, () => this.applyFilter());
  },

  onClearSearch() {
    this.setData({ searchText: '' }, () => this.applyFilter());
  },

  onPackingInput(event) {
    this.setData({ packingText: event.detail.value || '' });
  },

  hasDuplicate(name, category) {
    const normalized = String(name).trim().toLowerCase();
    return this.data.allItems.some(item =>
      (item.category || 'other') === category && item.name.trim().toLowerCase() === normalized
    );
  },

  async addPackingItem(name) {
    const cleanName = String(name || '').trim();
    if (!cleanName) return;
    if (this.data.requiresCurrentTrip) {
      this.showCurrentTripRequired();
      return;
    }
    const category = this.data.activeCategory || 'other';
    if (this.hasDuplicate(cleanName, category)) {
      wx.showToast({ title: '这件物品已经在清单里', icon: 'none' });
      return;
    }
    try {
      const result = await cloud.addMyPackingItem(cleanName, category);
      if (!result.success) throw new Error(result.error || '添加失败');
      this.updateLocalItems([...this.data.allItems, result.item]);
      this.setData({ packingText: '' });
    } catch (error) {
      wx.showToast({ title: error.message || '添加失败', icon: 'none' });
    }
  },

  onAddPackingItem() {
    this.addPackingItem(this.data.packingText);
  },

  async togglePackingItem(id) {
    if (!id || this._togglingPacking) return;
    this._togglingPacking = id;
    try {
      await cloud.toggleMyPackingItem(id);
      const items = this.data.allItems.map(item =>
        item._id === id ? { ...item, checked: !item.checked } : item
      );
      this.updateLocalItems(items);
    } catch (error) {
      wx.showToast({ title: error.message || '操作失败', icon: 'none' });
    } finally {
      this._togglingPacking = '';
    }
  },

  onPackingRowTap(event) {
    if (this.data.swipedItemId) {
      this.setData({ swipedItemId: '' });
      return;
    }
    this.togglePackingItem(event.currentTarget.dataset.id);
  },

  onPackingCheckTap(event) {
    this.togglePackingItem(event.currentTarget.dataset.id);
  },

  onPackingTouchStart(event) {
    const touch = event.touches && event.touches[0];
    if (!touch) return;
    this._packSwipeX = touch.clientX;
    this._packSwipeY = touch.clientY;
    this._packSwipeId = event.currentTarget.dataset.id;
  },

  onPackingTouchEnd(event) {
    if (typeof this._packSwipeX !== 'number') return;
    const touch = event.changedTouches && event.changedTouches[0];
    if (!touch) return;
    const dx = touch.clientX - this._packSwipeX;
    const dy = touch.clientY - this._packSwipeY;
    this._packSwipeX = null;
    if (Math.abs(dx) < Math.abs(dy)) return;
    if (dx < -40) this.setData({ swipedItemId: this._packSwipeId });
    else if (dx > 20) this.setData({ swipedItemId: '' });
  },

  async onRemovePackingItem(event) {
    const { id } = event.currentTarget.dataset;
    this.setData({ swipedItemId: '' });
    try {
      await cloud.removeMyPackingItem(id);
      this.updateLocalItems(this.data.allItems.filter(item => item._id !== id));
    } catch (error) {
      wx.showToast({ title: error.message || '删除失败', icon: 'none' });
    }
  },

  onResetPacking() {
    if (!this.data.packingChecked) {
      wx.showToast({ title: '当前没有已勾选物品', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '重置勾选状态',
      content: '清单内容会保留，只取消所有勾选。',
      success: async result => {
        if (!result.confirm) return;
        try {
          const checkedItems = this.data.allItems.filter(item => item.checked);
          await Promise.all(checkedItems.map(item => cloud.toggleMyPackingItem(item._id)));
          this.updateLocalItems(this.data.allItems.map(item => ({ ...item, checked: false })));
          wx.showToast({ title: '已重置', icon: 'success' });
        } catch (error) {
          wx.showToast({ title: '重置失败', icon: 'none' });
        }
      }
    });
  },

  formatHistory(history) {
    const date = new Date(history.createdAt || Date.now());
    return {
      ...history,
      itemCount: Number(history.itemCount) || (history.items || []).length,
      createdLabel: `${date.getMonth() + 1}月${date.getDate()}日`
    };
  },

  async onOpenHistory() {
    this.setData({ historyVisible: true, historyLoading: true });
    try {
      const histories = await cloud.getPackingHistories();
      this.setData({ histories: histories.map(item => this.formatHistory(item)) });
    } catch (error) {
      wx.showToast({ title: error.message || '历史清单加载失败', icon: 'none' });
    } finally {
      this.setData({ historyLoading: false });
    }
  },

  onCloseHistory() {
    this.setData({
      historyVisible: false,
      aiPreviewVisible: false,
      packingSuggestions: [],
      selectedSuggestionCount: 0
    });
  },

  showCurrentTripRequired() {
    wx.showModal({
      title: '请先设置当前行程',
      content: '行李清单会分别保存在每个行程中，请先选择当前正在准备的行程。',
      confirmText: '去设置',
      success: result => {
        if (result.confirm) this.onGoSetCurrentTrip();
      }
    });
  },

  onGoSetCurrentTrip() {
    this.setData({ historyVisible: false });
    wx.switchTab({ url: '/pages/index/index' });
  },

  onSaveHistory() {
    if (this.data.requiresCurrentTrip) {
      this.showCurrentTripRequired();
      return;
    }
    if (!this.data.allItems.length) {
      wx.showToast({ title: '当前清单还是空的', icon: 'none' });
      return;
    }
    const now = new Date();
    wx.showModal({
      title: '保存历史清单',
      editable: true,
      placeholderText: '给这份清单起个名字',
      content: `${now.getMonth() + 1}月${now.getDate()}日清单`,
      success: async result => {
        if (!result.confirm) return;
        const name = String(result.content || '').trim() || `${now.getMonth() + 1}月${now.getDate()}日清单`;
        try {
          const history = await cloud.savePackingHistory(name);
          this.setData({ histories: [this.formatHistory(history), ...this.data.histories] });
          wx.showToast({ title: '已保存', icon: 'success' });
        } catch (error) {
          wx.showToast({ title: error.message || '保存失败', icon: 'none' });
        }
      }
    });
  },

  onApplyHistory(event) {
    if (this.data.requiresCurrentTrip) {
      this.showCurrentTripRequired();
      return;
    }
    const { id } = event.currentTarget.dataset;
    const history = this.data.histories.find(item => item._id === id);
    wx.showModal({
      title: '添加历史清单',
      content: `将「${history ? history.name : '这份清单'}」中尚未存在的物品添加到当前清单。`,
      success: async result => {
        if (!result.confirm) return;
        try {
          const applyResult = await cloud.applyPackingHistory(id);
          await this.loadPackingList();
          this.setData({ historyVisible: false });
          wx.showToast({
            title: applyResult.added ? `已添加 ${applyResult.added} 件` : '没有需要添加的物品',
            icon: 'none'
          });
        } catch (error) {
          wx.showToast({ title: error.message || '添加失败', icon: 'none' });
        }
      }
    });
  },

  onDeleteHistory(event) {
    const { id } = event.currentTarget.dataset;
    const history = this.data.histories.find(item => item._id === id);
    wx.showModal({
      title: '删除历史清单',
      content: `确定删除「${history ? history.name : '这份清单'}」吗？`,
      confirmColor: '#e6505d',
      success: async result => {
        if (!result.confirm) return;
        try {
          await cloud.deletePackingHistory(id);
          this.setData({ histories: this.data.histories.filter(item => item._id !== id) });
        } catch (error) {
          wx.showToast({ title: error.message || '删除失败', icon: 'none' });
        }
      }
    });
  },

  async onGeneratePacking() {
    if (this.data.requiresCurrentTrip) {
      this.showCurrentTripRequired();
      return;
    }
    if (this.data.aiGenerating) return;
    this.setData({ aiGenerating: true });
    wx.showLoading({ title: '正在分析行程', mask: true });
    try {
      const result = await cloud.generatePackingSuggestions();
      const suggestions = (result.suggestions || []).map((item, index) => ({
        ...item,
        id: `packing_suggestion_${index}`,
        categoryLabel: this.categoryLabel(item.category),
        selected: true
      }));
      if (!suggestions.length) throw new Error('没有生成有效建议');
      this.setData({
        aiPreviewVisible: true,
        packingSuggestions: suggestions,
        selectedSuggestionCount: suggestions.length
      });
    } catch (error) {
      wx.showToast({ title: error.message || '生成失败，请稍后重试', icon: 'none', duration: 2600 });
    } finally {
      wx.hideLoading();
      this.setData({ aiGenerating: false });
    }
  },

  onSuggestionToggle(event) {
    const index = Number(event.currentTarget.dataset.index);
    if (!Number.isInteger(index) || !this.data.packingSuggestions[index]) return;
    const suggestions = this.data.packingSuggestions.map((item, itemIndex) =>
      itemIndex === index ? { ...item, selected: !item.selected } : item
    );
    this.setData({
      packingSuggestions: suggestions,
      selectedSuggestionCount: suggestions.filter(item => item.selected).length
    });
  },

  onToggleAllSuggestions() {
    const shouldSelect = this.data.selectedSuggestionCount !== this.data.packingSuggestions.length;
    const suggestions = this.data.packingSuggestions.map(item => ({ ...item, selected: shouldSelect }));
    this.setData({
      packingSuggestions: suggestions,
      selectedSuggestionCount: shouldSelect ? suggestions.length : 0
    });
  },

  onBackToHistories() {
    this.setData({ aiPreviewVisible: false });
  },

  async onConfirmSuggestions() {
    const selected = this.data.packingSuggestions
      .filter(item => item.selected)
      .map(({ name, category }) => ({ name, category }));
    if (!selected.length) {
      wx.showToast({ title: '请至少选择一件物品', icon: 'none' });
      return;
    }
    if (this._addingSuggestions) return;
    this._addingSuggestions = true;
    wx.showLoading({ title: '正在加入清单', mask: true });
    try {
      const result = await cloud.addGeneratedPackingItems(selected);
      await this.loadPackingList();
      this.onCloseHistory();
      wx.showToast({
        title: result.added ? `已加入 ${result.added} 件` : '这些物品已在清单中',
        icon: 'none'
      });
    } catch (error) {
      wx.showToast({ title: error.message || '加入清单失败', icon: 'none' });
    } finally {
      wx.hideLoading();
      this._addingSuggestions = false;
    }
  }
});
