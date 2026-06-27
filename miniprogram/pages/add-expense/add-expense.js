const cloud = require('../../utils/cloud');

const recorderManager = wx.getRecorderManager();

const CATEGORIES = [
  { key: 'transport', icon: '/images/icons/category-transport.png', label: '交通' },
  { key: 'hotel', icon: '/images/icons/category-hotel.png', label: '住宿' },
  { key: 'food', icon: '/images/icons/category-food.png', label: '餐饮' },
  { key: 'tickets', icon: '/images/icons/category-tickets.png', label: '门票' },
  { key: 'shopping', icon: '/images/icons/category-shopping.png', label: '购物' },
  { key: 'other', icon: '/images/icons/category-other.png', label: '其他' }
];

const TEMPLATES = [
  { key: 'taxi', category: 'transport', amount: 30, description: '打车', type: 'shared', icon: '/images/icons/category-transport.png', label: '打车 ¥30' },
  { key: 'lunch', category: 'food', amount: 50, description: '午餐', type: 'shared', icon: '/images/icons/category-food.png', label: '午餐 ¥50' },
  { key: 'dinner', category: 'food', amount: 100, description: '晚餐', type: 'shared', icon: '/images/icons/category-food.png', label: '晚餐 ¥100' },
  { key: 'ticket', category: 'tickets', amount: 60, description: '门票', type: 'shared', icon: '/images/icons/category-tickets.png', label: '门票 ¥60' },
  { key: 'hotel_tpl', category: 'hotel', amount: 300, description: '住宿', type: 'shared', icon: '/images/icons/category-hotel.png', label: '住宿 ¥300' },
  { key: 'coffee', category: 'food', amount: 25, description: '咖啡', type: 'private', icon: '/images/icons/category-food.png', label: '咖啡 ¥25' },
  { key: 'snack', category: 'food', amount: 15, description: '零食', type: 'private', icon: '/images/icons/category-food.png', label: '零食 ¥15' },
  { key: 'souvenir', category: 'shopping', amount: 80, description: '纪念品', type: 'private', icon: '/images/icons/category-shopping.png', label: '纪念品 ¥80' }
];

Page({
  data: {
    tripId: '',
    expenseId: '',
    editMode: false,
    members: [],
    splitMembers: [],
    categories: CATEGORIES,
    templates: TEMPLATES,
    showTemplates: false,
    type: 'shared',
    category: 'food',
    amount: '',
    description: '',
    paidBy: '',
    paidByIndex: 0,
    payerDisplayName: '选择付款人',
    splitAmong: [],
    splitSummaryText: '',
    splitAverageText: '',
    myOpenid: '',
    saving: false,

    // 票据拍照
    receiptPhoto: '',
    receiptFileId: '',

    // 语音备注
    voiceFileId: '',
    voiceDuration: 0,
    recording: false,
    _recordingTimer: null,

    // 预算预警
    tripBudget: 0,
    currentSpent: 0,
    budgetPercent: 0
  },

  onLoad(options) {
    const tripId = options.tripId;
    const expenseId = options.expenseId || '';
    const members = options.members ? JSON.parse(decodeURIComponent(options.members)) : [];
    this.setData({ expenseId, editMode: !!expenseId });
    this.initMembers(tripId, members);
    this.loadMembers(tripId).then(() => {
      if (expenseId) this.loadExpenseForEdit(tripId, expenseId);
    });
    this.loadBudget(tripId);
    this.loadRecentTemplates();
    this.setupRecorder();
  },

  initMembers(tripId, rawMembers = [], openid = '') {
    const members = this.normalizeMembers(rawMembers);
    const currentOpenid = openid || this.data.myOpenid || '';
    const paidByIndex = Math.max(0, members.findIndex(m => currentOpenid && m.openid === currentOpenid));
    const payer = members[paidByIndex];
    const splitAmong = this.data.type === 'shared' ? members.map(m => m.openid).filter(Boolean) : [];
    this.setData({
      tripId,
      members,
      myOpenid: currentOpenid,
      paidBy: payer ? payer.openid : currentOpenid,
      paidByIndex,
      payerDisplayName: payer ? (payer.nickName || '未命名') : '选择付款人'
    }, () => this.setSplitAmong(splitAmong));
  },

  normalizeMembers(rawMembers = []) {
    const seen = new Set();
    return (Array.isArray(rawMembers) ? rawMembers : [])
      .filter(member => member && member.openid && !seen.has(member.openid) && seen.add(member.openid))
      .map(member => ({
        ...member,
        nickName: member.nickName || '未命名'
      }));
  },

  setSplitAmong(splitAmong = []) {
    const validIds = new Set(this.data.members.map(member => member.openid).filter(Boolean));
    const normalized = [...new Set((Array.isArray(splitAmong) ? splitAmong : [])
      .filter(openid => validIds.has(openid)))];
    const selectedSet = new Set(normalized);
    const amount = Number(this.data.amount) || 0;
    const average = normalized.length ? Math.round(amount / normalized.length * 100) / 100 : 0;
    this.setData({
      splitAmong: normalized,
      splitMembers: this.data.members.map(member => ({
        ...member,
        selected: selectedSet.has(member.openid)
      })),
      splitSummaryText: `已选 ${normalized.length}/${this.data.members.length} 人`,
      splitAverageText: normalized.length && amount > 0 ? `人均约 ¥${average.toFixed(2)}` : ''
    });
  },

  setupRecorder() {
    recorderManager.onStop((res) => {
      clearInterval(this.data._recordingTimer);
      this.setData({ recording: false });
      if (!res.tempFilePath) return;
      this.uploadVoice(res.tempFilePath, Math.ceil(res.duration / 1000));
    });
    recorderManager.onError(() => {
      clearInterval(this.data._recordingTimer);
      this.setData({ recording: false });
      wx.showToast({ title: '录音失败', icon: 'none' });
    });
  },

  async uploadVoice(filePath, duration) {
    try {
      wx.showLoading({ title: '上传语音...' });
      const fileId = await cloud.uploadFile(filePath, 'mp3', 'voice-notes');
      wx.hideLoading();
      this.setData({ voiceFileId: fileId, voiceDuration: duration });
      wx.showToast({ title: '语音已添加', icon: 'success' });
    } catch (e) {
      wx.hideLoading();
      console.warn('语音上传失败:', e);
    }
  },

  async loadMembers(tripId) {
    try {
      const openid = await cloud.getOpenid();
      const { members } = await cloud.getTripSnapshot(tripId, ['members']);
      this.initMembers(tripId, members, openid);
    } catch (e) {
      console.warn('加载成员失败:', e);
    }
  },

  async loadExpenseForEdit(tripId, expenseId) {
    try {
      wx.showLoading({ title: '加载账单...' });
      const snapshot = await cloud.getTripSnapshot(tripId, ['members', 'expenses']);
      const members = this.normalizeMembers(snapshot.members || []);
      const expense = (snapshot.expenses || []).find(item => item._id === expenseId);
      if (!expense) throw new Error('账单不存在');
      if (expense.settled) {
        wx.showToast({ title: '已结算账单不能编辑', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 800);
        return;
      }
      const paidByIndex = Math.max(0, members.findIndex(member => member.openid === expense.paidBy));
      const payer = members[paidByIndex];
      let receiptPhoto = '';
      if (expense.receiptFileId) {
        try { receiptPhoto = await cloud.getTempFileUrl(expense.receiptFileId); } catch (_) {}
      }
      this.setData({
        members,
        type: expense.type || 'shared',
        category: expense.category || 'other',
        amount: String(expense.amount || ''),
        description: expense.description || '',
        paidBy: expense.paidBy || '',
        paidByIndex,
        payerDisplayName: payer ? (payer.nickName || '未命名') : (expense.paidByName || '选择付款人'),
        receiptFileId: expense.receiptFileId || '',
        receiptPhoto,
        voiceFileId: expense.voiceFileId || '',
        voiceDuration: expense.voiceDuration || 0
      }, () => this.setSplitAmong(expense.type === 'shared' ? (expense.splitAmong || []) : []));
    } catch (e) {
      console.error('加载账单失败:', e);
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  async loadBudget(tripId) {
    try {
      const { trip, expenses } = await cloud.getTripSnapshot(tripId, ['trip', 'expenses']);
      const totalBudget = trip.totalBudget || 0;
      const currentSpent = (expenses || []).reduce((sum, e) => sum + (e.amount || 0), 0);
      this.setData({
        tripBudget: totalBudget,
        currentSpent,
        budgetPercent: totalBudget > 0 ? Math.round(currentSpent / totalBudget * 100) : 0
      });
    } catch (e) { /* 非关键 */ }
  },

  loadRecentTemplates() {
    try {
      const recent = wx.getStorageSync('_recentExpenseTemplates') || [];
      if (recent.length > 0) {
        const recentTemplates = recent.map((tpl, i) => ({
          ...tpl,
          key: 'recent_' + i,
          icon: cloud.categoryIcon(tpl.category),
          label: (tpl.description || tpl.category) + ' ¥' + tpl.amount
        }));
        this.setData({ templates: [...recentTemplates, ...TEMPLATES] });
      }
    } catch (_) {}
  },

  saveRecentTemplate(expense) {
    try {
      const recent = wx.getStorageSync('_recentExpenseTemplates') || [];
      const entry = { category: expense.category, amount: expense.amount, description: expense.description, type: expense.type };
      const filtered = recent.filter(t => !(t.category === entry.category && t.amount === entry.amount && t.description === entry.description));
      filtered.unshift(entry);
      wx.setStorageSync('_recentExpenseTemplates', filtered.slice(0, 3));
    } catch (_) {}
  },

  onToggleTemplates() {
    this.setData({ showTemplates: !this.data.showTemplates });
  },

  onApplyTemplate(e) {
    const tpl = e.currentTarget.dataset.template;
    this.setData({
      category: tpl.category,
      amount: String(tpl.amount),
      description: tpl.description,
      type: tpl.type,
      showTemplates: false
    }, () => {
      if (tpl.type === 'shared' && this.data.splitAmong.length === 0) {
        this.setSplitAmong(this.data.members.map(member => member.openid).filter(Boolean));
      } else {
        this.setSplitAmong(tpl.type === 'shared' ? this.data.splitAmong : []);
      }
    });
  },

  onTypeTap(e) {
    const type = e.currentTarget.dataset.type;
    this.setData({ type }, () => {
      if (type === 'shared' && this.data.splitAmong.length === 0) {
        this.setSplitAmong(this.data.members.map(member => member.openid).filter(Boolean));
      } else if (type === 'private') {
        this.setSplitAmong([]);
      }
    });
  },
  onCategoryTap(e) { this.setData({ category: e.currentTarget.dataset.cat }); },
  onAmountInput(e) {
    this.setData({ amount: e.detail.value }, () => this.setSplitAmong(this.data.splitAmong));
  },
  onDescInput(e) { this.setData({ description: e.detail.value }); },

  onQuickAmount(e) {
    const add = Number(e.currentTarget.dataset.amount) || 0;
    const current = parseFloat(this.data.amount) || 0;
    const result = Math.round((current + add) * 100) / 100;
    this.setData({ amount: String(result) }, () => this.setSplitAmong(this.data.splitAmong));
  },

  onClearAmount() {
    this.setData({ amount: '' }, () => this.setSplitAmong(this.data.splitAmong));
  },

  onPickPayer() {
    const { members } = this.data;
    if (!members.length) {
      return wx.showToast({ title: '暂无成员', icon: 'none' });
    }
    const names = members.map(m => m.nickName || '未命名');
    wx.showActionSheet({
      itemList: names,
      success: (res) => {
        const idx = res.tapIndex;
        const member = members[idx];
        if (member) {
          this.setData({
            paidBy: member.openid,
            paidByIndex: idx,
            payerDisplayName: member.nickName || '未命名'
          });
        }
      }
    });
  },

  onSplitToggle(e) {
    const openid = e.currentTarget.dataset.openid;
    if (!openid) return;
    let split = [...this.data.splitAmong];
    const idx = split.indexOf(openid);
    if (idx > -1) {
      split.splice(idx, 1);
    } else {
      split.push(openid);
    }
    this.setSplitAmong(split);
  },

  onSelectAllSplit() {
    this.setSplitAmong(this.data.members.map(member => member.openid).filter(Boolean));
  },

  onClearSplit() {
    this.setSplitAmong([]);
  },

  onSelectSelfSplit() {
    if (!this.data.myOpenid) return;
    this.setSplitAmong([this.data.myOpenid]);
  },

  onAddReceipt() {
    wx.chooseImage({
      count: 1,
      sizeType: ['original'],
      sourceType: ['camera', 'album'],
      success: async (res) => {
        const tempPath = res.tempFilePaths[0];
        this.setData({ receiptPhoto: tempPath });
        try {
          wx.showLoading({ title: '上传票据...' });
          const fileId = await cloud.uploadImage(tempPath, 'receipts');
          wx.hideLoading();
          this.setData({ receiptFileId: fileId });
        } catch (e) {
          wx.hideLoading();
          console.warn('票据上传失败:', e);
        }
      }
    });
  },

  onRemoveReceipt() {
    this.setData({ receiptPhoto: '', receiptFileId: '' });
  },

  onToggleVoice() {
    if (this.data.recording) {
      recorderManager.stop();
      clearInterval(this.data._recordingTimer);
      this.setData({ recording: false });
    } else {
      if (this.data.voiceFileId) {
        // 已有语音，删除
        this.setData({ voiceFileId: '', voiceDuration: 0 });
        return;
      }
      recorderManager.start({ format: 'mp3', duration: 60000 });
      this.setData({ recording: true });
      let sec = 0;
      this.data._recordingTimer = setInterval(() => {
        sec++;
        this.setData({ voiceDuration: sec });
      }, 1000);
    }
  },

  onRemoveVoice() {
    this.setData({ voiceFileId: '', voiceDuration: 0 });
  },

  async onSave() {
    if (this.data.saving) return;
    const { tripId, type, category, amount, description, paidBy, splitAmong, receiptFileId, voiceFileId, voiceDuration } = this.data;
    if (!amount || Number(amount) <= 0) return wx.showToast({ title: '请输入金额', icon: 'none' });
    if (!description.trim() && !voiceFileId) return wx.showToast({ title: '请输入描述或录制语音', icon: 'none' });
    if (type === 'shared' && splitAmong.length === 0) {
      return wx.showToast({ title: '请选择分摊人', icon: 'none' });
    }

    // 超预算二次确认
    if (this.data.tripBudget > 0) {
      const newTotal = this.data.currentSpent + Number(amount);
      if (newTotal > this.data.tripBudget) {
        const over = newTotal - this.data.tripBudget;
        const confirmed = await new Promise(resolve => {
          wx.showModal({
            title: '超预算提醒',
            content: `总消费将超过预算 ¥${this.data.tripBudget}\n当前已花 ¥${this.data.currentSpent}\n本次 ¥${amount} → 合计 ¥${newTotal}\n超出 ¥${over.toFixed(2)}\n是否继续记账？`,
            confirmText: '继续记账',
            cancelText: '返回修改',
            success: (r) => resolve(r.confirm)
          });
        });
        if (!confirmed) return;
      }
    }

    const payer = this.data.members.find(m => m.openid === paidBy);

    const expense = {
      tripId,
      type,
      category,
      amount: Number(amount),
      description: description.trim() || '语音记账',
      paidBy: paidBy || '',
      paidByName: payer ? payer.nickName : '未知',
      splitAmong: type === 'shared' ? splitAmong : [],
      receiptFileId: receiptFileId || '',
      voiceFileId: voiceFileId || '',
      voiceDuration: voiceDuration || 0,
      createdAt: new Date().toISOString()
    };

    this.setData({ saving: true });
    try {
      if (this.data.editMode) {
        await cloud.updateExpense(this.data.expenseId, expense);
      } else {
        await cloud.addExpense(expense);
        this.saveRecentTemplate(expense);
      }
      wx.showToast({ title: this.data.editMode ? '已保存' : '记账成功', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 1000);
    } catch (e) {
      console.error('保存失败:', e);
      wx.showToast({ title: '保存失败', icon: 'none' });
      this.setData({ saving: false });
    }
  }
});
