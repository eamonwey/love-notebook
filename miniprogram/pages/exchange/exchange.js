const api = require('../../services/api.js');
const { fmtDateTime } = require('../../utils/date.js');
const tap = require('../../utils/tap.js');
const exchangeShare = require('../../utils/exchange-share.js');
const { openingText } = require('../../utils/cycle-time.js');

Page({
  data: {
    status: null,
    detail: null,
    myName: '',
    reqFromName: '',
    expanded: {},
    annDraft: {},
    focusNoteId: '',
    fromShare: false,
  },

  onLoad(options) {
    this.setData({ fromShare: !!(options && options.from === 'exchange-share') });
    this.paramCycleId = options && options.cycleId;
    // 从首页小铃铛的回复条目跳进来：带上要定位的记录 id
    this.paramNoteId = options && options.noteId;
  },

  onShow() {
    this._hidden = false;
    this.refresh();
  },

  onHide() {
    this._hidden = true;
    this.stopPolling();
  },

  onUnload() {
    this._hidden = true;
    this.stopPolling();
    clearTimeout(this.focusTimer);
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  // 有待处理的交换请求时轮询刷新，及时看到对方同意/拒绝/撤回
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

  refresh() {
    if (this._refreshPromise) return this._refreshPromise;
    this._refreshPromise = this.refreshData().finally(() => { this._refreshPromise = null; });
    return this._refreshPromise;
  },

  async refreshData() {
    try {
      const result = await api.getExchangePage(this.paramCycleId);
      if (this._hidden) return;
      const s = result.status;
      const detail = result.detail ? this.decorate(result.detail) : null;

      this.setData({
        status: s,
        nextOpenText: openingText(s.cycle && s.cycle.nextOpenAt),
        myName: s.users[s.me] ? s.users[s.me].name : '我',
        // 提前算出请求发起人的昵称：wxml 里直接 status.users[from].name 在映射缺失时会取不到值
        reqFromName: s.exchangeRequest && s.users[s.exchangeRequest.from] ? s.users[s.exchangeRequest.from].name : 'TA',
        detail: detail,
      });
      if (s.exchangeRequest || (s.cycle && s.cycle.status === 'exchanged')) {
        this.startPolling();
      } else {
        this.stopPolling();
      }

      // 从小铃铛跳进来：展开并滚动到被回复的那条记录（只在本次带参数时做一次）
      const focusId = this.paramNoteId;
      const canFocus = !!(focusId && detail && (detail.notes || []).some((n) => n.id === focusId));
      if (canFocus) {
        const patch = { focusNoteId: focusId };
        patch['expanded.' + focusId] = true;
        this.setData(patch);
      }
      this.paramNoteId = null;
      if (canFocus) {
        wx.nextTick(() => setTimeout(() => this.scrollToNote(focusId), 120));
      }
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '加载失败', icon: 'none' });
    }
  },

  // 滚动到目标记录并高亮一会儿（pageScrollTo 的 selector 需要基础库 2.7.3+）
  scrollToNote(noteId) {
    wx.pageScrollTo({ selector: '#note-' + noteId, duration: 300, fail: () => {} });
    clearTimeout(this.focusTimer);
    this.focusTimer = setTimeout(() => this.setData({ focusNoteId: '' }), 2500);
  },

  // 整理展示数据。
  // 关键约定：记录与批注的作者只保留「昵称」这一个字段——即使后端多返回了 openid，
  // 这里也不会带进页面数据，界面因此不可能渲染出作者的 id；
  // 昵称拿不到时退化为「我 / TA」。
  decorate(d) {
    const authorName = (o, mine) => {
      const name = typeof o.authorName === 'string' && o.authorName ? o.authorName : '';
      return name || (mine ? '我' : 'TA');
    };
    const decorateAnn = (a) => ({
      id: a.id,
      content: a.content,
      createdAt: a.createdAt,
      timeText: fmtDateTime(a.createdAt),
      mine: !!a.mine,
      authorName: authorName(a, !!a.mine),
    });
    d.exchangedText = d.exchangedAt ? fmtDateTime(d.exchangedAt) : '';
    d.notes = (d.notes || []).map((n) => ({
      id: n.id,
      type: n.type,
      content: n.content,
      createdAt: n.createdAt,
      timeText: fmtDateTime(n.createdAt),
      mine: !!n.mine,
      authorName: authorName(n, !!n.mine),
      annotations: (n.annotations || []).map(decorateAnn),
    }));
    return d;
  },

  /* ---- 交换请求（唯一的交换入口：一方发起，对方同意） ---- */
  onRequestExchange() {
    tap.run('ex-request', async () => {
      // 前置校验：自己没完成本期打分就不能发起（服务端同样校验，这里先给出清晰提示）
      if (this.data.status && this.data.status.cycle && this.data.status.cycle.status === 'exchanged') {
        wx.showToast({ title: '本期已交换，请等待次日0点', icon: 'none' });
        return;
      }
      if (!this.data.status || !this.data.status.myScore) {
        wx.showToast({ title: '先完成本期打分，再发起交换请求', icon: 'none' });
        return;
      }
      try {
        await api.requestExchange();
        wx.showToast({ title: '请求已发给TA', icon: 'success' });
        await this.refresh();
      } catch (e) {
        wx.showToast({ title: e.message, icon: 'none' });
      }
    });
  },

  onCancelRequest() {
    tap.run('ex-cancel', async () => {
      try {
        await api.cancelExchangeRequest();
        await this.refresh();
      } catch (e) {
        wx.showToast({ title: e.message, icon: 'none' });
      }
    }, 300);
  },

  onAgreeExchange() {
    tap.run('ex-agree', async () => {
      // 前置校验：双方未打分时直接给出清晰提示，避免用户走完确认弹窗再被服务端打回
      if (!this.data.status || !this.data.status.bothScored) {
        wx.showToast({ title: '双方都完成打分后才能交换', icon: 'none' });
        return;
      }
      const confirmed = await new Promise((resolve) => {
        wx.showModal({
          title: '同意交换',
          content: '交换后双方都能看到对方本期的分数、留言和笔记，确定吗？',
          success: (r) => resolve(!!r.confirm),
          fail: () => resolve(false),
        });
      });
      if (!confirmed) return;
      try {
        const res = await api.agreeExchange();
        wx.showToast({ title: '交换成功', icon: 'success' });
        this.paramCycleId = res.exchangedCycleId;
        await this.refresh();
      } catch (e) {
        wx.showToast({ title: e.message, icon: 'none' });
      }
    }, 300);
  },

  onDeclineRequest() {
    tap.run('ex-decline', async () => {
      try {
        await api.cancelExchangeRequest();
        await this.refresh();
      } catch (e) {
        wx.showToast({ title: e.message, icon: 'none' });
      }
    }, 300);
  },

  /* ---- 笔记展开与批注 ---- */
  onDeleteNote(e) {
    this.deleteContent(e.currentTarget.dataset.id);
  },

  onDeleteAnnotation(e) {
    const data = e.currentTarget.dataset;
    this.deleteContent(data.id, data.annotationId);
  },

  deleteContent(noteId, annotationId) {
    const note = this.data.detail && this.data.detail.notes.find((n) => n.id === noteId);
    const target = annotationId && note ? note.annotations.find((a) => a.id === annotationId) : note;
    if (!target || !target.mine) return;
    tap.run('ex-delete', async () => {
      const confirmed = await new Promise((resolve) => {
        wx.showModal({
          title: annotationId ? '删除这条批注？' : '删除这条笔记？',
          content: annotationId ? '删除后无法恢复，对方已读过的内容无法撤回。' : '删除后无法恢复，该笔记下双方的批注也会一起删除。',
          confirmText: '删除',
          confirmColor: '#d9534f',
          success: (r) => resolve(!!r.confirm),
          fail: () => resolve(false),
        });
      });
      if (!confirmed) return;
      try {
        if (annotationId) await api.deleteAnnotation({ noteId: noteId, annotationId: annotationId });
        else await api.deleteNote(noteId);
        // 先等删除前的读取结束，再强制读取新状态，避免复用旧请求。
        if (this._refreshPromise) await this._refreshPromise;
        await this.refresh();
        wx.showToast({ title: '已删除', icon: 'success' });
      } catch (err) {
        wx.showToast({ title: (err && err.message) || '删除失败，请重试', icon: 'none' });
      }
    }, 300);
  },

  toggleNote(e) {
    const id = e.currentTarget.dataset.id;
    const cur = this.data.expanded[id];
    this.setData({ ['expanded.' + id]: !cur });
  },

  onAnnInput(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ ['annDraft.' + id]: e.detail.value });
  },

  submitAnn(e) {
    const id = e.currentTarget.dataset.id;
    const content = (this.data.annDraft[id] || '').trim();
    if (!content) {
      wx.showToast({ title: '先写点批注内容', icon: 'none' });
      return;
    }
    tap.run('ex-ann', async () => {
      try {
        await api.annotate({ noteId: id, content: content });
        this.setData({ ['annDraft.' + id]: '' });
        await this.refresh();
        this.setData({ ['expanded.' + id]: true });
        wx.showToast({ title: '已批注', icon: 'success' });
      } catch (err) {
        wx.showToast({ title: (err && err.message) || '批注失败', icon: 'none' });
      }
    });
  },

  goScore() {
    tap.run('nav-score', () => wx.navigateTo({ url: '/pages/score/score' }), 600);
  },

  onShareAppMessage() {
    const s = this.data.status;
    return exchangeShare(s && s.cycle && s.cycle.index, !!(s && s.cycle && s.cycle.status === 'active' && s.myScore));
  },

  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },
});
