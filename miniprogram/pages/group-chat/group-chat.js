const cloud = require('../../utils/cloud');
const drafts = require('../../utils/drafts');
const theme = require('../../utils/theme');
const recorderManager = wx.getRecorderManager();

const SUPPORTED_DOCUMENT_TYPES = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf']);
const EMOJI_LIST = ['😀', '😄', '😂', '🥰', '😍', '😘', '😊', '🥹', '😎', '🤔', '😴', '😭', '😤', '👍', '👏', '🙌', '🤝', '💪', '❤️', '💕', '🎉', '✨', '🌈', '✈️'];

function fileExtension(fileName) {
  const parts = String(fileName || '').toLowerCase().split('.');
  return parts.length > 1 ? parts.pop().replace(/[^a-z0-9]/g, '') : '';
}

function normalizePickedFile(file = {}) {
  const filePath = file.path || file.tempFilePath || '';
  let fallbackName = '';
  try { fallbackName = decodeURIComponent(String(filePath).split('/').pop().split('?')[0]); } catch (_) {}
  let fileName = String(file.name || fallbackName || '文件').trim();
  const extension = fileExtension(fileName) || fileExtension(filePath);
  if (extension && !fileExtension(fileName)) fileName = `${fileName}.${extension}`;
  return { filePath, fileName, extension, fileSize: Math.max(0, Number(file.size) || 0) };
}

function fileSendError(error) {
  const message = String(error && (error.message || error.errMsg) || '');
  if (/cancel/i.test(message)) return '';
  if (/size|exceed|too large|超出|过大/i.test(message)) return '文件不能超过 50MB';
  if (/uploadFile|上传/i.test(message)) return '文件上传失败，请检查网络后重试';
  return message || '文件发送失败';
}

function messagePreview(message) {
  if (!message) return '消息';
  if (message.type === 'image') return '[图片]';
  if (message.type === 'voice') return `[语音] ${message.voiceDuration || 1}秒`;
  if (message.type === 'location') return `[位置] ${message.locationName || ''}`;
  if (message.type === 'file') return `[文件] ${message.fileName || ''}`;
  if (message.type === 'user_card') return `[名片] ${message.cardName || ''}`;
  if (message.type === 'moment_share') return '[动态分享]';
  return String(message.text || '消息').slice(0, 100);
}

Page({
  data: {
    themeStyle: '',
    themeClass: 'theme-blue',
    groupId: '',
    group: {},
    messages: [],
    members: [],
    memberAvatars: [],
    groupAvatarStyle: '',
    myOpenid: '',
    myAvatarUrl: '',
    myNickName: '',
    inputText: '',
    canSend: false,
    loading: true,
    sending: false,
    scrollIntoView: '',
    scrollTop: 0,
    showTools: false,
    showEmoji: false,
    emojiList: EMOJI_LIST,
    voiceMode: false,
    recording: false,
    recordCanceling: false,
    recordingDuration: 0,
    sendingVoice: false,
    voicePlayingId: '',
    replyingTo: null,
    keyboardHeight: 0,
    chatListPaddingStyle: '',
    showMore: false,
    myRole: 'member',
    notificationsMuted: false
  },

  onLoad(options) {
    const groupId = decodeURIComponent(options.groupId || '');
    const name = decodeURIComponent(options.name || '群聊');
    this.setData({ groupId });
    const app = getApp();
    if (app && app.globalData) app.globalData._currentGroupId = groupId;
    const savedDraft = drafts.getDraft('group-chat', groupId);
    if (savedDraft && savedDraft.text) this.setData({ inputText: savedDraft.text, canSend: true });
    wx.setNavigationBarTitle({ title: name });
    this._bindRecorderEvents();
    wx.setInnerAudioOption({ obeyMuteSwitch: false });
    this.loadMessages(true);
    this._timeTimer = setInterval(() => this.refreshRelativeTimes(), 60000);
  },

  onShow() {
    theme.applyToPage(this);
    const app = getApp();
    if (app && app.globalData) app.globalData._currentGroupId = this.data.groupId;
    if (this.data.groupId && !this.data.loading) this.startWatch();
  },

  onHide() {
    const app = getApp();
    if (app && app.globalData && app.globalData._currentGroupId === this.data.groupId) app.globalData._currentGroupId = '';
    this.stopWatch();
    if (this._typingTimer) { clearTimeout(this._typingTimer); this._typingTimer = null; }
  },

  onUnload() {
    const app = getApp();
    if (app && app.globalData && app.globalData._currentGroupId === this.data.groupId) app.globalData._currentGroupId = '';
    if (this._timeTimer) clearInterval(this._timeTimer);
    this.stopWatch();
    this._cancelActiveRecording();
    this._unbindRecorderEvents();
    if (this._voiceAudio) {
      this._voiceAudio.stop();
      this._voiceAudio.destroy();
      this._voiceAudio = null;
    }
  },

  /* ══════ 消息加载 ══════ */
  async loadMessages(fullLoad = false) {
    if (!this.data.groupId) return;
    if (fullLoad) this.setData({ loading: true });
    try {
      const since = fullLoad ? '' : (this._lastMessageCreatedAt || '');
      const result = await cloud.getGroupMessages(this.data.groupId, since);

      if (!this.data.myOpenid) {
        this.data.myOpenid = await cloud.getOpenid();
      }
      const myOpenid = this.data.myOpenid;
      const app = getApp();
      const myInfo = (app.globalData && app.globalData.userInfo) || {};
      if (!this.data.myAvatarUrl) {
        this.setData({ myAvatarUrl: myInfo.avatarUrl || '', myNickName: myInfo.nickName || '' });
      }

      const rawMessages = (result.messages || []);
      const serverNow = new Date(result.serverNow || Date.now()).getTime();

      const newMessages = rawMessages.map(item => {
        const m = {
          ...item,
          isMine: item.from === myOpenid,
          formattedTime: cloud.formatDate(item.createdAt),
          canRecall: item.from === myOpenid && item.type !== 'revoked' &&
            serverNow - new Date(item.createdAt).getTime() <= 2 * 60 * 1000,
          voiceBubbleWidth: Math.min(360, 176 + Math.max(0, Number(item.voiceDuration || 1) - 1) * 4),
          quoteDisplayName: item.quoteSenderId === myOpenid ? '我' : (item.quoteSenderName || '群成员')
        };
        return m;
      });

      let messages;
      if (fullLoad) {
        messages = newMessages;
      } else {
        const existingIds = new Set(this.data.messages.map(m => m._id));
        const toAdd = newMessages.filter(m => !existingIds.has(m._id));
        if (toAdd.length === 0) {
          const group = result.group || {};
          if (group.name) wx.setNavigationBarTitle({ title: group.name });
          this.setData({ group, members: result.members || [] });
          return;
        }
        messages = [...this.data.messages, ...toAdd].sort((a, b) =>
          String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
      }

      // 解析发送者徽章 + 构建头像缓存
      const senderIds = [...new Set(messages.filter(m => !m.isMine).map(m => m.from))];
      if (senderIds.length > 0) {
        const newSenderIds = senderIds.filter(id => !(this._senderCache || {})[id]);
        if (newSenderIds.length > 0) {
          try {
            const userMap = await cloud.batchGetUsers(newSenderIds);
            this._senderCache = { ...(this._senderCache || {}), ...userMap };
          } catch (_) {}
        }
        const cache = this._senderCache || {};
        messages = messages.map(m => {
          if (m.isMine) return m;
          const sender = cache[m.from];
          if (!sender) return m;
          const extras = {};
          // 补充 senderName / senderAvatar（服务器已设，但缓存可能有更新）
          if (!m.senderAvatar && sender.avatarUrl) extras.senderAvatar = sender.avatarUrl;
          if (!m.senderName && sender.nickName) extras.senderName = sender.nickName;
          if (sender.wornBadge && (sender.showBadge === undefined || sender.showBadge)) {
            extras.senderBadgeIcon = cloud.getBadgeIcon(sender.wornBadge);
          }
          if (cloud.isOfficialByPublicId(sender.publicId)) {
            extras.senderVerified = true;
          }
          return Object.keys(extras).length ? { ...m, ...extras } : m;
        });
      }

      // 只对新消息解析云文件
      const toResolve = fullLoad ? messages : messages.filter(m => !this.data.messages.some(old => old._id === m._id));
      await cloud.resolveCloudFileFields(toResolve, ['senderAvatar', 'imageFileId', 'voiceFileId', 'cardAvatar', 'momentImage']);

      // 更新锚点
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg.createdAt) {
        this._lastMessageCreatedAt = lastMsg.createdAt;
      }

      const group = result.group || {};
      if (group.name) wx.setNavigationBarTitle({ title: group.name });

      // 给成员列表补上昵称头像（供更多面板展示）
      const members = (result.members || []).map(m => {
        const user = (this._senderCache || {})[m.openid];
        return {
          ...m,
          nickName: (user && user.nickName) || m.nickName || '',
          avatarUrl: (user && user.avatarUrl) || m.avatarUrl || ''
        };
      });

      this.setData({
        group,
        messages,
        members,
        myRole: result.myRole || 'member',
        notificationsMuted: !!result.myNotificationsMuted,
        loading: false
      }, () => {
        this.buildGroupAvatar();
        if (fullLoad) this.scrollToBottom();
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '群消息加载失败', icon: 'none' });
    }
  },

  /* ══════ 群头像 ══════ */
  buildGroupAvatar() {
    const members = this.data.members || [];
    const cache = this._senderCache || {};
    const maxCells = 9;
    const colors = ['#5b9ff5', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316', '#6366f1'];

    const avatars = members.slice(0, maxCells).map((member, i) => {
      const user = cache[member.openid];
      if (user && user.avatarUrl) {
        return { url: user.avatarUrl, initial: '', color: '' };
      }
      const name = (user && user.nickName) || '';
      return { url: '', initial: (name[0] || '?').toUpperCase(), color: colors[i % colors.length] };
    });

    let cols = 3;
    if (avatars.length <= 1) cols = 1;
    else if (avatars.length <= 4) cols = 2;

    this.setData({
      memberAvatars: avatars,
      groupAvatarStyle: `grid-template-columns: repeat(${cols}, 1fr); grid-template-rows: repeat(${cols}, 1fr);`
    });
  },

  /* ══════ 发送 ══════ */
  onInput(e) {
    const inputText = e.detail.value;
    this.setData({ inputText, canSend: !!inputText.trim() });
    drafts.saveDraft('group-chat', this.data.groupId, { text: inputText });
  },

  async onSend() {
    const text = this.data.inputText.trim();
    if (!text || this.data.sending) return;
    // 禁言检查（云函数也会校验，这里做前端提示）
    const myMembership = this.data.members.find(m => m.openid === this.data.myOpenid);
    if (myMembership && myMembership.muted) {
      return wx.showToast({ title: '你已被禁言', icon: 'none' });
    }
    const replyingTo = this.data.replyingTo;
    const tempId = `temp-${Date.now()}`;
    const optimistic = {
      _id: tempId,
      from: this.data.myOpenid,
      type: 'text',
      text,
      createdAt: new Date().toISOString(),
      formattedTime: '刚刚',
      isMine: true,
      canRecall: false
    };
    if (replyingTo) {
      optimistic.quoteMessageId = replyingTo.messageId;
      optimistic.quoteSenderId = replyingTo.senderId;
      optimistic.quoteSenderName = replyingTo.senderName;
      optimistic.quoteDisplayName = replyingTo.senderId === this.data.myOpenid ? '我' : replyingTo.senderName;
      optimistic.quoteText = replyingTo.text;
    }
    const messages = [...this.data.messages, optimistic];
    this.setData({
      sending: true, inputText: '', canSend: false, replyingTo: null,
      messages,
      scrollIntoView: `group-message-${messages.length - 1}`
    });
    drafts.clearDraft('group-chat', this.data.groupId);
    try {
      const quoteId = replyingTo ? replyingTo.messageId : '';
      const message = await cloud.sendGroupMessage(this.data.groupId, text, quoteId);
      const index = this.data.messages.findIndex(m => m._id === tempId);
      if (index >= 0) {
        this.setData({
          [`messages[${index}]`]: {
            ...message,
            formattedTime: cloud.formatDate(message.createdAt),
            isMine: true,
            canRecall: true,
            quoteDisplayName: message.quoteSenderId === this.data.myOpenid ? '我' : (message.quoteSenderName || '群成员')
          }
        });
        if (message.createdAt && message.createdAt > (this._lastMessageCreatedAt || '')) {
          this._lastMessageCreatedAt = message.createdAt;
        }
      }
    } catch (e) {
      this.setData({ messages: this.data.messages.filter(m => m._id !== tempId), inputText: text, canSend: true, replyingTo });
      drafts.saveDraft('group-chat', this.data.groupId, { text });
      wx.showToast({ title: e.message || '发送失败', icon: 'none' });
    }
    this.setData({ sending: false });
  },

  async sendRichMessage(type, data) {
    const replyingTo = this.data.replyingTo;
    const payload = { ...data };
    if (replyingTo) payload.quoteMessageId = replyingTo.messageId;
    const message = await cloud.sendRichGroupMessage(this.data.groupId, type, payload);
    await cloud.resolveCloudFileFields([message], ['imageFileId', 'voiceFileId', 'cardAvatar', 'momentImage']);
    this.appendOutgoingMessage(message);
  },

  appendOutgoingMessage(message) {
    const formatted = {
      ...message,
      isMine: true,
      formattedTime: cloud.formatDate(message.createdAt),
      canRecall: true,
      voiceBubbleWidth: Math.min(360, 176 + Math.max(0, Number(message.voiceDuration || 1) - 1) * 4),
      quoteDisplayName: message.quoteSenderId === this.data.myOpenid ? '我' : (message.quoteSenderName || '群成员')
    };
    const messages = [...this.data.messages, formatted];
    if (message.createdAt && message.createdAt > (this._lastMessageCreatedAt || '')) {
      this._lastMessageCreatedAt = message.createdAt;
    }
    this.setData({
      messages,
      showTools: false,
      showEmoji: false,
      replyingTo: null,
      scrollIntoView: `group-message-${messages.length - 1}`
    });
  },

  /* ══════ 实时监听 ══════ */
  async startWatch() {
    this.stopWatch();
    if (!this.data.sending) this.loadMessages(false);
    try {
      this._messageWatcher = await cloud.watchGroupMessages(this.data.groupId, {
        onChange: () => {
          if (!this.data.sending) this.loadMessages(false);
        },
        onError: err => {
          console.warn('群聊监听中断:', err);
          this.stopWatch();
        }
      });
    } catch (e) {
      console.warn('群聊监听不可用:', e);
    }
  },

  stopWatch() {
    if (this._messageWatcher) {
      try { this._messageWatcher.close(); } catch (_) {}
      this._messageWatcher = null;
    }
  },

  /* ══════ 时间刷新 ══════ */
  refreshRelativeTimes() {
    const now = Date.now();
    const updates = {};
    this.data.messages.forEach((m, i) => {
      const newTime = cloud.formatDate(m.createdAt);
      const newRecall = m.isMine && m.type !== 'revoked' &&
        now - new Date(m.createdAt).getTime() <= 2 * 60 * 1000;
      if (m.formattedTime !== newTime) updates[`messages[${i}].formattedTime`] = newTime;
      if (m.canRecall !== newRecall) updates[`messages[${i}].canRecall`] = newRecall;
    });
    if (Object.keys(updates).length > 0) this.setData(updates);
  },

  scrollToBottom() {
    if (!this.data.messages.length) return;
    this.setData({ scrollIntoView: `group-message-${this.data.messages.length - 1}` });
  },

  revealLatestMessage(delay = 200) {
    if (this.data.messages.length === 0) return;
    if (this._revealTimer) clearTimeout(this._revealTimer);
    this._revealTimer = setTimeout(() => {
      this.setData({ scrollIntoView: '', scrollTop: 0 }, () => {
        this.setData({ scrollTop: 99999999 });
      });
    }, delay);
  },

  /* ══════ 工具栏 ══════ */
  onToggleTools() {
    const showTools = !this.data.showTools;
    this.setData({ showTools, showEmoji: false, voiceMode: false }, () => {
      if (showTools) { wx.hideKeyboard(); this.revealLatestMessage(); }
    });
  },

  onToggleEmoji() {
    const showEmoji = !this.data.showEmoji;
    this.setData({ showEmoji, showTools: false, voiceMode: false }, () => {
      if (showEmoji) { wx.hideKeyboard(); this.revealLatestMessage(); }
    });
  },

  onToggleVoiceMode() {
    if (this.data.recording) return;
    this.setData({ voiceMode: !this.data.voiceMode, showTools: false, showEmoji: false });
  },

  onSelectEmoji(e) {
    const emoji = e.currentTarget.dataset.emoji || '';
    const inputText = `${this.data.inputText || ''}${emoji}`.slice(0, 500);
    this.setData({ inputText, canSend: !!inputText.trim() });
    drafts.saveDraft('group-chat', this.data.groupId, { text: inputText });
  },

  onDismissPanels() {
    this.setData({ showTools: false, showEmoji: false });
  },

  /* ══════ 更多面板 ══════ */
  onToggleMore() {
    this.setData({ showMore: !this.data.showMore, showTools: false, showEmoji: false });
  },

  onCloseMore() {
    this.setData({ showMore: false });
  },

  onOpenMedia() {
    this.setData({ showMore: false });
    wx.navigateTo({ url: `/pages/chat-media/chat-media?groupId=${encodeURIComponent(this.data.groupId)}` });
  },

  async onToggleNotifications() {
    try {
      const result = await cloud.toggleGroupNotifications(this.data.groupId);
      this.setData({ notificationsMuted: result.notificationsMuted });
      wx.showToast({ title: result.notificationsMuted ? '已开启免打扰' : '已关闭免打扰', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: e.message || '操作失败', icon: 'none' });
    }
  },

  async onMuteMember(e) {
    const { openid } = e.currentTarget.dataset;
    try {
      await cloud.muteGroupMember(this.data.groupId, openid);
      // 更新本地成员列表中的禁言状态
      const members = this.data.members.map(m => m.openid === openid ? { ...m, muted: true } : m);
      this.setData({ members });
      wx.showToast({ title: '已禁言', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: e.message || '禁言失败', icon: 'none' });
    }
  },

  async onUnmuteMember(e) {
    const { openid } = e.currentTarget.dataset;
    try {
      await cloud.unmuteGroupMember(this.data.groupId, openid);
      const members = this.data.members.map(m => m.openid === openid ? { ...m, muted: false } : m);
      this.setData({ members });
      wx.showToast({ title: '已解除禁言', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: e.message || '解除失败', icon: 'none' });
    }
  },

  async onLeaveGroup() {
    const modal = await wx.showModal({
      title: '退出群聊',
      content: '退出后你将不再接收此群聊的消息。',
      confirmColor: '#ef4444',
      confirmText: '退出'
    });
    if (!modal.confirm) return;
    try {
      await cloud.leaveGroup(this.data.groupId);
      wx.showToast({ title: '已退出群聊', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 800);
    } catch (e) {
      wx.showToast({ title: e.message || '退出失败', icon: 'none' });
    }
  },

  async onDissolveGroup() {
    const modal = await wx.showModal({
      title: '解散群聊',
      content: '解散后所有成员将被移出，消息记录将被删除。此操作不可恢复。',
      confirmColor: '#ef4444',
      confirmText: '解散'
    });
    if (!modal.confirm) return;
    try {
      await cloud.dissolveGroup(this.data.groupId);
      wx.showToast({ title: '群聊已解散', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 800);
    } catch (e) {
      wx.showToast({ title: e.message || '解散失败', icon: 'none' });
    }
  },

  /* ══════ 发送图片 ══════ */
  async onSendImage() {
    try {
      const res = await wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['original'] });
      const file = res.tempFiles && res.tempFiles[0];
      if (!file) return;
      const action = await wx.showActionSheet({ itemList: ['发送原图', '压缩发送'] });
      const useOriginal = action.tapIndex === 0;
      wx.showLoading({ title: useOriginal ? '发送原图' : '压缩中' });
      const filePath = useOriginal ? file.tempFilePath : await cloud.createImageThumbnail(file.tempFilePath, 70);
      const fileId = await cloud.uploadImage(filePath, 'chat-images');
      await this.sendRichMessage('image', { fileId });
    } catch (e) {
      if (!String(e.errMsg || '').includes('cancel')) wx.showToast({ title: e.message || '图片发送失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  async onCameraCapture() {
    try {
      const res = await wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['camera'], sizeType: ['original'] });
      const file = res.tempFiles && res.tempFiles[0];
      if (!file) return;
      const action = await wx.showActionSheet({ itemList: ['发送原图', '压缩发送'] });
      const useOriginal = action.tapIndex === 0;
      wx.showLoading({ title: useOriginal ? '发送原图' : '压缩中' });
      const filePath = useOriginal ? file.tempFilePath : await cloud.createImageThumbnail(file.tempFilePath, 70);
      const fileId = await cloud.uploadImage(filePath, 'chat-images');
      await this.sendRichMessage('image', { fileId });
    } catch (e) {
      if (!String(e.errMsg || '').includes('cancel')) wx.showToast({ title: e.message || '拍摄失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  async onSendLocation() {
    try {
      const location = await wx.chooseLocation();
      await this.sendRichMessage('location', location);
    } catch (e) {
      if (!String(e.errMsg || '').includes('cancel')) wx.showToast({ title: e.message || '位置发送失败', icon: 'none' });
    }
  },

  async onSendFile() {
    try {
      const res = await wx.chooseMessageFile({ count: 1, type: 'file' });
      const file = res.tempFiles && res.tempFiles[0];
      if (!file) return;
      const { filePath, fileName, extension: ext, fileSize } = normalizePickedFile(file);
      if (!filePath) throw new Error('未能读取文件，请重新选择');
      if (!SUPPORTED_DOCUMENT_TYPES.has(ext)) {
        return wx.showToast({ title: '仅支持 Word、Excel、PPT 和 PDF', icon: 'none' });
      }
      if (fileSize > 50 * 1024 * 1024) return wx.showToast({ title: '文件不能超过 50MB', icon: 'none' });
      wx.showLoading({ title: '发送中' });
      const fileId = await cloud.uploadFile(filePath, ext, 'chat-files');
      await this.sendRichMessage('file', { fileId, fileName, fileType: ext, fileSize });
    } catch (e) {
      const title = fileSendError(e);
      if (title) wx.showToast({ title, icon: 'none', duration: 2600 });
    } finally {
      wx.hideLoading();
    }
  },

  async onSendCard() {
    try {
      const center = await cloud.getFriendCenter();
      const friends = center.friends || [];
      if (!friends.length) return wx.showToast({ title: '还没有可分享的好友名片', icon: 'none' });
      const action = await wx.showActionSheet({ itemList: friends.slice(0, 20).map(item => item.nickName || item.publicId || '好友') });
      const friend = friends[action.tapIndex];
      if (friend) await this.sendRichMessage('user_card', { openid: friend.openid });
    } catch (e) {
      if (!String(e.errMsg || '').includes('cancel')) wx.showToast({ title: e.message || '名片发送失败', icon: 'none' });
    }
  },

  /* ══════ 消息交互 ══════ */
  onOpenMessageImage(e) {
    const url = e.currentTarget.dataset.url;
    if (url) wx.previewImage({ urls: [url], current: url });
  },

  onOpenMessageLocation(e) {
    const { latitude, longitude, name } = e.currentTarget.dataset;
    wx.openLocation({ latitude: Number(latitude), longitude: Number(longitude), name: name || '', scale: 16 });
  },

  async onOpenMessageFile(e) {
    try {
      wx.showLoading({ title: '打开中' });
      const { fileId, fileName, fileType } = e.currentTarget.dataset;
      const extension = String(fileType || fileExtension(fileName));
      if (!SUPPORTED_DOCUMENT_TYPES.has(extension)) throw new Error('暂不支持打开此文件格式');
      const filePath = await cloud.downloadCloudFile(fileId);
      await wx.openDocument({ filePath, fileType: extension, showMenu: true });
    } catch (err) {
      wx.showToast({ title: err.message || '文件暂时无法打开', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  onOpenUserCard(e) {
    cloud.navigateToUserProfile(e.currentTarget.dataset.openid);
  },

  onOpenSharedMoment(e) {
    wx.navigateTo({ url: `/pages/moment-detail/moment-detail?momentId=${e.currentTarget.dataset.momentId}` });
  },

  /* ══════ 长按菜单 ══════ */
  async onMessageLongPress(e) {
    const message = this.data.messages[Number(e.currentTarget.dataset.index)];
    if (!message || String(message._id || '').startsWith('temp-')) return;
    const actions = [];
    const labels = [];
    if (message.type !== 'revoked') {
      actions.push('quote'); labels.push('引用');
    }
    if (message.canRecall) {
      actions.push('recall'); labels.push('撤回');
    }
    actions.push('delete'); labels.push('删除（仅自己）');
    try {
      const result = await wx.showActionSheet({ itemList: labels });
      const action = actions[result.tapIndex];
      if (action === 'quote') this.setReplyingTo(message);
      else if (action === 'recall') await this.recallMessage(message);
      else if (action === 'delete') await this.deleteMessageForMe(message);
    } catch (err) {
      if (!String(err.errMsg || err.message || '').includes('cancel')) {
        wx.showToast({ title: err.message || '操作失败', icon: 'none' });
      }
    }
  },

  setReplyingTo(message) {
    const senderName = message.isMine ? '我' : (message.senderName || '群成员');
    this.setData({
      replyingTo: { messageId: message._id, senderId: message.from, senderName, text: messagePreview(message) },
      showTools: false
    });
  },

  onCancelReply() {
    this.setData({ replyingTo: null });
  },

  onOpenQuotedMessage(e) {
    const messageId = e.currentTarget.dataset.messageId;
    const index = this.data.messages.findIndex(m => m._id === messageId);
    if (index < 0) return wx.showToast({ title: '原消息已不可见', icon: 'none' });
    this.setData({ scrollIntoView: '' });
    wx.nextTick(() => this.setData({ scrollIntoView: `group-message-${index}` }));
  },

  async recallMessage(message) {
    try {
      await cloud.recallGroupMessage(message._id);
      const index = this.data.messages.findIndex(m => m._id === message._id);
      if (index >= 0) {
        this.setData({
          [`messages[${index}].type`]: 'revoked',
          [`messages[${index}].canRecall`]: false
        });
      }
      if (this.data.replyingTo && this.data.replyingTo.messageId === message._id) {
        this.setData({ replyingTo: null });
      }
      wx.showToast({ title: '消息已撤回', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: e.message || '撤回失败', icon: 'none' });
    }
  },

  async deleteMessageForMe(message) {
    const modal = await wx.showModal({ title: '删除消息', content: '该消息只会从你的聊天记录中删除。', confirmColor: '#ef4444' });
    if (!modal.confirm) return;
    try {
      await cloud.hideGroupMessage(message._id);
      this.setData({ messages: this.data.messages.filter(m => m._id !== message._id) });
      if (this.data.replyingTo && this.data.replyingTo.messageId === message._id) {
        this.setData({ replyingTo: null });
      }
    } catch (e) {
      wx.showToast({ title: e.message || '删除失败', icon: 'none' });
    }
  },

  /* ══════ 语音录制 ══════ */
  _bindRecorderEvents() {
    this._onRecorderStop = async (res) => {
      if (!this._ownsRecording) return;
      this._ownsRecording = false;
      const cancelled = this._recordCancelled === true;
      this._recordCancelled = false;
      this._clearVoiceTimer();
      this.setData({ recording: false, recordCanceling: false, recordingDuration: 0 });
      if (cancelled || !res.tempFilePath) return;
      const duration = Math.max(1, Math.round((res.duration || 0) / 1000));
      if ((res.duration || 0) < 800) return wx.showToast({ title: '说话时间太短', icon: 'none' });
      try {
        this.setData({ sendingVoice: true });
        wx.showLoading({ title: '发送语音' });
        const fileId = await cloud.uploadFile(res.tempFilePath, 'mp3', 'chat-voices');
        await this.sendRichMessage('voice', { fileId, duration });
      } catch (e) {
        wx.showToast({ title: e.message || '语音发送失败', icon: 'none' });
      } finally {
        wx.hideLoading();
        this.setData({ sendingVoice: false });
      }
    };
    this._onRecorderError = (error) => {
      if (!this._ownsRecording) return;
      this._ownsRecording = false;
      this._recordCancelled = false;
      this._clearVoiceTimer();
      this.setData({ recording: false, recordCanceling: false, recordingDuration: 0 });
      const denied = String(error && error.errMsg || '').includes('auth');
      wx.showToast({ title: denied ? '请允许使用麦克风' : '录音失败，请重试', icon: 'none' });
    };
    recorderManager.onStop(this._onRecorderStop);
    recorderManager.onError(this._onRecorderError);
  },

  _unbindRecorderEvents() {
    if (recorderManager.offStop && this._onRecorderStop) recorderManager.offStop(this._onRecorderStop);
    if (recorderManager.offError && this._onRecorderError) recorderManager.offError(this._onRecorderError);
  },

  _clearVoiceTimer() {
    if (this._voiceTimer) clearInterval(this._voiceTimer);
    this._voiceTimer = null;
  },

  _cancelActiveRecording() {
    if (!this._ownsRecording) return;
    this._recordCancelled = true;
    recorderManager.stop();
    this._clearVoiceTimer();
  },

  onVoiceTouchStart(e) {
    if (this.data.sendingVoice || this._ownsRecording) return;
    const touch = e.touches && e.touches[0];
    this._voiceStartY = touch ? touch.pageY : 0;
    this._recordCancelled = false;
    this._ownsRecording = true;
    this.setData({ recording: true, recordCanceling: false, recordingDuration: 0 });
    this._voiceTimer = setInterval(() => {
      this.setData({ recordingDuration: Math.min(60, this.data.recordingDuration + 1) });
    }, 1000);
    recorderManager.start({ duration: 60000, format: 'mp3', sampleRate: 16000, numberOfChannels: 1, encodeBitRate: 48000 });
  },

  onVoiceTouchMove(e) {
    if (!this._ownsRecording) return;
    const touch = e.touches && e.touches[0];
    const canceling = !!touch && this._voiceStartY - touch.pageY > 80;
    if (canceling !== this.data.recordCanceling) this.setData({ recordCanceling: canceling });
  },

  onVoiceTouchEnd() {
    if (!this._ownsRecording) return;
    this._recordCancelled = this.data.recordCanceling;
    recorderManager.stop();
  },

  onVoiceTouchCancel() {
    if (!this._ownsRecording) return;
    this._recordCancelled = true;
    recorderManager.stop();
  },

  async onPlayVoiceMessage(e) {
    const { messageId, url } = e.currentTarget.dataset;
    if (!url) return wx.showToast({ title: '语音已失效', icon: 'none' });
    if (this.data.voicePlayingId === messageId) {
      if (this._voiceAudio) this._voiceAudio.stop();
      this.setData({ voicePlayingId: '' });
      return;
    }
    if (this._voiceAudio) {
      this._voiceAudio.stop();
      this._voiceAudio.destroy();
    }
    const audio = wx.createInnerAudioContext();
    this._voiceAudio = audio;
    audio.obeyMuteSwitch = false;
    audio.src = await cloud.getTempFileUrl(url);
    audio.onEnded(() => this.setData({ voicePlayingId: '' }));
    audio.onStop(() => this.setData({ voicePlayingId: '' }));
    audio.onError(() => {
      this.setData({ voicePlayingId: '' });
      wx.showToast({ title: '语音播放失败', icon: 'none' });
    });
    this.setData({ voicePlayingId: messageId });
    audio.play();
  },

  /* ══════ 键盘 ══════ */
  onKeyboardHeightChange(e) {
    const height = e.detail.height || 0;
    if (height > 0) {
      if (!this._rpxRatio) this._rpxRatio = wx.getSystemInfoSync().windowWidth / 750;
      const paddingPx = 230 * this._rpxRatio + height;
      this.setData({
        keyboardHeight: height,
        showTools: false,
        showEmoji: false,
        replyingTo: null,
        chatListPaddingStyle: `padding-bottom: ${paddingPx}px;`
      }, () => { this.revealLatestMessage(360); });
    } else {
      this.setData({ keyboardHeight: 0, chatListPaddingStyle: '' }, () => { this.revealLatestMessage(360); });
    }
  },

  noop() {},
  preventBubble() {}
});
