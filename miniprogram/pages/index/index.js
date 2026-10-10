const api = require('../../services/api.js');
const { fmtDate, fmtDateTime, progress, remainText, scoreEmoji } = require('../../utils/date.js');
const tap = require('../../utils/tap.js');
const { openingText } = require('../../utils/cycle-time.js');

// 小铃铛的静默轮询间隔：只在首页可见时进行，用一次轻量查询换「回复到了能马上看到」
const REPLY_POLL_MS = 20000;

Page({
  data: {
    loading: true,
    isMock: true,
    me: '',
    users: {},
    myName: '',
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
    // 小铃铛：伴侣对我记录的批注
    unreadCount: 0,
    replies: [],
    showReplies: false,
  },

  onShow() {
    this._hidden = false;
    if (!api.isMock && !api.isEnvConfigured()) {
      this.setData({ needSetup: true, pairNeeded: false, status: null, loading: false });
      return;
    }
    this.refresh();
  },

  onHide() {
    this._hidden = true;
    this.stopPolling();
    this.stopReplyPolling();
  },

  onUnload() {
    this._hidden = true;
    this.stopPolling();
    this.stopReplyPolling();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  // 等待绑定时每 15 秒刷新；请求锁避免慢网络下堆积。
  startPolling() {
    if (this.pollTimer || this._hidden) return;
    this.pollTimer = setInterval(() => {
      this.refresh();
    }, 15000);
  },

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  },

  // 已绑定后静默轮询未读回复，让「TA回复了你」能及时出现在小铃铛上
  startReplyPolling() {
    if (this.replyTimer || this._hidden) return;
    this.replyTimer = setInterval(() => {
      this.loadReplies();
    }, REPLY_POLL_MS);
  },

  stopReplyPolling() {
    if (this.replyTimer) {
      clearInterval(this.replyTimer);
      this.replyTimer = null;
    }
  },

  refresh() {
    if (this._refreshPromise) return this._refreshPromise;
    this._refreshPromise = this.refreshData().finally(() => { this._refreshPromise = null; });
    return this._refreshPromise;
  },

  async refreshData() {
    try {
      const s = await api.getAppStatus();
      if (this._hidden) return;
      if (s.bound === false) {
        // 已生成邀请但对方还没接受：pair 里只有自己
        this.startPolling();
        this.stopReplyPolling();
        this.setData({
          loading: false,
          needSetup: false,
          status: null,
          pairNeeded: true,
          pairNeededText: '对方还没有接受邀请。让TA打开你分享的微信卡片点「接受邀请」，绑定后这里就会开始第一期。',
          unreadCount: 0,
          replies: [],
          showReplies: false,
        });
        return;
      }
      this.stopPolling();
      if (s.cycle.status === 'exchanged') this.startPolling();
      this.setData({
        loading: false,
        needSetup: false,
        pairNeeded: false,
        pairNeededText: '',
        isMock: !!s.isMock,
        me: s.me,
        users: s.users,
        // 昵称提前算好：wxml 里直接写 users[me].name 在映射缺失时会渲染出错
        myName: s.users[s.me] ? s.users[s.me].name : '我',
        status: s,
        nextOpenText: openingText(s.cycle.nextOpenAt),
        startText: fmtDate(s.cycle.startDate),
        endText: fmtDate(s.cycle.endDate),
        progressPct: progress(s.cycle.startDate, s.cycle.endDate),
        remain: s.cycle.status === 'exchanged' ? '本期已交换' : remainText(s.cycle.endDate),
        emoji: s.myScore ? scoreEmoji(s.myScore.score) : '',
        hasLast: !!(s.lastExchanged && s.lastExchanged.id),
        lastIndex: s.lastExchanged ? s.lastExchanged.index : 0,
        exchangedCount: s.exchangedCount || 0,
      });
      this.s = s;
      this.startReplyPolling();
      await this.loadReplies();
    } catch (e) {
      const msg = (e && e.message) || '';
      this.setData({ loading: false, status: null });
      if (msg.indexOf('CLOUD_ENV_NOT_SET') >= 0) {
        this.stopPolling();
        this.stopReplyPolling();
        this.setData({ needSetup: true });
      } else if (msg.indexOf('配对') >= 0) {
        this.startPolling();
        this.stopReplyPolling();
        this.setData({
          pairNeeded: true,
          pairNeededText: '还没有绑定另一半。生成邀请码并通过微信发给TA，TA点开卡片一键绑定。',
        });
      } else {
        wx.showToast({ title: msg || '加载失败', icon: 'none' });
      }
    }
  },

  /* ---- 小铃铛：TA 批注了我的记录 ---- */

  loadReplies() {
    if (this._repliesPromise) return this._repliesPromise;
    this._repliesPromise = this.loadRepliesData().finally(() => { this._repliesPromise = null; });
    return this._repliesPromise;
  },

  async loadRepliesData() {
    try {
      const r = await api.getUnreadReplies();
      if (this._hidden) return;
      const items = (r.items || []).map((it) =>
        Object.assign({}, it, {
          timeText: fmtDateTime(it.createdAt),
          title: (it.cycleIndex ? '第' + it.cycleIndex + '期 · ' : '') + (it.authorName || 'TA') + ' 回复了你',
        })
      );
      this.setData({ replies: items, unreadCount: r.unreadCount || 0 });
    } catch (e) {
      // 铃铛是辅助功能：未配对/未配置等情况静默跳过，不弹错误打断首页
    }
  },

  toggleReplies() {
    if (this.data.showReplies) {
      this.setData({ showReplies: false });
      return;
    }
    this.setData({ showReplies: true });
    this.markRepliesRead();
  },

  closeReplies() {
    this.setData({ showReplies: false });
  },

  // 打开铃铛即视为已读：把「已展示的最新一条」上报给服务端，角标立即清零
  markRepliesRead() {
    const items = this.data.replies || [];
    const upTo = items.reduce((m, it) => Math.max(m, Number(it.createdAt) || 0), 0);
    if (!upTo || !this.data.unreadCount) return;
    this.setData({ unreadCount: 0 });
    try {
      const p = api.markRepliesRead(upTo);
      if (p && p.catch) p.catch(() => {});
    } catch (e) {
      /* 失败不影响本地展示，下次拉取会重新算未读 */
    }
  },

  // 点条目 → 跳到交换详情并定位到被回复的那条记录
  openReply(e) {
    const cycleId = e.currentTarget.dataset.cycle;
    const noteId = e.currentTarget.dataset.note;
    this.setData({ showReplies: false });
    tap.run(
      'nav-reply',
      () => {
        if (!cycleId) return;
        wx.navigateTo({ url: '/pages/exchange/exchange?cycleId=' + cycleId + '&noteId=' + noteId });
      },
      600
    );
  },

  onSwitchIdentity() {
    wx.showActionSheet({
      itemList: ['小A', '小B'],
      success: async (r) => {
        // setMe 返回 Promise（与 cloud 侧接口约定一致），这里统一用 await，
        // 原先写 .then() 在 setMe 返回字符串时会直接抛 TypeError
        try {
          await api.setMe(['userA', 'userB'][r.tapIndex]);
          this.refresh();
        } catch (e) {
          wx.showToast({ title: (e && e.message) || '切换失败', icon: 'none' });
        }
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
    if (this.data.status && this.data.status.cycle.status === 'exchanged') {
      wx.showToast({ title: '本期分数已锁定，请等待下一期', icon: 'none' });
      return;
    }
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
