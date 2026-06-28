const theme = require('./utils/theme');

App({
  async onLaunch() {
    theme.syncAppTheme();

    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
      this.globalData.cloudReady = false;
      this.globalData.loginError = '基础库版本过低';
      return;
    }

    wx.cloud.init({
      env: 'cloud1-1ga9pk42512defdc',
      traceUser: true
    });

    this.globalData.cloudReady = true;
    this.checkCloudVersions();

    // --- Session 恢复：优先从持久 token 恢复登录态 ---
    const storedToken = wx.getStorageSync('_sessionToken') || '';
    const storedOpenid = wx.getStorageSync('_cachedAccountOpenid') || '';
    if (storedToken && storedOpenid) {
      try {
        const sessionRes = await wx.cloud.callFunction({
          name: 'accountOps',
          data: { action: 'validateSession', _sessionToken: storedToken }
        });
        if (sessionRes && sessionRes.result && sessionRes.result.success) {
          const u = sessionRes.result.user;
          this.globalData.openid = storedOpenid;
          this.globalData.sessionToken = storedToken;
          this.globalData.loggedIn = true;
          this.globalData.userInfo = {
            nickName: u.nickName || '',
            avatarUrl: u.avatarUrl || '',
            publicId: u.publicId || '',
            username: u.username || ''
          };
          this.globalData.accountType = u.username ? 'password' : 'wechat';
          this.globalData._launchComplete = true;
          this.startGlobalInboxWatch();
          this.startGlobalUnreadLoop();
          // 从云端拉取主题配置
          theme.loadThemeFromCloud().then(cloudConfig => {
            if (cloudConfig) theme.syncAppTheme(cloudConfig);
          }).catch(() => {});
          // session 恢复成功，跳过微信自动登录
          return;
        }
      } catch (_) {
        // 验证失败，清除过期 session，走微信登录
        wx.removeStorageSync('_sessionToken');
        wx.removeStorageSync('_cachedAccountOpenid');
      }
    }
    // --- Session 恢复结束 ---

    // 预获取 openid + 用户信息，确保后续页面可用
    try {
      const res = await wx.cloud.callFunction({ name: 'login' });
      if (res && res.result && res.result.openid) {
        this.globalData.openid = res.result.openid;
        this.globalData.loggedIn = true;
        this.startGlobalInboxWatch();
        this.startGlobalUnreadLoop();
        // 从云端拉取主题配置
        theme.loadThemeFromCloud().then(cloudConfig => {
          if (cloudConfig) theme.syncAppTheme(cloudConfig);
        }).catch(() => {});
        // 从云函数返回的用户信息恢复（不需要额外查库）
        if (res.result.nickName || res.result.avatarUrl || res.result.publicId) {
          this.globalData.userInfo = {
            nickName: res.result.nickName || '',
            avatarUrl: res.result.avatarUrl || '',
            publicId: res.result.publicId || '',
            username: res.result.username || ''
          };
          if (res.result.username) {
            this.globalData.accountType = 'password';
          }
        }
        // 新用户无资料 → 显示登录页
        const hasProfile = res.result.nickName && res.result.nickName.trim();
        const onboardingDone = wx.getStorageSync('onboarding_completed');
        if (!onboardingDone && !hasProfile) {
          this.globalData.needsOnboarding = true;
        }
      } else {
        this.globalData.loginError = '登录失败：未获取到用户标识';
      }
    } catch (e) {
      console.error('登录失败:', e);
      this.globalData.loginError = '登录失败，请检查网络后重试';
    }
    this.globalData._launchComplete = true;
  },

  onShow() {
    if (!this.globalData || !this.globalData._launchComplete || !this.globalData.loggedIn) return;
    this.startGlobalInboxWatch();
    this.startGlobalUnreadLoop();
  },

  onHide() {
    this.stopGlobalInboxWatch();
    this.stopGlobalUnreadLoop();
  },

  async checkCloudVersions() {
    const expected = {
      dbOps: '2026.06.27.3',
      momentOps: '2026.06.21.2',
      accountOps: '2026.06.21.3'
    };
    const names = ['dbOps', 'momentOps', 'accountOps'];
    try {
      const results = await Promise.all(names.map(name => wx.cloud.callFunction({
        name,
        data: { action: 'healthCheck', _sessionToken: wx.getStorageSync('_sessionToken') || '' }
      })));
      const versions = {};
      results.forEach((result, index) => { versions[names[index]] = result && result.result && result.result.version; });
      wx.setStorageSync('_cloudFunctionVersions', versions);
      const stale = names.filter(name => versions[name] !== expected[name]);
      if (stale.length) console.error(`云函数版本未同步: ${stale.join(', ')}`, { expected, versions });
    } catch (e) {
      console.warn('云函数版本检查失败:', e);
    }
  },

  globalData: {
    openid: '',
    cloudReady: true,
    loggedIn: false,
    loginError: '',
    needsOnboarding: false,
    accountType: 'wechat',
    userInfo: null,
    unreadCount: 0,
    _launchComplete: false,
    _currentChatOpenid: '',       // 当前正在查看的私信对象 openid
    _currentGroupId: '',          // 当前正在查看的群聊
    _newMsgNotify: null,           // 最新收到的私信通知
    _pendingNotify: null           // 挂起的通知（无 tab bar 时暂存）
  },

  /**
   * 启动全局私信监听（收到新消息时存入 globalData._newMsgNotify）
   */
  startGlobalInboxWatch() {
    const openid = this.globalData.openid;
    if (!openid) return;
    if (this._globalMsgWatcher) {
      try { this._globalMsgWatcher.close(); } catch (_) {}
    }
    const db = wx.cloud.database();
    this._globalMsgWatcher = db.collection('private_messages')
      .where({ to: openid })
      .watch({
        onChange: snapshot => {
          if (!snapshot.docChanges) return;
          for (const change of snapshot.docChanges) {
            if (change.queueType !== 'enqueue') continue; // 跳过初始化数据
            const msg = change.doc;
            if (!msg || msg.from === openid) continue;     // 跳过自己发的
            if (this.globalData._currentChatOpenid === msg.from) continue; // 正在看这个聊天
            this.preparePrivateMessageNotify(msg).then(notify => {
              if (!notify) return;
              this.globalData._newMsgNotify = notify;
              this.broadcastMessageNotify(notify);
            });
            this.refreshGlobalUnread();
          }
        },
        onError: err => {
          console.warn('全局消息监听中断:', err);
        }
      });
    this.startGlobalGroupInboxWatch();
    this.startGlobalInboxPoll();
  },

  startGlobalInboxPoll() {
    this.stopGlobalInboxPoll();
    const generation = (this._globalInboxPollGeneration || 0) + 1;
    this._globalInboxPollGeneration = generation;
    this._globalInboxPollCursor = '';
    const tick = async () => {
      if (generation !== this._globalInboxPollGeneration || !this.globalData.loggedIn) return;
      try {
        const result = await wx.cloud.callFunction({
          name: 'dbOps',
          data: {
            action: 'getLatestInboxEvents',
            payload: { after: this._globalInboxPollCursor || '' },
            _sessionToken: wx.getStorageSync('_sessionToken') || ''
          }
        });
        const payload = result && result.result && result.result.success ? result.result : null;
        if (payload) {
          const initialized = !!this._globalInboxPollCursor;
          this._globalInboxPollCursor = payload.serverNow || new Date().toISOString();
          if (initialized) {
            (payload.events || []).forEach(event => {
              if (event.kind === 'private') {
                const settings = wx.getStorageSync('_privateChatSettings') || {};
                if (this.globalData._currentChatOpenid === event.fromOpenid || (settings[event.fromOpenid] && settings[event.fromOpenid].muted)) return;
              }
              if (event.kind === 'group' && this.globalData._currentGroupId === event.groupId) return;
              this.broadcastMessageNotify(event);
            });
            if ((payload.events || []).length) this.refreshGlobalUnread();
          }
        }
      } catch (error) {
        console.warn('全局消息增量检查失败:', error);
      }
      if (generation === this._globalInboxPollGeneration) {
        this._globalInboxPollTimer = setTimeout(tick, 4000);
      }
    };
    tick();
  },

  stopGlobalInboxPoll() {
    this._globalInboxPollGeneration = (this._globalInboxPollGeneration || 0) + 1;
    if (this._globalInboxPollTimer) {
      clearTimeout(this._globalInboxPollTimer);
      this._globalInboxPollTimer = null;
    }
  },

  async preparePrivateMessageNotify(msg) {
    const settings = wx.getStorageSync('_privateChatSettings') || {};
    if (settings[msg.from] && settings[msg.from].muted === true) return null;
    let sender = this._messageUserCache && this._messageUserCache[msg.from];
    if (!sender) {
      try {
        const result = await wx.cloud.callFunction({
          name: 'dbOps',
          data: {
            action: 'batchGetUsers',
            payload: { openids: [msg.from] },
            _sessionToken: wx.getStorageSync('_sessionToken') || ''
          }
        });
        sender = result && result.result && result.result.users && result.result.users[msg.from];
        if (sender) this._messageUserCache = { ...(this._messageUserCache || {}), [msg.from]: sender };
      } catch (_) {}
    }
    const fromAvatarUrl = await this.resolveMessageAvatar((sender && sender.avatarUrl) || msg.fromAvatarUrl || '');
    return {
              id: msg._id,
              kind: 'private',
              fromOpenid: msg.from,
              fromNickName: (sender && sender.nickName) || msg.fromNickName || '新消息',
              fromAvatarUrl,
              previewText: this.messagePreview(msg)
    };
  },

  messagePreview(msg) {
    if (!msg) return '[消息]';
    if (msg.type === 'text') return String(msg.text || '').slice(0, 50);
    if (msg.type === 'image') return '[图片]';
    if (msg.type === 'voice') return `[语音] ${msg.voiceDuration || 1}秒`;
    if (msg.type === 'location') return `[位置] ${msg.locationName || ''}`;
    if (msg.type === 'file') return `[文件] ${msg.fileName || ''}`;
    if (msg.type === 'user_card') return `[名片] ${msg.cardName || ''}`;
    if (msg.type === 'moment_share') return '[动态分享]';
    if (msg.type === 'trip_invite') return `[行程邀请] ${msg.tripName || ''}`;
    return '[消息]';
  },

  async startGlobalGroupInboxWatch() {
    this.stopGlobalGroupInboxWatch();
    try {
      const result = await wx.cloud.callFunction({
        name: 'dbOps',
        data: { action: 'getGroupConversations', _sessionToken: wx.getStorageSync('_sessionToken') || '' }
      });
      const groups = result && result.result && result.result.groups || [];
      const activeGroups = groups.filter(group => !group.myNotificationsMuted);
      if (!activeGroups.length) return;
      const groupMap = {};
      activeGroups.forEach(group => { groupMap[group._id] = group; });
      const db = wx.cloud.database();
      const _ = db.command;
      this._globalGroupWatchers = [];
      for (let i = 0; i < activeGroups.length; i += 20) {
        const ids = activeGroups.slice(i, i + 20).map(group => group._id);
        const watcher = db.collection('group_messages').where({ groupId: _.in(ids) }).watch({
          onChange: snapshot => {
            (snapshot.docChanges || []).forEach(change => {
              if (change.queueType !== 'enqueue') return;
              const msg = change.doc;
              if (!msg || msg.from === this.globalData.openid || msg.groupId === this.globalData._currentGroupId) return;
              this.prepareGroupMessageNotify(msg, groupMap[msg.groupId]).then(notify => {
                if (notify) this.broadcastMessageNotify(notify);
              });
            });
          },
          onError: error => console.warn('全局群消息监听中断:', error)
        });
        this._globalGroupWatchers.push(watcher);
      }
    } catch (error) {
      console.warn('全局群消息监听启动失败:', error);
    }
  },

  async prepareGroupMessageNotify(msg, group) {
    let sender = this._messageUserCache && this._messageUserCache[msg.from];
    if (!sender) {
      try {
        const result = await wx.cloud.callFunction({
          name: 'dbOps',
          data: { action: 'batchGetUsers', payload: { openids: [msg.from] }, _sessionToken: wx.getStorageSync('_sessionToken') || '' }
        });
        sender = result && result.result && result.result.users && result.result.users[msg.from];
        if (sender) this._messageUserCache = { ...(this._messageUserCache || {}), [msg.from]: sender };
      } catch (_) {}
    }
    const senderName = (sender && sender.nickName) || '群成员';
    const fromAvatarUrl = await this.resolveMessageAvatar((sender && sender.avatarUrl) || '');
    return {
      id: msg._id,
      kind: 'group',
      groupId: msg.groupId,
      groupName: (group && group.name) || '群聊',
      title: (group && group.name) || '群聊',
      fromNickName: senderName,
      fromAvatarUrl,
      previewText: `${senderName}：${this.messagePreview(msg)}`
    };
  },

  async resolveMessageAvatar(url) {
    if (!url || !String(url).startsWith('cloud://')) return url || '';
    try {
      const result = await wx.cloud.callFunction({
        name: 'dbOps',
        data: {
          action: 'getTempUrls',
          payload: { fileList: [url] },
          _sessionToken: wx.getStorageSync('_sessionToken') || ''
        }
      });
      return result && result.result && result.result.urls && result.result.urls[url] || '';
    } catch (_) {
      return '';
    }
  },

  /** 清除全局消息监听 */
  stopGlobalInboxWatch() {
    if (this._globalMsgWatcher) {
      try { this._globalMsgWatcher.close(); } catch (_) {}
      this._globalMsgWatcher = null;
    }
    this.stopGlobalGroupInboxWatch();
    this.stopGlobalInboxPoll();
  },

  stopGlobalGroupInboxWatch() {
    (this._globalGroupWatchers || []).forEach(watcher => {
      try { watcher.close(); } catch (_) {}
    });
    this._globalGroupWatchers = [];
  },

  registerMessagePopup(popup) {
    if (!popup) return;
    if (!this._messagePopups) this._messagePopups = new Set();
    this._messagePopups.add(popup);
    const pending = this.globalData._pendingNotify;
    if (pending && popup.showMessage) {
      this.globalData._pendingNotify = null;
      popup.showMessage(pending);
    }
  },

  unregisterMessagePopup(popup) {
    if (this._messagePopups) this._messagePopups.delete(popup);
  },

  registerTabBar(tabBar) {
    if (!tabBar) return;
    if (!this._tabBars) this._tabBars = new Set();
    this._tabBars.add(tabBar);
    if (tabBar.setUnreadCount) tabBar.setUnreadCount(this.globalData.unreadCount || 0);
    if (tabBar.applyTheme) tabBar.applyTheme();
  },

  unregisterTabBar(tabBar) {
    if (this._tabBars) this._tabBars.delete(tabBar);
  },

  broadcastUnreadCount(count) {
    const unreadCount = Math.max(0, Number(count) || 0);
    this.globalData.unreadCount = unreadCount;
    if (!this._tabBars) return;
    this._tabBars.forEach(tabBar => {
      try { if (tabBar.setUnreadCount) tabBar.setUnreadCount(unreadCount); } catch (_) {}
    });
  },

  broadcastThemeChange() {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
    pages.forEach(page => {
      try { theme.applyToPage(page); } catch (_) {}
    });
    if (this._tabBars) {
      this._tabBars.forEach(tabBar => {
        try { if (tabBar.applyTheme) tabBar.applyTheme(); } catch (_) {}
      });
    }
  },

  broadcastMessageNotify(notify) {
    if (!notify) return;
    if (!this._seenMessageNotifyIds) this._seenMessageNotifyIds = new Set();
    if (notify.id && this._seenMessageNotifyIds.has(notify.id)) return;
    if (notify.id) {
      this._seenMessageNotifyIds.add(notify.id);
      if (this._seenMessageNotifyIds.size > 80) {
        const oldest = this._seenMessageNotifyIds.values().next().value;
        this._seenMessageNotifyIds.delete(oldest);
      }
    }
    if (this._messagePopups && this._messagePopups.size > 0) {
      let delivered = false;
      this._messagePopups.forEach(popup => {
        try {
          if ((!popup.isActive || popup.isActive()) && popup.showMessage) {
            popup.showMessage(notify);
            delivered = true;
          }
        } catch (_) {}
      });
      if (!delivered) this.globalData._pendingNotify = notify;
    } else {
      this.globalData._pendingNotify = notify;
    }
  },

  async refreshGlobalUnread() {
    if (this._refreshingGlobalUnread || !this.globalData.loggedIn) return;
    this._refreshingGlobalUnread = true;
    try {
      const result = await wx.cloud.callFunction({
        name: 'dbOps',
        data: {
          action: 'getUnreadSummary',
          _sessionToken: wx.getStorageSync('_sessionToken') || ''
        }
      });
      const summary = result && result.result && result.result.success ? result.result : {};
      this.broadcastUnreadCount(
        Number(summary.unreadMessages || 0) +
        Number(summary.unreadGroupMessages || 0) +
        Number(summary.pendingFriendRequests || 0) +
        Number(summary.unreadNotifications || 0)
      );
    } catch (error) {
      console.warn('刷新全局未读失败:', error);
    } finally {
      this._refreshingGlobalUnread = false;
    }
  },

  startGlobalUnreadLoop() {
    this.stopGlobalUnreadLoop();
    if (!this.globalData.loggedIn) return;
    this.refreshGlobalUnread();
    this._globalUnreadTimer = setInterval(() => this.refreshGlobalUnread(), 30000);
  },

  stopGlobalUnreadLoop() {
    if (this._globalUnreadTimer) {
      clearInterval(this._globalUnreadTimer);
      this._globalUnreadTimer = null;
    }
  }
});
