const api = require('../../services/api.js');
const { fmtDate, fmtDateTime } = require('../../utils/date.js');
const { drawLineChart } = require('../../utils/chart.js');
const tap = require('../../utils/tap.js');

Page({
  data: {
    rows: [],
    events: [],
    hasData: false,
    selected: null,
    selectedEvents: [],
    showAddEvent: false,
    cycleOptions: [],
    cycleIds: [],
    cycleIdx: 0,
    scoreOptions: ['—', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
    prevIdx: 0,
    newIdx: 0,
    reason: '',
    cyclesTruncated: false,
    eventsTruncated: false,
  },

  onShow() {
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  async refresh() {
    try {
      const h = await api.getHistory();
      const rows = h.rows.map((r) => ({
        cycleId: r.cycleId,
        index: r.index,
        myScore: r.myScore,
        partnerScore: r.partnerScore,
        eventCount: h.events.filter((e) => e.cycleId === r.cycleId).length,
      }));
      const events = h.events.map((e) => Object.assign({}, e, { dateText: fmtDate(e.date) }));
      const cycleOptions = rows.map((r) => '第' + r.index + '期');
      const cycleIds = rows.map((r) => r.cycleId);
      if (h.activeCycle) {
        cycleOptions.push('第' + h.activeCycle.index + '期（进行中）');
        cycleIds.push(h.activeCycle.id);
      }
      this.setData({
        rows: rows,
        events: events,
        hasData: rows.length > 0,
        cycleOptions: cycleOptions,
        cycleIds: cycleIds,
        cycleIdx: cycleIds.length ? cycleIds.length - 1 : 0,
        cyclesTruncated: !!h.cyclesTruncated,
        eventsTruncated: !!h.eventsTruncated,
        selected: null,
        selectedEvents: [],
      });
      this.allEvents = h.events;
      if (rows.length) {
        wx.nextTick(() => this.draw(rows));
      }
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '加载失败', icon: 'none' });
    }
  },

  draw(rows) {
    const q = wx.createSelectorQuery().in(this);
    q.select('#chart')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) return;
        const node = res[0].node;
        const width = res[0].width;
        const height = res[0].height;
        const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
        const dpr = info.pixelRatio || 2;
        this.points = drawLineChart(node, width, height, dpr, rows, {
          me: '#FF6B81',
          partner: '#5B8DEF',
        });
      });
  },

  onChartTap(e) {
    if (!this.points || !this.points.length) return;
    const t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    const q = wx.createSelectorQuery().in(this);
    q.select('#chart').boundingClientRect((rect) => {
      if (!rect) return;
      const x = t.clientX != null ? t.clientX - rect.left : t.x - rect.left;
      let best = null;
      this.points.forEach((p) => {
        if (best === null || Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
      });
      if (!best) return;
      this.setData({
        selected: {
          index: best.index,
          cycleId: best.row.cycleId,
          myScore: best.row.myScore,
          partnerScore: best.row.partnerScore,
        },
        selectedEvents: this.allEvents
          .filter((ev) => ev.cycleId === best.row.cycleId)
          .map((ev) => Object.assign({}, ev, { dateText: fmtDateTime(ev.date) })),
      });
    }).exec();
  },

  toggleAddEvent() {
    this.setData({ showAddEvent: !this.data.showAddEvent });
  },

  onCyclePick(e) {
    this.setData({ cycleIdx: Number(e.detail.value) });
  },

  onPrevPick(e) {
    this.setData({ prevIdx: Number(e.detail.value) });
  },

  onNewPick(e) {
    this.setData({ newIdx: Number(e.detail.value) });
  },

  onReason(e) {
    this.setData({ reason: e.detail.value });
  },

  saveEvent() {
    tap.run('hist-event', async () => {
      const cycleId = this.data.cycleIds[this.data.cycleIdx];
      const prevScore = this.data.prevIdx > 0 ? this.data.prevIdx - 1 : null;
      const newScore = this.data.newIdx > 0 ? this.data.newIdx - 1 : null;
      try {
        await api.addEvent({ cycleId: cycleId, prevScore: prevScore, newScore: newScore, reason: this.data.reason });
        wx.showToast({ title: '已记录', icon: 'success' });
        this.setData({ reason: '', showAddEvent: false, prevIdx: 0, newIdx: 0 });
        this.refresh();
      } catch (e) {
        wx.showToast({ title: (e && e.message) || '保存失败', icon: 'none' });
      }
    });
  },

  onDeleteEvent(e) {
    const id = e.currentTarget.dataset.id;
    tap.run('hist-event-del', async () => {
      const confirmed = await new Promise((resolve) => {
        wx.showModal({
          title: '删除这个事件？',
          content: '删除后无法恢复',
          success: (r) => resolve(!!r.confirm),
          fail: () => resolve(false),
        });
      });
      if (!confirmed) return;
      try {
        await api.deleteEvent(id);
        wx.showToast({ title: '已删除', icon: 'success' });
        this.refresh();
      } catch (err) {
        wx.showToast({ title: (err && err.message) || '删除失败', icon: 'none' });
      }
    }, 300);
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/exchange/exchange?cycleId=' + e.currentTarget.dataset.id });
  },
});
