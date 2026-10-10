const api = require('../services/api.js');
const { fmtDate, fmtDateTime } = require('./date.js');
const { drawLineChart } = require('./chart.js');
const tap = require('./tap.js');
const chartExport = require('./chart-export.js');

module.exports = function createHistoryPage(fullscreen = false) { return {
  data: {
    rows: [],
    exporting: false,
    exportImage: '',
    exportImages: [],
    exportIndex: 0,
    exportProgress: '',
    exportGalleryHeight: 180,
    savingImages: false,
    fullscreen,
    safeTop: 12,
    safeLeft: 16,
    safeRight: 16,
    safeBottom: 12,
    chartViewport: 300,
    chartContentWidth: 300,
    chartScrollLeft: 0,
    loadingHistory: false,
    hasMore: false,
    historyError: '',
    loadingEvents: false,
    eventCursor: null,
    eventError: '',
    pauses: [],
    giftActive: false,
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
    this._hidden = false;
    this.updateSafeArea();
    if (this.data.exportImage || this.data.selected && this.data.fullscreen) return;
    this.refresh();
  },

  onHide() { this._hidden = true; clearTimeout(this._drawTimer); this._drawTimer = null; clearTimeout(this._repaintTimer); clearTimeout(this._settleTimer); },
  onUnload() { this._hidden = true; this._historyVersion = (this._historyVersion || 0) + 1; clearTimeout(this._drawTimer); clearTimeout(this._repaintTimer); clearTimeout(this._settleTimer); },
  onResize() { this._chart = null; this.updateSafeArea(); if (this.data.exportImage) this.sizeExportPreview(); wx.nextTick(() => this.arrangeChart(false)); },
  updateSafeArea() {
    if (!this.data.fullscreen) return;
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const safe = info.safeArea || {};
    const menu = wx.getMenuButtonBoundingClientRect ? wx.getMenuButtonBoundingClientRect() : {};
    this.setData({ safeTop: Math.max(12, menu.bottom || info.statusBarHeight || 0) + 8,
      safeLeft: Math.max(16, safe.left || 0), safeRight: Math.max(16, info.screenWidth - (safe.right || info.screenWidth)),
      safeBottom: Math.max(12, info.screenHeight - (safe.bottom || info.screenHeight)) });
  },
  openFullscreen() { wx.navigateTo({ url: '/pages/history-fullscreen/history-fullscreen' }); },
  exitFullscreen() { wx.navigateBack(); },

  onGiftEffectChange(e) {
    this._chart = null;
    this.setData({ giftActive: !!e.detail.active });
    if (!e.detail.active && this.data.rows.length) wx.nextTick(() => this.draw(this.data.rows));
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  async refresh(older = false) {
    if (this._historyBusy) return;
    if (older && (!this.data.hasMore || !this._beforeIndex)) return;
    this._historyBusy = true;
    const version = this._historyVersion = (this._historyVersion || 0) + 1;
    this.setData({ loadingHistory: true, historyError: '' });
    try {
      const h = await api.getHistory(Object.assign({ pageSize: 21 }, older ? { beforeIndex: this._beforeIndex } : {}));
      if (version !== this._historyVersion || this._hidden) return;
      const oldLength = older ? this.data.rows.length : 0;
      const merged = older ? h.rows.concat(this._historyRows || []) : h.rows;
      h.rows = [...new Map(merged.map((r) => [r.cycleId, r])).values()].sort((a, b) => a.index - b.index);
      this._historyRows = h.rows;
      this._beforeIndex = h.nextBeforeIndex;
      const rows = h.rows.map((r) => ({
        cycleId: r.cycleId,
        index: r.index,
        myScore: r.myScore,
        partnerScore: r.partnerScore,
        gap: !!r.gap,
        eventCount: r.gap ? 0 : (r.eventCount === undefined ? h.events.filter((e) => e.cycleId === r.cycleId).length : r.eventCount),
      }));
      // 事件同样只保留展示需要的字段：作者只给昵称，不把 openid 带进页面数据
      const events = h.events.map((e) => {
        const mine = !!e.mine;
        return {
          id: e.id,
          cycleId: e.cycleId,
          cycleIndex: e.cycleIndex,
          prevScore: e.prevScore,
          newScore: e.newScore,
          reason: e.reason,
          date: e.date,
          createdAt: e.createdAt,
          mine: mine,
          authorName: (typeof e.authorName === 'string' && e.authorName) || (mine ? '我' : 'TA'),
          dateText: fmtDate(e.date),
        };
      });
      const cycleOptions = rows.filter((r) => !r.gap).map((r) => '第' + r.index + '期');
      const cycleIds = rows.filter((r) => !r.gap).map((r) => r.cycleId);
      if (h.activeCycle) {
        cycleOptions.push('第' + h.activeCycle.index + '期（进行中）');
        cycleIds.push(h.activeCycle.id);
      }
      this.setData({
        rows: rows,
        pauses: h.rows.filter((r) => r.gap).map((r) => ({ id: r.cycleId,
          text: '第' + r.index + '期中断 · ' + (r.pausedAt ? fmtDateTime(r.pausedAt) : '解绑时间未记录') + ' 至 ' + (r.resumedAt ? fmtDateTime(r.resumedAt) : '尚未恢复') })),
        hasData: rows.length > 0,
        cycleOptions: cycleOptions,
        cycleIds: cycleIds,
        cycleIdx: cycleIds.length ? cycleIds.length - 1 : 0,
        cyclesTruncated: !!h.cyclesTruncated,
        hasMore: !!h.hasMore,
        eventsTruncated: !!h.eventsTruncated,
        selected: null,
        selectedEvents: [],
        eventCursor: null,
        eventError: '',
      });
      this.allEvents = events;
      if (rows.length) {
        wx.nextTick(() => this.arrangeChart(!older, older ? rows.length - oldLength : 0));
      }
    } catch (e) {
      this._failedHistoryOlder = older;
      this.setData({ historyError: '加载失败，点击重试' });
      wx.showToast({ title: (e && e.message) || '加载失败', icon: 'none' });
    } finally {
      this._historyBusy = false;
      this.setData({ loadingHistory: false });
    }
  },

  loadOlder() { return this.refresh(true); },
  retryHistory() { return this.refresh(!!this._failedHistoryOlder); },
  arrangeChart(latest, added = 0) {
    const apply = (width) => {
      this._scrollVersion = (this._scrollVersion || 0) + 1;
      width = width || this.data.chartViewport;
      // 视口尺寸变化（转屏/分栏）时画布缓存失效，下次 draw 重新初始化
      if (this._chart && this._chart.width !== width) this._chart = null;
      // 左右各留 34px 对称边距（与 chart.js 的 padL 对齐）。
      // 旧预算右侧只有 20px，最后一期的期数标签/事件徽标会被画布右缘裁掉。
      this._step = this.data.fullscreen ? Math.max(56, (width - 68) / 10) : Math.max(38, (width - 68) / 6);
      const content = Math.max(width, 68 + Math.max(0, this.data.rows.length - 1) * this._step);
      this._scrollLeft = latest ? content - width : Math.min(content - width, (this._scrollLeft || 0) + added * this._step);
      this.setData({ chartViewport: width, chartContentWidth: content, chartScrollLeft: this._scrollLeft });
      wx.nextTick(() => this.draw(this.data.rows));
    };
    wx.createSelectorQuery().in(this).select('#chart-scroll').boundingClientRect((rect) => apply(rect && rect.width)).exec();
  },
  normaliseScroll(value) {
    const max = Math.max(0, this.data.chartContentWidth - this.data.chartViewport);
    const left = Math.min(max, Math.max(0, Number(value) || 0));
    if (left <= 1) return 0;
    return max - left <= 1 ? max : left;
  },
  syncChartScroll() {
    if (this._hidden) return;
    const version = this._scrollVersion;
    wx.createSelectorQuery().in(this).select('#chart-scroll').fields({ scrollOffset: true }).exec((res) => {
      if (this._hidden || version !== this._scrollVersion || !res || !res[0] || !Number.isFinite(res[0].scrollLeft)) return;
      this._lastNativeScroll = res[0].scrollLeft;
      this._scrollLeft = this.normaliseScroll(res[0].scrollLeft);
      this.draw(this.data.rows);
    });
  },
  onChartUpper() {
    this.syncChartScroll();
    return this.loadOlder();
  },
  onChartScroll(e) {
    this._scrollVersion = (this._scrollVersion || 0) + 1;
    this._lastNativeScroll = e.detail.scrollLeft || 0;
    this._scrollLeft = this.normaliseScroll(this._lastNativeScroll);
    clearTimeout(this._settleTimer);
    // 惯性滚动结束时读取原生位置，不再只用最后一次事件采样重画。
    this._settleTimer = setTimeout(() => this.syncChartScroll(), 100);
    if (this._drawTimer) return;
    this._drawTimer = setTimeout(() => { this._drawTimer = null; this.draw(this.data.rows); }, 16);
  },
  onChartTouchStart(e) {
    this._touchStart = e.touches && e.touches[0];
    this._touchScroll = this._scrollLeft || 0;
  },

  draw(rows) {
    if (this.data.giftActive || this.data.exportImage || this.data.fullscreen && this.data.selected || this._hidden) return;
    // 缓存画布节点：滚动重绘只做 clearRect + 窗口绘制，
    // 不再每次异步查询节点并重置画布（重新分配缓冲区是滑动掉帧的主因）。
    if (this._chart) {
      this._paint(this._chart, rows);
      return;
    }
    const q = wx.createSelectorQuery().in(this);
    q.select('#chart')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) return;
        const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
        const chart = {
          node: res[0].node,
          ctx: res[0].node.getContext('2d'),
          width: res[0].width,
          height: res[0].height,
          dpr: info.pixelRatio || 2,
        };
        chart.node.width = chart.width * chart.dpr;
        chart.node.height = chart.height * chart.dpr;
        chart.ctx.scale(chart.dpr, chart.dpr);
        this._chart = chart;
        this._paint(chart, rows);
      });
  },

  _paint(chart, rows) {
    if (this.data.giftActive || this.data.exportImage || this.data.fullscreen && this.data.selected || this._hidden) return;
    const step = this._step || Math.max(38, (chart.width - 68) / 6);
    const left = this._scrollLeft || 0;
    const start = Math.max(0, Math.floor(left / step) - 1);
    const visible = rows.slice(start, start + Math.ceil(chart.width / step) + 3);
    this.points = drawLineChart(chart.node, chart.width, chart.height, chart.dpr, visible, {
      me: '#FF6B81',
      partner: '#5B8DEF',
    }, { step, offset: start * step - left, skipResize: true });
  },

  async exportChart() {
    if (this.data.exporting || !this.data.rows.length) return;
    this.setData({ exporting: true, exportProgress: '正在读取全部历史…' });
    try {
      const rows = await chartExport.loadAll(api, () => !this._hidden);
      const images = await chartExport.generateAll(this, rows, (text) => this.setData({ exportProgress: text }), () => !this._hidden);
      if (!this._hidden && images.length) {
        this.setData({ exportImages: images, exportIndex: 0, exportImage: images[0].path });
        wx.nextTick(() => this.sizeExportPreview());
      }
    } catch (e) { if (!this._hidden) wx.showToast({ title: '完整图片生成失败，请重试', icon: 'none' }); }
    finally { this.setData({ exporting: false, exportProgress: '' }); }
  },
  closeExport() {
    this._chart = null;
    this.setData({ exportImage: '', exportImages: [], exportIndex: 0 });
    wx.nextTick(() => this.draw(this.data.rows));
  },
  stopExportTouch() {},
  sizeExportPreview() {
    const item = this.data.exportImages[this.data.exportIndex];
    if (!item) return;
    wx.createSelectorQuery().in(this).select('.export-gallery').boundingClientRect((rect) => {
      if (!rect || !this.data.exportImage || item !== this.data.exportImages[this.data.exportIndex]) return;
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      const windowHeight = info.windowHeight || info.screenHeight || 600;
      const maxHeight = Math.floor(Math.max(90, windowHeight <= 450
        ? Math.min(260, windowHeight - 76)
        : Math.min(windowHeight * .55, windowHeight - 210)));
      this.setData({ exportGalleryHeight: Math.min(maxHeight, Math.ceil(rect.width * item.height / item.width)) });
    }).exec();
  },
  onExportChange(e) {
    const index = e.detail.current;
    this.setData({ exportIndex: index, exportImage: this.data.exportImages[index].path });
    wx.nextTick(() => this.sizeExportPreview());
  },
  previewExport() { wx.previewImage({ urls: this.data.exportImages.map(i => i.path), current: this.data.exportImage }); },
  shareChartImage() { if (this.data.exportImage) chartExport.share(this.data.exportImage); },
  async saveChartImage() {
    if (!this.data.exportImage || this._savingImage) return;
    this._savingImage = true;
    this.setData({ savingImages: true });
    try {
      let count = 0;
      for (const image of this.data.exportImages) {
        if (!await chartExport.save(image.path)) break;
        count++;
      }
      if (count) wx.showToast({ title: '已保存 ' + count + ' 张图片', icon: 'none' });
    } finally { this._savingImage = false; this.setData({ savingImages: false }); }
  },
  closeEvent() {
    this._eventRequest = (this._eventRequest || 0) + 1;
    this._chart = null;
    this.setData({ selected: null, selectedEvents: [], loadingEvents: false });
    wx.nextTick(() => this.draw(this.data.rows));
  },
  onChartTap(e) {
    // 滚动事件的采样可能滞后于实际停止位置：抬手后补绘一次，保证边缘期数完整显示
    clearTimeout(this._repaintTimer);
    this._repaintTimer = setTimeout(() => this.syncChartScroll(), 160);
    if (!this.points || !this.points.length) return;
    const t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    if (this._touchStart && (Math.hypot(t.clientX - this._touchStart.clientX, t.clientY - this._touchStart.clientY) > 8 || Math.abs((this._scrollLeft || 0) - this._touchScroll) > 8)) return;
    const q = wx.createSelectorQuery().in(this);
    q.select('#chart').boundingClientRect((rect) => {
      if (!rect) return;
      const x = t.clientX != null ? t.clientX - rect.left : t.x;
      const y = t.clientY != null ? t.clientY - rect.top : t.y;
      let best = null;
      let bestDistance = Infinity;
      this.points.forEach((p) => {
        if (!p.event) return;
        const distance = Math.hypot(p.event.x - x, p.event.y - y);
        if (distance <= 16 && distance < bestDistance) {
          best = p;
          bestDistance = distance;
        }
      });
      if (!best) return;
      // 只有黄色数字附近可展开事件，再次点击同一期可收起。
      if (this.data.selected && this.data.selected.cycleId === best.row.cycleId) {
        this.setData({ selected: null, selectedEvents: [] });
        return;
      }
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
      this.loadSelectedEvents(true);
    }).exec();
  },

  async loadSelectedEvents(reset = false) {
    if (!this.data.selected) return;
    const id = this.data.selected.cycleId;
    if (!reset && (!this.data.eventCursor || this.data.loadingEvents)) return;
    const request = this._eventRequest = (this._eventRequest || 0) + 1;
    const cursor = reset ? null : this.data.eventCursor;
    this.setData({ loadingEvents: true, eventError: '' });
    try {
      const result = await api.getCycleEvents(Object.assign({ cycleId: id }, cursor ? { beforeId: cursor } : {}));
      if (this._hidden || request !== this._eventRequest || !this.data.selected || this.data.selected.cycleId !== id) return;
      const events = (reset ? [] : this.data.selectedEvents).concat(result.events.map((ev) => Object.assign({}, ev, { dateText: fmtDateTime(ev.date) })));
      this.setData({ selectedEvents: [...new Map(events.map((ev) => [ev.id, ev])).values()].sort((a, b) => a.date - b.date), eventCursor: result.nextBeforeId, eventsTruncated: false });
    } catch (e) {
      if (request === this._eventRequest) this.setData({ eventError: '事件加载失败，点击重试' });
    } finally {
      if (request === this._eventRequest) this.setData({ loadingEvents: false });
    }
  },
  loadMoreEvents() { return this.loadSelectedEvents(false); },
  retryEvents() { return this.loadSelectedEvents(true); },

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
}; };
