Component({
  data: {
    selected: 0,
    list: [
      { pagePath: '/pages/index/index', text: '行程', icon: '✦' },
      { pagePath: '/pages/ledger/ledger', text: '账本', icon: '◆' },
      { pagePath: '/pages/moments/moments', text: '动态', icon: '◈' },
      { pagePath: '/pages/profile/profile', text: '我的', icon: '◉' }
    ]
  },
  methods: {
    switchTab(e) {
      const idx = e.currentTarget.dataset.index;
      const item = this.data.list[idx];
      wx.switchTab({ url: item.pagePath });
    }
  }
});
