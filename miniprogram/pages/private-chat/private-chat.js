const cloud = require('../../utils/cloud');
const drafts = require('../../utils/drafts');
const theme = require('../../utils/theme');
const recorderManager = wx.getRecorderManager();

const SUPPORTED_DOCUMENT_TYPES = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf']);
const EMOJI_LIST = ['😀', '😄', '😂', '🥰', '😍', '😘', '😊', '🥹', '😎', '🤔', '😴', '😭', '😤', '👍', '👏', '🙌', '🤝', '💪', '❤️', '💕', '🎉', '✨', '🌈', '✈️'];

const STATUS_EMOJI_ICON_MAP = {
  '🏃': '运动', '🚴': '运动', '🏋': '运动', '⛹': '运动', '🤸': '运动',
  '🛒': '购物', '🛍': '购物',
  '🍽': '餐饮', '🍔': '餐饮', '🍕': '餐饮', '☕': '餐饮', '🍜': '餐饮', '🍳': '餐饮', '🥘': '餐饮',
  '🏨': '住宿', '🏠': '住宿', '🏕': '住宿',
  '🚌': '公交', '🚗': '公交', '🚇': '公交', '🚕': '公交',
  '✈️': '飞机', '✈': '飞机', '🛫': '飞机', '🛩': '飞机',
  '🎫': '门票', '🎟': '门票',
  '💰': '钱包', '💵': '钱包', '💳': '钱包',
  '🧘': '冥想', '😌': '冥想',
  '⚽': '世界杯', '🏆': '世界杯', '🏟': '世界杯',
  '🎵': '听歌识曲', '🎶': '听歌识曲', '🎧': '听歌识曲', '🎤': '听歌识曲',
  '😷': '难受', '🤒': '难受', '🤕': '难受', '😢': '难受',
};

function moodIconName(mood) {
  if (!mood || !mood.emoji) return '';
  const emoji = mood.emoji.trim();
  const iconNames = new Set(['飞机', '听歌识曲', '运动', '餐饮', '冥想', '难受']);
  if (iconNames.has(emoji)) return emoji;
  if (STATUS_EMOJI_ICON_MAP[emoji]) return STATUS_EMOJI_ICON_MAP[emoji];
  // Try the first character if combined emoji
  const first = [...emoji][0];
  if (first && STATUS_EMOJI_ICON_MAP[first]) return STATUS_EMOJI_ICON_MAP[first];
  return '';
}

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
  if (message.type === 'trip_invite') return `[行程邀请] ${message.tripName || ''}`;
  return String(message.text || '消息').slice(0, 100);
}

Page({
  data: {
    themeStyle: '',
    themeClass: 'theme-blue',
    targetOpenid: '',
    targetUser: { nickName: '', avatarUrl: '' },
    targetRawAvatarUrl: '',
    targetBadgeIcon: '',
    targetVerified: false,
    _avatarRefreshAt: 0,
    myAvatarUrl: '',
    myNickName: '',
    statusText: '离线',
    isOnline: false,
    targetIsTyping: false,
    myOpenid: '',
    messages: [],
    inputText: '',
    canSend: false,
    loading: true,
    sending: false,
    scrollIntoView: '',
    scrollTop: 0,
    following: false,
    followedBy: false,
    friendStatus: 'none',
    friendRequestId: '',
    socialLoading: false,
    inviting: false,
    showTools: false,
    showEmoji: false,
    emojiList: EMOJI_LIST,
    voiceMode: false,
    recording: false,
    recordCanceling: false,
    recordingDuration: 0,
    sendingVoice: false,
    voicePlayingId: '',
    blocked: false,
    limited: false,
    sentCount: 0,
    hiddenMoments: false,
    targetMood: null,
    statusIcon: '',
    replyingTo: null,
    keyboardHeight: 0,
    chatListPaddingStyle: ''
  },

  onLoad(options) {
    const safeDecode = (value) => {
      try { return decodeURIComponent(value || ''); } catch (_) { return value || ''; }
    };
    const targetUser = {
      nickName: safeDecode(options.nickName),
      avatarUrl: safeDecode(options.avatarUrl)
    };
    this.setData({
      targetOpenid: safeDecode(options.openid),
      targetUser
    });
    const savedDraft = drafts.getDraft('private-chat', this.data.targetOpenid);
    if (savedDraft && savedDraft.text) this.setData({ inputText: savedDraft.text, canSend: true });
    // 标记当前聊天对象，阻止全局弹窗
    const app = getApp();
    if (app && app.globalData) app.globalData._currentChatOpenid = this.data.targetOpenid;
    const cached = app && app.globalData && app.globalData._privateChatRuntimeCache && app.globalData._privateChatRuntimeCache[this.data.targetOpenid];
    if (cached && Date.now() - cached.savedAt < 10 * 60 * 1000) {
      this.setData({
        messages: (cached.messages || []).filter(item => !String(item._id || '').startsWith('temp-')),
        myOpenid: cached.myOpenid || '',
        myAvatarUrl: cached.myAvatarUrl || '',
        myNickName: cached.myNickName || '',
        loading: false,
        scrollTop: cached.messages && cached.messages.length ? 99999999 : 0
      });
    }
    if (targetUser.nickName) wx.setNavigationBarTitle({ title: targetUser.nickName });
    this._bindRecorderEvents();
    wx.setInnerAudioOption({ obeyMuteSwitch: false });
    this.loadChat();
    this._timeTimer = setInterval(() => this.refreshRelativeTimes(), 60000);
  },

  onUnload() {
    // 清除全局弹窗屏蔽
    const app = getApp();
    if (app && app.globalData) app.globalData._currentChatOpenid = '';
    if (this._timeTimer) clearInterval(this._timeTimer);
    this.stopPolling();
    this.stopRealtime();
    this._flushReadsNow();
    this._teardownReadObserver();
    if (this._typingTimer) { clearTimeout(this._typingTimer); this._typingTimer = null; }
    if (this._revealTimer) { clearTimeout(this._revealTimer); this._revealTimer = null; }
    this._cancelActiveRecording();
    this._unbindRecorderEvents();
    if (this._voiceAudio) {
      this._voiceAudio.stop();
      this._voiceAudio.destroy();
      this._voiceAudio = null;
    }
  },

  onShow() {
    theme.applyToPage(this);
    // 重新标记当前聊天对象（从后台恢复时 _currentChatOpenid 可能已被清除）
    const app = getApp();
    if (app && app.globalData && this.data.targetOpenid) {
      app.globalData._currentChatOpenid = this.data.targetOpenid;
    }
    // 已加载完毕则恢复实时监听，无需全量刷新（onLoad 已做首次加载）
    if (this.data.targetOpenid && !this.data.loading && this.data.messages.length > 0) {
      this.startRealtime();
      this.poll();
    }
  },

  onHide() {
    this.cacheChatRuntime();
    this.stopPolling();
    this.stopRealtime();
    // 立即把待标记的消息发出去，避免未读残留
    this._flushReadsNow();
    this._teardownReadObserver();
    if (this._typingTimer) { clearTimeout(this._typingTimer); this._typingTimer = null; }
  },

  async loadChat() {
    try {
      const myOpenid = await cloud.getOpenid();
      const app = getApp();
      const myInfo = (app.globalData && app.globalData.userInfo) || {};
      this.setData({
        myAvatarUrl: myInfo.avatarUrl || '',
        myNickName: myInfo.nickName || ''
      });
      const { targetOpenid } = this.data;
      let targetUser = this.data.targetUser;

      // 消息优先返回；头像、关系和隐私在后台补齐，避免进入聊天时等待最慢接口。
      const profilePromise = cloud.getUserProfile(targetOpenid);
      const chatPromise = cloud.getPrivateChat(targetOpenid);
      const relationshipPromise = cloud.getSocialRelationship(targetOpenid);
      const preferencesPromise = cloud.getSocialPreferences();
      const chatRes = await Promise.resolve(chatPromise).then(
        value => ({ status: 'fulfilled', value }),
        reason => ({ status: 'rejected', reason })
      );
      const chat = chatRes.status === 'fulfilled' ? chatRes.value : { messages: [], targetLastActiveAt: '', serverNow: '' };
      let messages = chat.messages || [];
      const earlyServerTimestamp = new Date(chat.serverNow || Date.now()).getTime();
      messages.forEach(m => {
        m.isMine = m.from === myOpenid;
        m.formattedTime = cloud.formatDate(m.createdAt);
        m.readText = m.isMine ? (m.readAt ? '已读' : '未读') : '';
        m.canRecall = m.isMine && m.type !== 'revoked' && earlyServerTimestamp - new Date(m.createdAt).getTime() <= 2 * 60 * 1000;
        m.voiceBubbleWidth = Math.min(360, 176 + Math.max(0, Number(m.voiceDuration || 1) - 1) * 4);
        m.quoteDisplayName = m.quoteSenderId === myOpenid ? '我' : (m.quoteSenderName || targetUser.nickName || '对方');
      });
      this.setData({
        myOpenid,
        messages,
        loading: false,
        scrollIntoView: messages.length ? `msg-${messages.length - 1}` : ''
      });

      const [profileRes, relationshipRes, preferencesRes] = await Promise.allSettled([
        profilePromise,
        relationshipPromise,
        preferencesPromise
      ]);

      const profile = profileRes.status === 'fulfilled' ? profileRes.value : null;
      const relationship = relationshipRes.status === 'fulfilled' ? relationshipRes.value : { following: false, friend: { status: 'none', requestId: '' } };
      const preferences = preferencesRes.status === 'fulfilled' ? preferencesRes.value : { blockedOpenids: [], hiddenMomentOpenids: [] };

      if (profileRes.status === 'rejected') console.error('getUserProfile 失败:', profileRes.reason);
      if (chatRes.status === 'rejected') console.error('getPrivateChat 失败:', chatRes.reason);
      if (relationshipRes.status === 'rejected') console.error('getSocialRelationship 失败:', relationshipRes.reason);
      if (preferencesRes.status === 'rejected') console.error('getSocialPreferences 失败:', preferencesRes.reason);

      if (profile) {
        // 保存原始 cloud:// 链接，用于后续刷新临时链接
        const rawAvatarUrl = profile.rawAvatarUrl || profile.avatarUrl || '';
        targetUser = {
          ...targetUser,
          nickName: profile.nickName || targetUser.nickName || '',
          avatarUrl: profile.avatarUrl || targetUser.avatarUrl || '',
          publicId: profile.publicId || ''
        };
        this.setData({ targetRawAvatarUrl: rawAvatarUrl.startsWith('cloud://') ? rawAvatarUrl : '' });
        // 对方的徽章（佩戴中且未隐藏才显示）
        const targetBadge = profile.wornBadge;
        const targetShowBadge = profile.showBadge !== undefined ? profile.showBadge : true;
        const targetBadgeIcon = targetBadge && targetShowBadge ? cloud.getBadgeIcon(targetBadge) : '';
        const targetVerified = cloud.isOfficialByPublicId(profile.publicId);
        this.setData({ targetBadgeIcon, targetVerified });
        // 对方的心情状态
        if (profile.moodEmoji) {
          const targetMood = {
            emoji: profile.moodEmoji,
            text: profile.moodText || '',
            updatedAt: profile.moodUpdatedAt || ''
          };
          this.setData({ targetMood, statusIcon: moodIconName(targetMood) });
        }
      }
      if (targetUser.nickName) wx.setNavigationBarTitle({ title: targetUser.nickName });

      const richMessages = messages.filter(m => m.imageFileId || m.voiceFileId || m.cardAvatar || m.momentImage);
      const mediaResolvePromise = richMessages.length
        ? cloud.resolveCloudFileFields(richMessages, ['imageFileId', 'voiceFileId', 'cardAvatar', 'momentImage'])
        : Promise.resolve();
      const serverTimestamp = new Date(chat.serverNow || Date.now()).getTime();
      messages.forEach(m => {
        m.isMine = m.from === myOpenid;
        m.formattedTime = cloud.formatDate(m.createdAt);
        m.readText = m.isMine ? (m.readAt ? '已读' : '未读') : '';
        m.canRecall = m.isMine && m.type !== 'revoked' &&
          serverTimestamp - new Date(m.createdAt).getTime() <= 2 * 60 * 1000;
        m.voiceBubbleWidth = Math.min(360, 176 + Math.max(0, Number(m.voiceDuration || 1) - 1) * 4);
        m.quoteDisplayName = m.quoteSenderId === myOpenid
          ? '我'
          : (m.quoteSenderName || targetUser.nickName || '对方');
        m.invitationText = m.invitationStatus === 'accepted'
          ? '已加入'
          : m.invitationStatus === 'rejected' ? '已拒绝' : '等待确认';
      });
      const presence = this.formatPresence(chat.targetLastActiveAt, chat.serverNow);
      const friendStatus = (relationship.friend && relationship.friend.status) || 'none';
      const limited = friendStatus !== 'friends' && !(relationship.following && relationship.followedBy);
      const sentCount = messages.filter(m => m.isMine && m.type !== 'revoked').length;
      this.setData({
        myOpenid,
        targetUser,
        statusText: presence.text,
        isOnline: presence.online,
        following: relationship.following === true,
        followedBy: relationship.followedBy === true,
        friendStatus,
        friendRequestId: (relationship.friend && relationship.friend.requestId) || '',
        blocked: (preferences.blockedOpenids || []).includes(targetOpenid),
        limited,
        sentCount,
        hiddenMoments: (preferences.hiddenMomentOpenids || []).includes(targetOpenid),
        loading: false,
        scrollIntoView: ''
      }, () => {
        this.cacheChatRuntime();
      });
      mediaResolvePromise.then(() => {
        if (!richMessages.length) return;
        const resolvedMap = {};
        richMessages.forEach(item => { resolvedMap[item._id] = item; });
        const merged = this.data.messages.map(item => resolvedMap[item._id] ? { ...item, ...resolvedMap[item._id] } : item);
        this.setData({ messages: merged }, () => this.cacheChatRuntime());
      }).catch(() => {});
      // 初始化轮询锚点
      const lastMsg = messages[messages.length - 1];
      this._lastMessageCreatedAt = lastMsg ? lastMsg.createdAt : '';
      this._unreadMessageIds = messages
        .filter(m => m.isMine && !m.readAt)
        .map(m => m._id);
      // 进聊天立即标记所有对方消息已读（不依赖滚动）
      const unreadIncomingIds = messages
        .filter(m => !m.isMine && !m.readAt && m._id && !String(m._id).startsWith('temp-'))
        .map(m => m._id);
      if (unreadIncomingIds.length > 0) {
        cloud.markMessagesRead(unreadIncomingIds).catch(() => {});
      }
      this.startRealtime();
    } catch (e) {
      console.error('加载私信失败:', e);
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  formatPresence(lastActiveAt, serverNow) {
    if (!lastActiveAt) return { text: '离线', online: false };
    const last = new Date(lastActiveAt).getTime();
    const now = new Date(serverNow || Date.now()).getTime();
    if (!last || !now) return { text: '离线', online: false };
    const diff = now - last;
    if (diff <= 5 * 60 * 1000) return { text: '在线', online: true };
    if (diff <= 60 * 60 * 1000) return { text: `${Math.max(1, Math.floor(diff / 60000))}分钟前在线`, online: false };
    if (diff <= 24 * 60 * 60 * 1000) return { text: `${Math.floor(diff / 3600000)}小时前在线`, online: false };
    return { text: '离线', online: false };
  },

  // ---- 实时监听 + 低频轮询（双保险） ----
  async startRealtime() {
    this.stopRealtime();
    try {
      let initialSnapshot = true;
      this._messageWatcher = await cloud.watchPrivateConversation(this.data.targetOpenid, {
        onChange: () => {
          if (initialSnapshot) {
            initialSnapshot = false;
            this.poll(); // 初次快照后立即拉取最新消息
            return;
          }
          this.poll();
        },
        onError: error => {
          console.warn('私信实时监听中断:', error);
          this.stopRealtime();
        }
      });
    } catch (e) {
      console.warn('私信实时监听不可用:', e);
    }
    // 始终开启低频轮询作为兜底（watch 可能静默失效）
    this.startPolling();
  },

  stopRealtime() {
    if (this._messageWatcher) {
      try { this._messageWatcher.close(); } catch (_) { /* 已关闭 */ }
      this._messageWatcher = null;
    }
  },

  startPolling() {
    this.stopPolling();
    this.poll();
    this._pollTimer = setInterval(() => this.poll(), 15000);
  },

  stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  },

  // ---- 滚动到视野才标记已读 ----
  _setupReadObserver() {
    this._teardownReadObserver();
    const messages = this.data.messages;
    const selectors = [];
    messages.forEach((m, i) => {
      if (!m.isMine && !m.readAt && m._id && !String(m._id).startsWith('temp-')) {
        selectors.push({ sel: `#msg-${i}`, id: m._id });
      }
    });
    if (!selectors.length) return;

    this._pendingReads = new Set();
    const observer = this.createIntersectionObserver();
    this._readObserver = observer;
    selectors.forEach(({ sel, id }) => {
      observer.relativeTo('.chat-list', { top: 0, bottom: 0 }).observe(sel, (res) => {
        if (res.intersectionRatio >= 0.5) {
          this._pendingReads.add(id);
          this._flushReads();
        }
      });
    });
  },

  _teardownReadObserver() {
    if (this._readObserver) {
      this._readObserver.disconnect();
      this._readObserver = null;
    }
    if (this._readFlushTimer) {
      clearTimeout(this._readFlushTimer);
      this._readFlushTimer = null;
    }
  },

  _flushReads() {
    // 100ms 防抖，合并同一帧的多次触发
    if (this._readFlushTimer) clearTimeout(this._readFlushTimer);
    this._readFlushTimer = setTimeout(() => {
      this._readFlushTimer = null;
      this._flushReadsNow();
    }, 100);
  },

  async _flushReadsNow() {
    const pending = this._pendingReads;
    if (!pending || !pending.size) return;
    this._pendingReads = new Set();
    const ids = [...pending];
    try {
      await cloud.markMessagesRead(ids);
      const readSet = new Set(ids);
      const messages = this.data.messages.map(m => {
        if (readSet.has(m._id)) return { ...m, readText: '', readAt: true };
        return m;
      });
      this.setData({ messages });
      this._unreadMessageIds = (this._unreadMessageIds || []).filter(id => !readSet.has(id));
    } catch (e) {
      console.warn('标记已读失败:', e);
    }
  },

  async poll() {
    if (this._polling || this.data.loading) return;
    this._polling = true;
    try {
      // 每 45 分钟刷新一次头像临时链接（微信临时链接约 2 小时过期）
      if (this.data.targetRawAvatarUrl && Date.now() - this.data._avatarRefreshAt > 45 * 60 * 1000) {
        const freshUrl = await cloud.getTempFileUrl(this.data.targetRawAvatarUrl);
        if (freshUrl) {
          this.setData({ 'targetUser.avatarUrl': freshUrl, _avatarRefreshAt: Date.now() });
        }
      }
      const { targetOpenid } = this.data;
      const result = await cloud.pollPrivateChat(
        targetOpenid,
        this._lastMessageCreatedAt || '',
        this._unreadMessageIds || []
      );

      if (!result || !result.success) { this._polling = false; return; }

      const { newMessages = [], readMessageIds = [], targetLastActiveAt, targetIsTyping, targetMood, serverNow } = result;
      const myOpenid = this.data.myOpenid;
      let messages = this.data.messages;
      let changed = false;
      let appended = false;

      // 追加新消息（去重）
      if (newMessages.length > 0) {
        const existingIds = new Set(messages.map(m => m._id));
        const toAdd = newMessages.filter(m => !existingIds.has(m._id));
        if (toAdd.length > 0) {
          await cloud.resolveCloudFileFields(toAdd, ['imageFileId', 'voiceFileId', 'cardAvatar', 'momentImage']);
          const serverTimestamp = new Date(serverNow || Date.now()).getTime();
          toAdd.forEach(m => {
            m.isMine = m.from === myOpenid;
            m.formattedTime = cloud.formatDate(m.createdAt);
            m.readText = m.isMine ? (m.readAt ? '已读' : '未读') : '';
            m.canRecall = m.isMine && m.type !== 'revoked' &&
              serverTimestamp - new Date(m.createdAt).getTime() <= 2 * 60 * 1000;
            m.voiceBubbleWidth = Math.min(360, 176 + Math.max(0, Number(m.voiceDuration || 1) - 1) * 4);
            m.quoteDisplayName = m.quoteSenderId === myOpenid
              ? '我'
              : (m.quoteSenderName || this.data.targetUser.nickName || '对方');
          });
          messages = [...messages, ...toAdd].sort((a, b) =>
            String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
          changed = true;
          appended = true;
          // 新消息里对方发的立即标已读
          const newIncomingIds = toAdd
            .filter(m => !m.isMine && !m.readAt && m._id && !String(m._id).startsWith('temp-'))
            .map(m => m._id);
          if (newIncomingIds.length > 0) {
            cloud.markMessagesRead(newIncomingIds).catch(() => {});
          }
        }
        // 用最后一条服务器消息的 createdAt 作为下一次轮询的锚点
        const last = newMessages[newMessages.length - 1];
        if (last && last.createdAt && last.createdAt > (this._lastMessageCreatedAt || '')) {
          this._lastMessageCreatedAt = last.createdAt;
        }
      }

      // 更新已读回执
      if (readMessageIds.length > 0) {
        const readSet = new Set(readMessageIds);
        messages = messages.map(m => {
          if (readSet.has(m._id) && !m.readAt) {
            return { ...m, readText: '已读', readAt: true };
          }
          return m;
        });
        this._unreadMessageIds = (this._unreadMessageIds || []).filter(id => !readSet.has(id));
        changed = true;
      }

      // 更新在线状态 & 正在输入 & 心情
      const presence = this.formatPresence(targetLastActiveAt, serverNow);
      const typingChanged = this.data.targetIsTyping !== (targetIsTyping === true);
      const moodChanged = JSON.stringify(targetMood) !== JSON.stringify(this.data.targetMood);
      if (presence.text !== this.data.statusText || presence.online !== this.data.isOnline || typingChanged || moodChanged) {
        const newMood = targetMood || null;
        this.setData({ statusText: presence.text, isOnline: presence.online, targetIsTyping: targetIsTyping === true, targetMood: newMood, statusIcon: moodIconName(newMood) });
      }

      if (changed) {
        const sentCount = messages.filter(m => m.isMine && m.type !== 'revoked').length;
        this.setData({ messages, sentCount }, () => this.cacheChatRuntime());
      }
    } catch (e) {
      console.warn('轮询私信失败:', e);
    }
    this._polling = false;
  },

  refreshRelativeTimes() {
    const now = Date.now();
    const updates = {};
    this.data.messages.forEach((message, i) => {
      const newTime = cloud.formatDate(message.createdAt);
      const newRecall = message.isMine && message.type !== 'revoked' &&
        now - new Date(message.createdAt).getTime() <= 2 * 60 * 1000;
      if (message.formattedTime !== newTime) {
        updates[`messages[${i}].formattedTime`] = newTime;
      }
      if (message.canRecall !== newRecall) {
        updates[`messages[${i}].canRecall`] = newRecall;
      }
    });
    if (Object.keys(updates).length > 0) {
      this.setData(updates);
    }
  },

  cacheChatRuntime() {
    if (!this.data.targetOpenid) return;
    const app = getApp();
    if (!app || !app.globalData) return;
    const cache = { ...(app.globalData._privateChatRuntimeCache || {}) };
    cache[this.data.targetOpenid] = {
      messages: (this.data.messages || []).slice(-100),
      myOpenid: this.data.myOpenid,
      myAvatarUrl: this.data.myAvatarUrl,
      myNickName: this.data.myNickName,
      savedAt: Date.now()
    };
    const keys = Object.keys(cache).sort((a, b) => cache[b].savedAt - cache[a].savedAt);
    keys.slice(4).forEach(key => delete cache[key]);
    app.globalData._privateChatRuntimeCache = cache;
  },

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
      }, () => this.revealLatestMessage(360));
    } else {
      this.setData({
        keyboardHeight: 0,
        chatListPaddingStyle: ''
      }, () => this.revealLatestMessage(360));
    }
  },

  onInput(e) {
    const inputText = e.detail.value;
    this.setData({ inputText, canSend: !!inputText.trim() });
    drafts.saveDraft('private-chat', this.data.targetOpenid, { text: inputText });
    // 每 2 秒通知一次「正在输入」
    if (!this._typingTimer) {
      cloud.touchTyping(this.data.targetOpenid).catch(() => {});
      this._typingTimer = setTimeout(() => {
        this._typingTimer = null;
      }, 2000);
    }
  },

  async onSend() {
    const text = this.data.inputText.trim();
    if (!text || this.data.sending || this.data.blocked) return;
    const replyingTo = this.data.replyingTo;
    const tempId = `temp-${Date.now()}`;
    const optimisticMessage = {
      _id: tempId,
      from: this.data.myOpenid,
      to: this.data.targetOpenid,
      text,
      createdAt: new Date().toISOString(),
      formattedTime: '刚刚',
      isMine: true,
      readText: '发送中',
      canRecall: false
    };
    if (replyingTo) {
      optimisticMessage.quoteMessageId = replyingTo.messageId;
      optimisticMessage.quoteSenderId = replyingTo.senderId;
      optimisticMessage.quoteSenderName = replyingTo.senderName;
      optimisticMessage.quoteDisplayName = replyingTo.senderId === this.data.myOpenid ? '我' : replyingTo.senderName;
      optimisticMessage.quoteText = replyingTo.text;
    }
    const messages = [...this.data.messages, optimisticMessage];
    this.setData({
      sending: true,
      inputText: '',
      canSend: false,
      replyingTo: null,
      messages,
      scrollIntoView: `msg-${messages.length - 1}`
    });
    drafts.clearDraft('private-chat', this.data.targetOpenid);
    try {
      const message = await cloud.sendPrivateMessage(
        this.data.targetOpenid,
        text,
        replyingTo ? replyingTo.messageId : ''
      );
      const index = this.data.messages.findIndex(item => item._id === tempId);
      if (index >= 0) {
        this.setData({
          [`messages[${index}]`]: {
            ...message,
            formattedTime: cloud.formatDate(message.createdAt),
            isMine: true,
            readText: '未读',
            canRecall: true,
            quoteDisplayName: message.quoteSenderId === this.data.myOpenid
              ? '我'
              : (message.quoteSenderName || this.data.targetUser.nickName || '对方')
          }
        });
        // 更新轮询锚点（使用服务器返回的真实 createdAt）
        if (message.createdAt && message.createdAt > (this._lastMessageCreatedAt || '')) {
          this._lastMessageCreatedAt = message.createdAt;
        }
        // 新发出的消息加入未读追踪
        if (message._id && !message.readAt) {
          this._unreadMessageIds = [...(this._unreadMessageIds || []), message._id];
        }
      }
    } catch (e) {
      this.setData({
        messages: this.data.messages.filter(item => item._id !== tempId),
        inputText: text,
        canSend: true,
        replyingTo
      });
      drafts.saveDraft('private-chat', this.data.targetOpenid, { text });
      wx.showToast({ title: e.message || '发送失败', icon: 'none' });
    }
    this.setData({ sending: false });
  },

  onOpenTargetProfile() {
    const { targetOpenid, targetUser } = this.data;
    cloud.navigateToUserProfile(targetOpenid, targetUser);
  },

  onToggleTools() {
    if (this.data.blocked) return wx.showToast({ title: '请先取消屏蔽', icon: 'none' });
    const showTools = !this.data.showTools;
    this.setData({ showTools, showEmoji: false, voiceMode: false }, () => {
      if (showTools) {
        wx.hideKeyboard();
        this.revealLatestMessage();
      }
    });
  },

  appendOutgoingMessage(message) {
    const formatted = {
      ...message,
      isMine: true,
      formattedTime: cloud.formatDate(message.createdAt),
      readText: '未读',
      canRecall: true,
      voiceBubbleWidth: Math.min(360, 176 + Math.max(0, Number(message.voiceDuration || 1) - 1) * 4),
      quoteDisplayName: message.quoteSenderId === this.data.myOpenid
        ? '我'
        : (message.quoteSenderName || this.data.targetUser.nickName || '对方')
    };
    const messages = [...this.data.messages, formatted];
    // 更新轮询锚点与未读追踪
    if (message.createdAt && message.createdAt > (this._lastMessageCreatedAt || '')) {
      this._lastMessageCreatedAt = message.createdAt;
    }
    if (message._id && !message.readAt) {
      this._unreadMessageIds = [...(this._unreadMessageIds || []), message._id];
    }
    const sentCount = messages.filter(m => m.isMine && m.type !== 'revoked').length;
    this.setData({
      messages,
      sentCount,
      showTools: false,
      showEmoji: false,
      replyingTo: null,
      scrollIntoView: `msg-${messages.length - 1}`
    });
  },

  async sendRichMessage(type, data) {
    const replyingTo = this.data.replyingTo;
    const message = await cloud.sendRichPrivateMessage(this.data.targetOpenid, type, {
      ...data,
      quoteMessageId: replyingTo ? replyingTo.messageId : ''
    });
    await cloud.resolveCloudFileFields([message], ['imageFileId', 'voiceFileId', 'cardAvatar', 'momentImage']);
    this.appendOutgoingMessage(message);
  },

  onToggleVoiceMode() {
    if (this.data.blocked) return wx.showToast({ title: '请先取消屏蔽', icon: 'none' });
    if (this.data.recording) return;
    this.setData({
      voiceMode: !this.data.voiceMode,
      showTools: false,
      showEmoji: false
    });
  },

  onToggleEmoji() {
    if (this.data.blocked) return wx.showToast({ title: '请先取消屏蔽', icon: 'none' });
    if (this.data.recording) return;
    const showEmoji = !this.data.showEmoji;
    this.setData({
      showEmoji,
      showTools: false,
      voiceMode: false
    }, () => {
      if (showEmoji) {
        wx.hideKeyboard();
        this.revealLatestMessage();
      }
    });
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


  onDismissPanels() {
    this.setData({ showTools: false, showEmoji: false });
  },

  noop() {},

  onSelectEmoji(e) {
    const emoji = e.currentTarget.dataset.emoji || '';
    const inputText = `${this.data.inputText || ''}${emoji}`.slice(0, 500);
    this.setData({ inputText, canSend: !!inputText.trim() });
    drafts.saveDraft('private-chat', this.data.targetOpenid, { text: inputText });
  },

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
      if ((res.duration || 0) < 800) {
        return wx.showToast({ title: '说话时间太短', icon: 'none' });
      }
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
    if (this.data.blocked || this.data.sendingVoice || this._ownsRecording) return;
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

  async onSendImage() {
    try {
      const res = await wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['original'] });
      const file = res.tempFiles && res.tempFiles[0];
      if (!file) return;
      // 让用户选择是否发送原图
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

  async onMessageLongPress(e) {
    const message = this.data.messages[Number(e.currentTarget.dataset.index)];
    if (!message || String(message._id || '').startsWith('temp-')) return;
    const actions = [];
    const labels = [];
    if (message.type !== 'revoked') {
      actions.push('quote');
      labels.push('引用');
    }
    if (message.canRecall) {
      actions.push('recall');
      labels.push('撤回');
    }
    actions.push('delete');
    labels.push('删除（仅自己）');
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
    const senderName = message.isMine ? '我' : (this.data.targetUser.nickName || '对方');
    this.setData({
      replyingTo: {
        messageId: message._id,
        senderId: message.from,
        senderName,
        text: messagePreview(message)
      },
      showTools: false
    });
  },

  onCancelReply() {
    this.setData({ replyingTo: null });
  },

  onOpenQuotedMessage(e) {
    const messageId = e.currentTarget.dataset.messageId;
    const index = this.data.messages.findIndex(item => item._id === messageId);
    if (index < 0) return wx.showToast({ title: '原消息已不可见', icon: 'none' });
    this.setData({ scrollIntoView: '' });
    wx.nextTick(() => this.setData({ scrollIntoView: `msg-${index}` }));
  },

  async recallMessage(message) {
    await cloud.recallPrivateMessage(message._id);
    const index = this.data.messages.findIndex(item => item._id === message._id);
    if (index >= 0) {
      this.setData({
        [`messages[${index}].type`]: 'revoked',
        [`messages[${index}].canRecall`]: false,
        [`messages[${index}].readText`]: ''
      });
    }
    if (this.data.replyingTo && this.data.replyingTo.messageId === message._id) {
      this.setData({ replyingTo: null });
    }
    wx.showToast({ title: '消息已撤回', icon: 'success' });
  },

  async deleteMessageForMe(message) {
    const modal = await wx.showModal({
      title: '删除消息',
      content: '该消息只会从你的聊天记录中删除。',
      confirmColor: '#ef4444'
    });
    if (!modal.confirm) return;
    await cloud.hidePrivateMessage(message._id);
    this.setData({ messages: this.data.messages.filter(item => item._id !== message._id) });
    if (this.data.replyingTo && this.data.replyingTo.messageId === message._id) {
      this.setData({ replyingTo: null });
    }
  },

  async onToggleFollow() {
    if (this.data.socialLoading) return;
    // 取关时需要确认
    if (this.data.following) {
      wx.showModal({
        title: '取消关注',
        content: '确定要取消关注吗？',
        confirmColor: '#ef4444',
        success: async (res) => {
          if (!res.confirm) return;
          this.setData({ socialLoading: true });
          try {
            const following = await cloud.toggleFollow(this.data.myOpenid, this.data.targetOpenid);
            this.setData({ following, followedBy: false });
            wx.showToast({ title: '已取消关注', icon: 'success' });
          } catch (e) {
            wx.showToast({ title: e.message || '操作失败', icon: 'none' });
          } finally {
            this.setData({ socialLoading: false });
          }
        }
      });
      return;
    }
    this.setData({ socialLoading: true });
    try {
      const following = await cloud.toggleFollow(this.data.myOpenid, this.data.targetOpenid);
      this.setData({ following });
      wx.showToast({ title: '已关注', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: e.message || '操作失败', icon: 'none' });
    } finally {
      this.setData({ socialLoading: false });
    }
  },

  async onAddFriend() {
    if (this.data.socialLoading || ['friends', 'outgoing'].includes(this.data.friendStatus)) return;
    this.setData({ socialLoading: true });
    try {
      const friend = await cloud.sendFriendRequest(this.data.targetOpenid);
      this.setData({ friendStatus: friend.status, friendRequestId: friend.requestId || '' });
      wx.showToast({ title: friend.status === 'friends' ? '已成为好友' : '好友申请已发送', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: e.message || '发送失败', icon: 'none' });
    } finally {
      this.setData({ socialLoading: false });
    }
  },

  async onInviteTrip() {
    if (this.data.inviting) return;
    if (this.data.friendStatus !== 'friends') return wx.showToast({ title: '成为好友后才能邀请', icon: 'none' });
    this.setData({ inviting: true });
    try {
      const trips = await cloud.getInvitableTrips(this.data.targetOpenid);
      if (!trips.length) return wx.showToast({ title: '没有可邀请的行程', icon: 'none' });
      const action = await wx.showActionSheet({ itemList: trips.map(item => `${item.name}${item.city ? ` · ${item.city}` : ''}`) });
      const trip = trips[action.tapIndex];
      if (!trip) return;
      const result = await cloud.sendTripInvitation(this.data.targetOpenid, trip._id);
      if (result.alreadySent) return wx.showToast({ title: '邀请已发送过', icon: 'none' });
      const message = {
        ...result.message,
        isMine: true,
        formattedTime: cloud.formatDate(result.message.createdAt),
        readText: '未读',
        canRecall: true,
        invitationText: '等待确认'
      };
      // 更新轮询锚点与未读追踪
      if (message.createdAt && message.createdAt > (this._lastMessageCreatedAt || '')) {
        this._lastMessageCreatedAt = message.createdAt;
      }
      if (message._id && !message.readAt) {
        this._unreadMessageIds = [...(this._unreadMessageIds || []), message._id];
      }
      const messages = [...this.data.messages, message];
      const sentCount = messages.filter(m => m.isMine && m.type !== 'revoked').length;
      this.setData({ messages, sentCount, scrollIntoView: `msg-${messages.length - 1}` });
    } catch (e) {
      if (!String(e.errMsg || '').includes('cancel')) wx.showToast({ title: e.message || '邀请失败', icon: 'none' });
    } finally {
      this.setData({ inviting: false });
    }
  },

  async onRespondTripInvite(e) {
    const { messageId, accept } = e.currentTarget.dataset;
    const accepted = accept === true || accept === 'true';
    try {
      const result = await cloud.respondTripInvitation(messageId, accepted);
      const index = this.data.messages.findIndex(item => item._id === messageId);
      if (index >= 0) {
        this.setData({
          [`messages[${index}].invitationStatus`]: result.status,
          [`messages[${index}].invitationText`]: accepted ? '已加入' : '已拒绝'
        });
      }
      if (accepted) {
        const modal = await wx.showModal({ title: '已加入行程', content: '现在查看行程详情吗？' });
        if (modal.confirm) wx.navigateTo({ url: `/pages/trip-detail/trip-detail?tripId=${result.tripId}` });
      }
    } catch (err) {
      wx.showToast({ title: err.message || '操作失败', icon: 'none' });
    }
  },

  onOpenManage() {
    const { targetOpenid, targetUser } = this.data;
    const url = `/pages/chat-settings/chat-settings?openid=${encodeURIComponent(targetOpenid)}&nickName=${encodeURIComponent(targetUser.nickName || '')}&avatarUrl=${encodeURIComponent(targetUser.avatarUrl || '')}`;
    wx.navigateTo({ url });
    this.setData({ showTools: false, showEmoji: false });
  },

});
