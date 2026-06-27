const cloud = require('../../utils/cloud');
const drafts = require('../../utils/drafts');

const QUICK_PROMPTS = [
  { text: '帮我创建北京5日游', icon: '/images/icons/trip-plan.png' },
  { text: '周末两天适合去哪里？', icon: '/images/icons/location.png' },
  { text: '记账午餐花了180元', icon: '/images/icons/trip-ledger.png' },
  { text: '三亚下周天气怎么样？', icon: '/images/icons/date.png' }
];

function cleanInlineText(value) {
  return String(value || '').replace(/\*\*(.*?)\*\*/g, '$1').replace(/__(.*?)__/g, '$1').trim();
}

function formatAssistantText(text) {
  const blocks = [];
  let paragraph = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: 'paragraph', text: cleanInlineText(paragraph.join('\n')) });
    paragraph = [];
  };
  String(text || '').split(/\r?\n/).forEach(rawLine => {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      return;
    }
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    const numbered = line.match(/^(\d+)[.、]\s*(.+)$/);
    const bullet = line.match(/^[-*•]\s+(.+)$/);
    if (heading) {
      flushParagraph();
      blocks.push({ type: 'heading', text: cleanInlineText(heading[1]) });
    } else if (numbered) {
      flushParagraph();
      blocks.push({ type: 'numbered', marker: numbered[1], text: cleanInlineText(numbered[2]) });
    } else if (bullet) {
      flushParagraph();
      blocks.push({ type: 'bullet', text: cleanInlineText(bullet[1]) });
    } else {
      paragraph.push(line);
    }
  });
  flushParagraph();
  const normalized = blocks.length ? blocks : [{ type: 'paragraph', text: cleanInlineText(text) }];
  return normalized.map((block, index) => ({ ...block, id: `block_${index}` }));
}

function formatConversationTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const pad = number => String(number).padStart(2, '0');
  if (date.toDateString() === now.toDateString()) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function welcomeMessage() {
  const text = '你好，我是拾途 AI。\n\n想规划、记账、整理清单，或者只是问点事情，直接告诉我就好。';
  return { id: 'welcome', role: 'assistant', text, blocks: formatAssistantText(text), localOnly: true };
}

function hydrateMessage(message) {
  const normalized = {
    ...message,
    id: message.id || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  };
  if (normalized.role === 'assistant') normalized.blocks = formatAssistantText(normalized.text);
  return normalized;
}

Page({
  data: {
    messages: [],
    inputText: '',
    sending: false,
    scrollIntoView: '',
    quickPrompts: QUICK_PROMPTS,
    showPrompts: true,
    chatHistory: [],
    keyboardHeight: 0,
    conversationId: '',
    conversationTitle: '新的对话',
    conversations: [],
    filteredConversations: [],
    historyKeyword: '',
    historyVisible: false,
    historyLoading: false,
    conversationLoading: false
  },

  onLoad(options) {
    this._requestedConversationId = options && options.conversationId ? decodeURIComponent(options.conversationId) : '';
  },

  onShow() {
    if (this._initialized) return;
    this._initialized = true;
    this.initializeConversations();
  },

  onUnload() {
    if (this._revealTimer) clearTimeout(this._revealTimer);
    wx.hideKeyboard();
  },

  async initializeConversations() {
    this.setData({ conversationLoading: true });
    try {
      const conversations = await cloud.listAiConversations();
      const formatted = conversations.map(item => ({ ...item, displayTime: formatConversationTime(item.updatedAt) }));
      this.setData({ conversations: formatted, filteredConversations: formatted, conversationLoading: false });
      const requested = this._requestedConversationId && formatted.find(item => item._id === this._requestedConversationId);
      if (requested) await this.openConversationById(requested._id, false);
      else if (formatted.length) await this.openConversationById(formatted[0]._id, false);
      else this.startNewConversation(false);
    } catch (error) {
      this.setData({ conversationLoading: false });
      this.startNewConversation(false);
      wx.showToast({ title: error.message || '历史对话加载失败', icon: 'none' });
    }
  },

  async refreshConversationList() {
    try {
      const conversations = await cloud.listAiConversations();
      this.setData({
        conversations: conversations.map(item => ({ ...item, displayTime: formatConversationTime(item.updatedAt) }))
      }, () => this.applyHistorySearch());
    } catch (_) {
      // 当前聊天不依赖列表刷新结果。
    }
  },

  rebuildChatHistory(messages) {
    return (messages || [])
      .filter(item => !item.localOnly && ['user', 'assistant'].includes(item.role) && item.text)
      .slice(-20)
      .map(item => ({ role: item.role, content: item.text }));
  },

  async openConversationById(conversationId, closeSheet = true) {
    if (!conversationId || this.data.conversationLoading) return;
    this.setData({ conversationLoading: true });
    try {
      const conversation = await cloud.getAiConversation(conversationId);
      if (!conversation) throw new Error('对话不存在或已删除');
      const messages = (conversation.messages || []).map(hydrateMessage);
      this.setData({
        conversationId: conversation._id,
        conversationTitle: conversation.title || '新的对话',
        messages: messages.length ? messages : [welcomeMessage()],
        chatHistory: this.rebuildChatHistory(messages),
        showPrompts: !messages.length,
        historyVisible: closeSheet ? false : this.data.historyVisible,
        inputText: (drafts.getDraft('ai-chat', conversation._id) || {}).text || ''
      }, () => this.revealLatestMessage(80));
    } catch (error) {
      wx.showToast({ title: error.message || '对话加载失败', icon: 'none' });
      await this.refreshConversationList();
    } finally {
      this.setData({ conversationLoading: false });
    }
  },

  onOpenConversation(e) {
    this.openConversationById(e.currentTarget.dataset.id);
  },

  onHistorySearch(e) {
    this.setData({ historyKeyword: e.detail.value }, () => this.applyHistorySearch());
  },

  applyHistorySearch() {
    const keyword = String(this.data.historyKeyword || '').trim().toLowerCase();
    const filteredConversations = keyword
      ? this.data.conversations.filter(item => String(item.title || '').toLowerCase().includes(keyword) || String(item.preview || '').toLowerCase().includes(keyword))
      : this.data.conversations;
    this.setData({ filteredConversations });
  },

  async onManageConversation(e) {
    const conversationId = e.currentTarget.dataset.id;
    const item = this.data.conversations.find(conversation => conversation._id === conversationId);
    if (!item) return;
    const result = await new Promise(resolve => wx.showActionSheet({
      itemList: [item.pinned ? '取消置顶' : '置顶对话', '重命名', '删除对话'],
      success: resolve,
      fail: () => resolve(null)
    }));
    if (!result) return;
    if (result.tapIndex === 0) {
      try {
        await cloud.updateAiConversation(conversationId, { pinned: !item.pinned });
        await this.refreshConversationList();
      } catch (error) {
        wx.showToast({ title: error.message || '操作失败', icon: 'none' });
      }
    } else if (result.tapIndex === 1) {
      const modal = await new Promise(resolve => wx.showModal({
        title: '重命名对话',
        editable: true,
        placeholderText: '输入新的名称',
        content: item.title || '',
        success: resolve,
        fail: () => resolve({ confirm: false })
      }));
      const title = String(modal.content || '').trim();
      if (!modal.confirm || !title) return;
      try {
        await cloud.updateAiConversation(conversationId, { title });
        if (conversationId === this.data.conversationId) this.setData({ conversationTitle: title });
        await this.refreshConversationList();
      } catch (error) {
        wx.showToast({ title: error.message || '重命名失败', icon: 'none' });
      }
    } else {
      this.onDeleteConversation({ currentTarget: { dataset: { id: conversationId } } });
    }
  },

  startNewConversation(closeSheet = true) {
    wx.hideKeyboard();
    const savedDraft = drafts.getDraft('ai-chat', 'new');
    this.setData({
      conversationId: '',
      conversationTitle: '新的对话',
      messages: [welcomeMessage()],
      chatHistory: [],
      showPrompts: true,
      inputText: (savedDraft && savedDraft.text) || '',
      sending: false,
      historyVisible: closeSheet ? false : this.data.historyVisible
    }, () => this.revealLatestMessage(60));
  },

  onNewConversation() {
    this.startNewConversation(true);
  },

  async onDeleteConversation(e) {
    const conversationId = e.currentTarget.dataset.id;
    if (!conversationId) return;
    const confirmed = await new Promise(resolve => {
      wx.showModal({
        title: '删除对话',
        content: '删除后无法恢复，确定继续吗？',
        confirmText: '删除',
        confirmColor: '#e05252',
        success: result => resolve(result.confirm),
        fail: () => resolve(false)
      });
    });
    if (!confirmed) return;
    try {
      await cloud.deleteAiConversation(conversationId);
      const wasCurrent = conversationId === this.data.conversationId;
      await this.refreshConversationList();
      if (wasCurrent) {
        const next = this.data.conversations[0];
        if (next) await this.openConversationById(next._id, false);
        else this.startNewConversation(false);
      }
    } catch (error) {
      wx.showToast({ title: error.message || '删除失败', icon: 'none' });
    }
  },

  openHistory() {
    wx.hideKeyboard();
    this.setData({ historyVisible: true, keyboardHeight: 0, historyLoading: true });
    this.refreshConversationList().finally(() => this.setData({ historyLoading: false }));
  },

  closeHistory() {
    this.setData({ historyVisible: false });
  },

  stopPropagation() {},

  onKeyboardHeightChange(e) {
    this.applyKeyboardHeight(e.detail.height || 0);
  },

  applyKeyboardHeight(height) {
    if (height === this.data.keyboardHeight) return;
    this.setData({ keyboardHeight: height }, () => this.revealLatestMessage(height > 0 ? 320 : 220));
  },

  onInputFocus() {
    this.revealLatestMessage(260);
  },

  revealLatestMessage(delay = 120) {
    if (this.data.messages.length === 0) return;
    if (this._revealTimer) clearTimeout(this._revealTimer);
    this._revealTimer = setTimeout(() => {
      this.setData({ scrollIntoView: '' }, () => {
        wx.nextTick(() => this.setData({ scrollIntoView: 'ai-chat-bottom' }));
      });
    }, delay);
  },

  onInput(e) {
    const inputText = e.detail.value;
    this.setData({ inputText });
    drafts.saveDraft('ai-chat', this.data.conversationId || 'new', { text: inputText });
  },

  appendMessage(role, text, actions, id = '') {
    const messageId = id || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const msg = { id: messageId, role, text };
    if (role === 'assistant') msg.blocks = formatAssistantText(text);
    if (actions && actions.length) msg.actions = actions;
    this.setData({ messages: [...this.data.messages, msg], showPrompts: false }, () => this.revealLatestMessage());
    return messageId;
  },

  onQuickPrompt(e) {
    this.setData({ inputText: e.currentTarget.dataset.text }, () => this.onSend());
  },

  async onConfirmAction(e) {
    const { messageId, actionId } = e.currentTarget.dataset;
    const messageIndex = this.data.messages.findIndex(item => item.id === messageId);
    if (messageIndex < 0) return;
    const actions = this.data.messages[messageIndex].actions || [];
    const actionIndex = actions.findIndex(item => item.id === actionId);
    if (actionIndex < 0 || actions[actionIndex].status !== 'pending') return;
    const action = actions[actionIndex];
    const statusPath = `messages[${messageIndex}].actions[${actionIndex}].status`;
    const resultPath = `messages[${messageIndex}].actions[${actionIndex}].result`;
    this.setData({ [statusPath]: 'running' });
    try {
      const result = await cloud.confirmAiAction(action.tool, action.args || {}, {
        conversationId: this.data.conversationId,
        messageId,
        actionId
      });
      this.setData({
        [statusPath]: result.ok ? 'done' : 'failed',
        [resultPath]: result
      }, () => this.revealLatestMessage(80));
      if (result.ok) {
        const text = result.msg || '操作已完成';
        this.appendMessage('assistant', text, null, result.assistantMessage && result.assistantMessage.id);
        this.setData({ chatHistory: [...this.data.chatHistory, { role: 'assistant', content: text }].slice(-20) });
        this.refreshConversationList();
      }
    } catch (error) {
      this.setData({
        [statusPath]: 'failed',
        [resultPath]: { ok: false, msg: error.message || '执行失败，请重试' }
      });
    }
  },

  async onCancelAction(e) {
    const { messageId, actionId } = e.currentTarget.dataset;
    const messageIndex = this.data.messages.findIndex(item => item.id === messageId);
    if (messageIndex < 0) return;
    const actions = this.data.messages[messageIndex].actions || [];
    const actionIndex = actions.findIndex(item => item.id === actionId);
    if (actionIndex < 0 || actions[actionIndex].status !== 'pending') return;
    const path = `messages[${messageIndex}].actions[${actionIndex}].status`;
    this.setData({ [path]: 'cancelled' });
    try {
      if (this.data.conversationId) {
        await cloud.updateAiConversationAction(this.data.conversationId, messageId, actionId, 'cancelled');
      }
      this.refreshConversationList();
    } catch (error) {
      this.setData({ [path]: 'pending' });
      wx.showToast({ title: error.message || '取消失败', icon: 'none' });
    }
  },

  async onSend() {
    const text = (this.data.inputText || '').trim();
    if (!text || this.data.sending) return;
    const localUserMessageId = this.appendMessage('user', text);
    this.setData({ inputText: '', sending: true }, () => this.revealLatestMessage(80));
    drafts.clearDraft('ai-chat', this.data.conversationId || 'new');
    try {
      const history = this.data.chatHistory.slice(-16);
      const result = await cloud.aiChat(text, history, this.data.conversationId);
      const newHistory = [
        ...history,
        { role: 'user', content: text },
        { role: 'assistant', content: result.text }
      ];
      const userIndex = this.data.messages.findIndex(item => item.id === localUserMessageId);
      const update = {
        chatHistory: newHistory.slice(-20),
        sending: false,
        conversationId: result.conversationId || this.data.conversationId,
        conversationTitle: result.title || this.data.conversationTitle
      };
      if (userIndex >= 0 && result.userMessage && result.userMessage.id) {
        update[`messages[${userIndex}].id`] = result.userMessage.id;
      }
      this.setData(update);
      this.appendMessage('assistant', result.text, result.actions, result.assistantMessage && result.assistantMessage.id);
      this.refreshConversationList();
    } catch (error) {
      this.appendMessage('assistant', error.message || '出错了，请重试');
      this.setData({ sending: false, inputText: text });
      drafts.saveDraft('ai-chat', this.data.conversationId || 'new', { text });
    }
  }
});
