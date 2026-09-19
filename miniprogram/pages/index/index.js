const api = require('../../services/api.js');
const { fmtDate, progress, remainText, scoreEmoji } = require('../../utils/date.js');
const tap = require('../../utils/tap.js');

Page({
  data: {
    loading: true,
    isMock: true,
    me: '',
    users: {},
    status: null,
    startText: '',
    endText: '',
    progressPct: 0,
    remain: '',
    emoji: '',
    hasLast: false,
    lastIndex: 0,
    exchangedCount: 0,
    needSetup: false,
    pairNeeded: false,
    pairNeededText: '',
  },

  onShow() {
    if (!api.isMock && !api.isEnvConfigured()) {
      this.setData({ needSetup: true, pairNeeded: false, status: null, loading: false });
      return;
    }
    this.refresh();
  },

  onHide() {
    this.stopPolling();
  },

  onUnload() {
    this.stopPolling();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  // 等待对方接受邀请/绑定期间，每 5 秒自动刷新一次首页状态
  startPolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      this.refresh();
    }, 5000);
  },

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  },

  async refresh() {
    try {
      const s = await api.getAppStatus();
      if (s.bound === false) {
        // 已生成邀请但对方还没接受：pair 里只有自己
        this.startPolling();
        this.setData({
          loading: false,
          needSetup: false,
          status: null,
          pairNeeded: true,
          pairNeededText: '对方还没有接受邀请。让TA打开你分享的微信卡片点「接受邀请」，绑定后这里就会开始第一期。',
        });
        return;
      }
      this.stopPolling();
      this.setData({
        loading: false,
        needSetup: false,
        pairNeeded: false,
        pairNeededText: '',
        isMock: !!s.isMock,
        me: s.me,
        users: s.users,
        status: s,
        startText: fmtDate(s.cycle.startDate),
        endText: fmtDate(s.cycle.endDate),
        progressPct: progress(s.cycle.startDate, s.cycle.endDate),
        remain: remainText(s.cycle.endDate),
        emoji: s.myScore ? scoreEmoji(s.myScore.score) : '',
        hasLast: !!(s.lastExchanged && s.lastExchanged.id),
        lastIndex: s.lastExchanged ? s.lastExchanged.index : 0,
        exchangedCount: s.exchangedCount || 0,
      });
      this.s = s;
    } catch (e) {
      const msg = (e && e.message) || '';
      this.setData({ loading: false, status: null });
      if (msg.indexOf('CLOUD_ENV_NOT_SET') >= 0) {
        this.stopPolling();
        this.setData({ needSetup: true });
      } else if (msg.indexOf('配对') >= 0) {
        this.startPolling();
        this.setData({
          pairNeeded: true,
          pairNeededText: '还没有绑定另一半。生成邀请码并通过微信发给TA，TA点开卡片一键绑定。',
        });
      } else {
        wx.showToast({ title: msg || '加载失败', icon: 'none' });
      }
    }
  },

  onSwitchIdentity() {
    wx.showActionSheet({
      itemList: ['小A', '小B'],
      success: (r) => {
        api
          .setMe(['userA', 'userB'][r.tapIndex])
          .then(() => this.refresh())
          .catch((e) => wx.showToast({ title: e.message, icon: 'none' }));
      },
    });
  },

  goSetup() {
    tap.run('nav-setup', () => wx.navigateTo({ url: '/pages/setup/setup' }), 600);
  },

  goPair() {
    tap.run('nav-pair', () => wx.navigateTo({ url: '/pages/pair/pair' }), 600);
  },

  goScore() {
    tap.run('nav-score', () => wx.navigateTo({ url: '/pages/score/score' }), 600);
  },

  goExchange() {
    tap.run('nav-exchange', () => wx.navigateTo({ url: '/pages/exchange/exchange' }), 600);
  },

  goLastDetail() {
    if (this.s && this.s.lastExchanged) {
      tap.run('nav-last', () => wx.navigateTo({ url: '/pages/exchange/exchange?cycleId=' + this.s.lastExchanged.id }), 600);
    }
  },

  goCycleList() {
    tap.run('nav-cyclelist', () => wx.navigateTo({ url: '/pages/cycle-list/cycle-list' }), 600);
  },

  goNotes() {
    wx.switchTab({ url: '/pages/notes/notes' });
  },

  goHistory() {
    wx.switchTab({ url: '/pages/history/history' });
  },

  quickAdd(e) {
    wx.navigateTo({ url: '/pages/note-edit/note-edit?type=' + e.currentTarget.dataset.type });
  },
});
