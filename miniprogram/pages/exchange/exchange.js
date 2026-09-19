const api = require('../../services/api.js');
const { fmtDateTime } = require('../../utils/date.js');
const { ensureSubscribe } = require('../../utils/notify.js');
const tap = require('../../utils/tap.js');

Page({
  data: {
    status: null,
    detail: null,
    myName: '',
    expanded: {},
    annDraft: {},
    planCols: [],
    planIdx: [0, 20],
    planText: '',
    planRemain: '',
  },

  onLoad(options) {
    this.paramCycleId = options && options.cycleId;
  },

  onShow() {
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

  // 有待处理的交换请求时轮询刷新，及时看到对方同意/拒绝/撤回
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
      const targetId = this.paramCycleId || (s.lastExchanged && s.lastExchanged.id);
      let detail = null;
      if (targetId) {
        detail = this.decorate(await api.getCycleDetail(targetId));
      }

      // 滚筒选择列：天数列随周期长度变化，小时列固定 0-23 点
      const days = [];
      for (let i = 1; i <= s.pair.cycleDays; i++) days.push('第' + i + '天');
      const hours = [];
      for (let i = 0; i <= 23; i++) hours.push(i + '点');
      let planText = '';
      let planRemain = '';
      const plan = s.exchangePlan;
      if (plan) {
        planText = '第' + plan.day + '天 ' + plan.hour + '点';
        if (plan.time > Date.now()) {
          const left = plan.time - Date.now();
          const d = Math.floor(left / 86400000);
          const h = Math.floor((left % 86400000) / 3600000);
          planRemain = d > 0 ? '还有 ' + d + ' 天 ' + h + ' 小时' : '还有 ' + h + ' 小时';
        } else {
          planRemain = '时间已到，快去交换吧';
        }
      }

      this.setData({
        status: s,
        myName: s.users[s.me].name,
        detail: detail,
        planCols: [days, hours],
        planText: planText,
        planRemain: planRemain,
      });
      if (s.exchangeRequest) {
        this.startPolling();
      } else {
        this.stopPolling();
      }
      this.paramCycleId = null;
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '加载失败', icon: 'none' });
    }
  },

  decorate(d) {
    d.exchangedText = d.exchangedAt ? fmtDateTime(d.exchangedAt) : '';
    d.notes = (d.notes || []).map((n) => Object.assign({}, n, { timeText: fmtDateTime(n.createdAt) }));
    return d;
  },

  /* ---- 交换请求（唯一的交换入口：一方发起，对方同意） ---- */
  onRequestExchange() {
    tap.run('ex-request', async () => {
      ensureSubscribe();
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
      ensureSubscribe();
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

  /* ---- 约定交换时间（滚筒：第几天 × 几点） ---- */
  onPlanChange(e) {
    tap.run('ex-plan', async () => {
      ensureSubscribe();
      const idx = e.detail.value;
      const day = idx[0] + 1;
      const hour = idx[1];
      try {
        await api.setExchangePlan({ day: day, hour: hour });
        wx.showToast({ title: '已约定', icon: 'success' });
        await this.refresh();
      } catch (err) {
        wx.showToast({ title: err.message, icon: 'none' });
      }
    });
  },

  onCancelPlan() {
    tap.run('ex-plan-cancel', async () => {
      try {
        await api.clearExchangePlan();
        await this.refresh();
      } catch (e) {
        wx.showToast({ title: e.message, icon: 'none' });
      }
    }, 300);
  },

  /* ---- 笔记展开与批注 ---- */
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
});
