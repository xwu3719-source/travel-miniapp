const cloud = require('../../utils/cloud');
const theme = require('../../utils/theme');

function addDays(dateString, offset) {
  const date = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(date.getTime())) return '';
  date.setDate(date.getDate() + Number(offset || 0));
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

Page({
  data: {
    themeStyle: '',
    themeClass: 'theme-blue',
    isEdit: false,
    tripId: '',
    sourceTripId: '',
    templateId: '',
    sourceLabel: '',
    reusableDays: 0,
    templates: [],
    templatesLoading: false,
    name: '',
    city: '',
    startDate: '',
    endDate: '',
    totalBudget: '',
    categoryBudgets: {
      transport: '',
      hotel: '',
      food: '',
      tickets: '',
      shopping: '',
      other: ''
    },
    showCategoryBudget: false,
    nameFocus: false,
    cityFocus: false,
    budgetFocus: false,
    saving: false,
    categories: [
      { key: 'transport', icon: '/images/icons/category-transport.png', label: '交通' },
      { key: 'hotel', icon: '/images/icons/category-hotel.png', label: '住宿' },
      { key: 'food', icon: '/images/icons/category-food.png', label: '餐饮' },
      { key: 'tickets', icon: '/images/icons/category-tickets.png', label: '门票' },
      { key: 'shopping', icon: '/images/icons/category-shopping.png', label: '购物' },
      { key: 'other', icon: '/images/icons/category-other.png', label: '其他' }
    ]
  },

  onLoad(options) {
    if (options.tripId) {
      this.setData({ isEdit: true, tripId: options.tripId });
      this.loadTrip(options.tripId);
      return;
    }
    this.loadTemplates();
    if (options.copyFromTripId) this.loadHistorySource(options.copyFromTripId);
    else if (options.templateId) this.applyTemplate(options.templateId);
  },

  onShow() {
    theme.applyToPage(this);
  },

  async loadTemplates() {
    this.setData({ templatesLoading: true });
    try {
      const templates = await cloud.getTripTemplates();
      this.setData({ templates });
    } catch (error) {
      console.warn('加载行程模板失败:', error);
    }
    this.setData({ templatesLoading: false });
  },

  async loadHistorySource(tripId) {
    try {
      const { trip } = await cloud.getTripSnapshot(tripId, ['trip']);
      if (!trip) throw new Error('历史行程不存在');
      this.setData({
        sourceTripId: tripId,
        templateId: '',
        sourceLabel: `复用历史行程「${trip.name}」`,
        reusableDays: Number(trip.totalDays) || 1,
        name: `${trip.name} · 新行程`.slice(0, 30),
        city: trip.city || '',
        startDate: '',
        endDate: '',
        totalBudget: '',
        categoryBudgets: { transport: '', hotel: '', food: '', tickets: '', shopping: '', other: '' }
      });
    } catch (error) {
      wx.showToast({ title: error.message || '读取历史行程失败', icon: 'none' });
    }
  },

  async applyTemplate(templateId) {
    try {
      const template = await cloud.getTripTemplate(templateId);
      if (!template) throw new Error('模板不存在');
      const cleanName = String(template.name || '新行程').replace(/模板$/, '').trim();
      this.setData({
        sourceTripId: '',
        templateId,
        sourceLabel: `使用模板「${template.name || '未命名模板'}」`,
        reusableDays: Number(template.totalDays) || 1,
        name: cleanName.slice(0, 30),
        city: template.city || '',
        startDate: '',
        endDate: ''
      });
    } catch (error) {
      wx.showToast({ title: error.message || '读取模板失败', icon: 'none' });
    }
  },

  onTemplateTap(e) {
    const { id } = e.currentTarget.dataset;
    if (!id || id === this.data.templateId) return;
    this.applyTemplate(id);
  },

  onTemplateLongPress(e) {
    const { id } = e.currentTarget.dataset;
    const template = this.data.templates.find(item => item._id === id);
    if (!template) return;
    wx.showModal({
      title: '删除模板',
      content: `确定删除「${template.name}」吗？`,
      confirmText: '删除',
      confirmColor: '#ef4444',
      success: async res => {
        if (!res.confirm) return;
        try {
          await cloud.deleteTripTemplate(id);
          const templates = this.data.templates.filter(item => item._id !== id);
          const clearSelected = this.data.templateId === id;
          this.setData({
            templates,
            ...(clearSelected ? { templateId: '', sourceLabel: '', reusableDays: 0 } : {})
          });
          wx.showToast({ title: '模板已删除', icon: 'none' });
        } catch (error) {
          wx.showToast({ title: error.message || '删除失败', icon: 'none' });
        }
      }
    });
  },

  onClearSource() {
    this.setData({ sourceTripId: '', templateId: '', sourceLabel: '', reusableDays: 0 });
  },

  async loadTrip(tripId) {
    const { trip: t } = await cloud.getTripSnapshot(tripId, ['trip']);
    if (t) {
      this.setData({
        name: t.name || '',
        city: t.city || '',
        startDate: t.startDate || '',
        endDate: t.endDate || '',
        totalBudget: t.totalBudget ? String(t.totalBudget) : '',
        categoryBudgets: t.categoryBudgets || this.data.categoryBudgets
      });
    }
  },

  onNameInput(e) { this.setData({ name: e.detail.value }); },
  onNameFocus() { this.setData({ nameFocus: true }); },
  onNameBlur() { this.setData({ nameFocus: false }); },
  onCityInput(e) { this.setData({ city: e.detail.value }); },
  onCityFocus() { this.setData({ cityFocus: true }); },
  onCityBlur() { this.setData({ cityFocus: false }); },
  onBudgetInput(e) { this.setData({ totalBudget: e.detail.value }); },
  onBudgetFocus() { this.setData({ budgetFocus: true }); },
  onBudgetBlur() { this.setData({ budgetFocus: false }); },

  onStartDateChange(e) {
    const startDate = e.detail.value;
    const update = { startDate };
    if (this.data.reusableDays > 0) update.endDate = addDays(startDate, this.data.reusableDays - 1);
    this.setData(update);
  },
  onEndDateChange(e) {
    this.setData({ endDate: e.detail.value });
  },

  onCatBudgetInput(e) {
    const { cat } = e.currentTarget.dataset;
    const cb = { ...this.data.categoryBudgets };
    cb[cat] = e.detail.value;
    this.setData({ categoryBudgets: cb });
  },

  toggleCategoryBudget() {
    this.setData({ showCategoryBudget: !this.data.showCategoryBudget });
  },

  async onSave() {
    const { name, city, startDate, endDate, totalBudget, categoryBudgets } = this.data;
    if (!name.trim()) return wx.showToast({ title: '请输入行程名称', icon: 'none' });
    if (!city.trim()) return wx.showToast({ title: '请输入目的地', icon: 'none' });
    if (!startDate || !endDate) return wx.showToast({ title: '请选择日期', icon: 'none' });
    if (startDate > endDate) return wx.showToast({ title: '开始日期不能晚于结束日期', icon: 'none' });

    this.setData({ saving: true });

    const totalDays = cloud.daysBetween(startDate, endDate);

    const tripData = {
      name: name.trim(),
      city: city.trim(),
      startDate,
      endDate,
      totalDays,
      totalBudget: Number(totalBudget) || 0,
      categoryBudgets: categoryBudgets,
      updatedAt: new Date().toISOString()
    };

    try {
      if (this.data.isEdit) {
        await cloud.updateTrip(this.data.tripId, tripData);
      } else if (this.data.sourceTripId || this.data.templateId) {
        await cloud.createTripFromSource(tripData, {
          sourceTripId: this.data.sourceTripId,
          templateId: this.data.templateId
        });
      } else {
        await cloud.createTrip(tripData);
      }

      wx.showToast({ title: this.data.isEdit ? '已更新' : '创建成功', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 1200);
    } catch (e) {
      console.error('保存失败:', e);
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
    this.setData({ saving: false });
  }
});
