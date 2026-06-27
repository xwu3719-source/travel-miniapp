Component({
  data: {
    visible: false,
    message: null,
    lastMessageId: ''
  },

  lifetimes: {
    attached() {
      const pages = getCurrentPages();
      this._ownerRoute = pages.length ? pages[pages.length - 1].route : '';
      const app = getApp();
      if (app && app.registerMessagePopup) app.registerMessagePopup(this);
    },

    detached() {
      const app = getApp();
      if (app && app.unregisterMessagePopup) app.unregisterMessagePopup(this);
      this.dismiss();
    }
  },

  methods: {
    isActive() {
      const pages = getCurrentPages();
      const currentRoute = pages.length ? pages[pages.length - 1].route : '';
      return !this._ownerRoute || this._ownerRoute === currentRoute;
    },

    showMessage(notify) {
      if (!notify || !notify.id || notify.id === this.data.lastMessageId) return;
      if (this._dismissTimer) clearTimeout(this._dismissTimer);
      this.setData({
        visible: true,
        lastMessageId: notify.id,
        message: {
          ...notify,
          title: notify.title || notify.fromNickName || '新消息',
          initials: String(notify.title || notify.fromNickName || '?').slice(0, 1)
        }
      });
      try { wx.vibrateShort({ type: 'light' }); } catch (_) {}
      this._dismissTimer = setTimeout(() => this.dismiss(), 4500);
    },

    dismiss() {
      if (this._dismissTimer) {
        clearTimeout(this._dismissTimer);
        this._dismissTimer = null;
      }
      if (this.data.visible) this.setData({ visible: false });
    },

    onClose() {
      this.dismiss();
    },

    onOpen() {
      const item = this.data.message;
      if (!item) return;
      this.dismiss();
      if (item.kind === 'group' && item.groupId) {
        wx.navigateTo({
          url: `/pages/group-chat/group-chat?groupId=${encodeURIComponent(item.groupId)}&name=${encodeURIComponent(item.groupName || '群聊')}`
        });
        return;
      }
      if (item.fromOpenid) {
        wx.navigateTo({
          url: `/pages/private-chat/private-chat?openid=${encodeURIComponent(item.fromOpenid)}&nickName=${encodeURIComponent(item.fromNickName || '')}&avatarUrl=${encodeURIComponent(item.fromAvatarUrl || '')}`
        });
      }
    }
  }
});
