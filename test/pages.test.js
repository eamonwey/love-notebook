/**
 * 页面级冒烟测试（纯 Node）：桩掉 wx / Page，把 services/api.js 指向 mock 后端，
 * 直接调用页面的生命周期与事件处理函数，锁住几处前端修复：
 *   1. 首页切换演示身份不再抛 TypeError（setMe 已统一返回 Promise）
 *   2. 首页昵称用算好的 myName 字段渲染
 *   3. 交换页：未双方打分时「同意交换」被前置拦截，不再走确认弹窗后被服务端打回
 *   4. 交换页：请求发起人昵称用 reqFromName
 *   5. 记一笔：草稿只恢复内容，类型以本次入口为准
 *   6. 伴侣页：畸形分享码不会再让 onLoad 抛 URIError
 *
 * 运行：node test/pages.test.js
 */
const assert = require('assert');
const path = require('path');
const Module = require('module');

/* ================= wx / Page 桩 ================= */

const store = {};
let modalOpened = 0;
let toastText = '';
const navUrls = [];
const scrollCalls = [];

global.wx = {
  getStorageSync: (k) => store[k],
  setStorageSync: (k, v) => {
    store[k] = v;
  },
  removeStorageSync: (k) => {
    delete store[k];
  },
  showToast: (o) => {
    toastText = (o && o.title) || '';
  },
  showModal: (o) => {
    modalOpened++;
    if (o && o.success) o.success({ confirm: true });
  },
  showActionSheet: (o) => {
    if (o && o.success) o.success({ tapIndex: 1 });
  },
  navigateTo: (o) => {
    navUrls.push(o && o.url);
  },
  navigateBack: () => {},
  pageScrollTo: (o) => {
    scrollCalls.push(o || {});
  },
  reLaunch: () => {},
  switchTab: () => {},
  stopPullDownRefresh: () => {},
  setClipboardData: () => {},
  requestSubscribeMessage: () => {},
  nextTick: (fn) => fn(),
  createSelectorQuery: () => ({
    in() {
      return this;
    },
    select() {
      return this;
    },
    fields() {
      return this;
    },
    boundingClientRect() {
      return this;
    },
    exec() {},
  }),
};

let capturedPage = null;
global.Page = (obj) => {
  capturedPage = obj;
};

const mockApi = require(path.join(__dirname, '..', 'miniprogram', 'services', 'mock.js'));

const origLoad = Module._load;
Module._load = function (request) {
  if (/services[\\/]api\.js$/.test(request)) return mockApi;
  return origLoad.apply(this, arguments);
};

/* ================= 加载辅助 ================= */

function loadPage(rel) {
  const file = path.join(__dirname, '..', 'miniprogram', 'pages', rel);
  delete require.cache[require.resolve(file)];
  capturedPage = null;
  require(file);
  assert.ok(capturedPage, '页面未注册: ' + rel);
  const inst = Object.assign({}, capturedPage);
  inst.data = JSON.parse(JSON.stringify(capturedPage.data || {}));
  inst.setData = function (patch) {
    Object.keys(patch).forEach((k) => {
      if (k.indexOf('.') < 0) {
        inst.data[k] = patch[k];
        return;
      }
      // 支持 'expanded.<id>' 这类路径写法（交换页展开指定记录时会用到）
      const ks = k.split('.');
      let o = inst.data;
      for (let i = 0; i < ks.length - 1; i++) {
        if (!o[ks[i]] || typeof o[ks[i]] !== 'object') o[ks[i]] = {};
        o = o[ks[i]];
      }
      o[ks[ks.length - 1]] = patch[k];
    });
  };
  return inst;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
function ok(label) {
  passed++;
  console.log('  ✓ ' + label);
}

(async () => {
  await mockApi.resetMock();

  console.log('页面：首页');

  const index = loadPage(path.join('index', 'index.js'));
  await index.refresh();
  const pending1 = index.refresh();
  const pending2 = index.refresh();
  assert.strictEqual(pending1, pending2, '重复刷新必须复用同一进行中的请求');
  await pending1;
  assert.strictEqual(index.data.pairNeeded, false);
  assert.strictEqual(index.data.myName, '小A', '应提前算好 myName 供 wxml 使用');
  assert.ok(index.data.status && index.data.status.cycle.index === 1);
  ok('首页刷新拿到状态，昵称字段 myName 已算好（wxml 不再直接索引 users[me].name）');

  // 演示身份切换：旧实现 setMe 返回字符串却调 .then()，会抛 TypeError 且不刷新
  await index.onSwitchIdentity();
  await sleep(30);
  assert.strictEqual(store['LOVE_MOCK_ME'], 'userB', '切换后本地身份应更新');
  assert.strictEqual(index.data.myName, '小B', '切换身份后应完成刷新');
  await mockApi.setMe('userA');
  ok('首页切换演示身份不再抛异常，且切换后立即刷新');

  console.log('页面：交换中心');

  const ex = loadPage(path.join('exchange', 'exchange.js'));
  ex.onLoad({});
  await ex.refresh();
  const exPending = ex.refresh();
  assert.strictEqual(exPending, ex.refresh(), '交换页重复刷新必须复用请求');
  ex.onHide();
  await exPending;
  assert.ok(!ex.pollTimer, '隐藏页面后不能被在途响应重新启动轮询');
  ex._hidden = false;
  assert.strictEqual(ex.data.status.bothScored, false);
  assert.strictEqual(ex.data.reqFromName, 'TA');

  // 自己没打分时不能发起交换请求（服务端也会拒，这里先给出提示且不发请求）
  assert.strictEqual(ex.data.status.myScore, null);
  ex.onRequestExchange();
  await sleep(40);
  assert.strictEqual(toastText, '先完成本期打分，再发起交换请求');
  assert.strictEqual((await mockApi.getAppStatus()).exchangeRequest, null, '未打分时不该写入交换请求');
  ok('自己未完成打分时，发起交换请求被前置拦截');

  modalOpened = 0;
  ex.onAgreeExchange();
  await sleep(40);
  assert.strictEqual(modalOpened, 0, '未双方打分时不该弹确认框');
  assert.strictEqual(toastText, '双方都完成打分后才能交换');
  ok('未双方打分时「同意交换」被前置拦截，给出明确提示');

  // 双方打分 + 对方发起请求 → 横幅显示对方昵称
  await mockApi.submitScore({ score: 8, comment: '这周很甜' });
  await mockApi.setMe('userB');
  await mockApi.submitScore({ score: 7, comment: '还行' });
  await mockApi.requestExchange();
  await mockApi.setMe('userA');
  await ex.refresh();
  assert.strictEqual(ex.data.status.bothScored, true);
  assert.strictEqual(ex.data.reqFromName, '小B');
  ok('请求横幅用 reqFromName 显示发起人昵称');

  console.log('页面：记一笔');

  store['LOVE_NOTE_DRAFT'] = { type: 'happy', content: '上次没保存成功的内容' };
  const noteEdit = loadPage(path.join('note-edit', 'note-edit.js'));
  noteEdit.onLoad({ type: 'unhappy' });
  assert.strictEqual(noteEdit.data.type, 'unhappy', '类型应以本次入口为准');
  assert.strictEqual(noteEdit.data.content, '上次没保存成功的内容', '内容应从草稿恢复');
  noteEdit.onLoad({});
  assert.strictEqual(noteEdit.data.type, 'happy', '没有入口参数时沿用草稿里的类型');
  ok('草稿只恢复内容，类型以入口参数优先');

  store['LOVE_NOTE_DRAFT'] = { type: 'happy', content: '过期隐私草稿', savedAt: Date.now() - 8 * 86400000 };
  const expiredDraftPage = loadPage(path.join('note-edit', 'note-edit.js'));
  expiredDraftPage.onLoad({});
  assert.strictEqual(expiredDraftPage.data.content, '');
  assert.strictEqual(store['LOVE_NOTE_DRAFT'], undefined);
  ok('本地私密草稿超过 7 天后自动清除');

  console.log('页面：伴侣邀请');

  const pair = loadPage(path.join('pair', 'pair.js'));
  let threw = null;
  try {
    pair.onLoad({ invite: 'AB%' }); // 畸形转义：旧实现 decodeURIComponent 会抛 URIError
  } catch (e) {
    threw = e;
  }
  assert.strictEqual(threw, null, 'onLoad 不该抛异常');
  await sleep(30);
  assert.ok(pair.data.mode === 'confirm', '应进入接受邀请视图（演示模式下展示后端返回的提示）');
  ok('畸形分享码不再让 onLoad 崩溃');

  console.log('页面：首页小铃铛（TA 回复了我的记录）');

  // 造场景：第 1 期双方打分 → 交换 → B 批注 A 的记录
  await mockApi.resetMock();
  await mockApi.setMe('userA');
  await mockApi.submitScore({ score: 8, comment: '' });
  await mockApi.addNote({ type: 'unhappy', content: '这周你老是打游戏' });
  await mockApi.requestExchange();
  await mockApi.setMe('userB');
  await mockApi.submitScore({ score: 7, comment: '' });
  await mockApi.agreeExchange();
  const hist = await mockApi.getHistory();
  const cycledId = hist.rows[0].cycleId;
  const detail1 = await mockApi.getCycleDetail(cycledId);
  const myNote = detail1.notes.filter((n) => n.authorName === '小A')[0];
  await mockApi.annotate({ noteId: myNote.id, content: '下次我注意' });
  await mockApi.setMe('userA');

  const bell = loadPage(path.join('index', 'index.js'));
  await bell.refresh();
  assert.strictEqual(bell.data.unreadCount, 1, '首页应显示 1 条未读回复');
  assert.strictEqual(bell.data.replies.length, 1);
  assert.strictEqual(bell.data.replies[0].content, '下次我注意');
  assert.strictEqual(bell.data.replies[0].title, '第1期 · 小B 回复了你');
  assert.ok(bell.data.replies[0].noteExcerpt.indexOf('打游戏') >= 0);
  assert.ok(bell.data.replies[0].timeText);
  ok('首页铃铛拿到未读回复、角标数与被回复记录的摘要');

  bell.toggleReplies();
  assert.strictEqual(bell.data.showReplies, true);
  assert.strictEqual(bell.data.unreadCount, 0, '打开铃铛后角标清零');
  await sleep(20);
  const afterRead = await mockApi.getUnreadReplies();
  assert.strictEqual(afterRead.unreadCount, 0, '服务端已读位置已推进');
  assert.strictEqual(afterRead.items[0].unread, false);
  assert.strictEqual(afterRead.items.length, 1, '已读回复仍留在列表里可回看');
  ok('打开铃铛即标记已读（服务端已读位置推进，列表保留）');

  bell.toggleReplies();
  assert.strictEqual(bell.data.showReplies, false);
  bell.toggleReplies(); // 再次打开，验证可反复开合且不再重复上报
  assert.strictEqual(bell.data.showReplies, true);
  bell.closeReplies();
  assert.strictEqual(bell.data.showReplies, false);
  ok('面板可反复开合，收起正常');

  navUrls.length = 0;
  bell.toggleReplies();
  bell.openReply({ currentTarget: { dataset: { cycle: cycledId, note: myNote.id } } });
  assert.strictEqual(navUrls.length, 1);
  assert.strictEqual(navUrls[0], '/pages/exchange/exchange?cycleId=' + cycledId + '&noteId=' + myNote.id);
  assert.strictEqual(bell.data.showReplies, false, '跳转时应收起面板');
  ok('点条目跳转到交换详情，并带上要定位的记录 id');

  const jump = loadPage(path.join('exchange', 'exchange.js'));
  scrollCalls.length = 0;
  jump.onLoad({ cycleId: cycledId, noteId: myNote.id });
  await jump.refresh();
  assert.strictEqual(jump.data.expanded[myNote.id], true, '被回复的记录应自动展开');
  assert.strictEqual(jump.data.focusNoteId, myNote.id, '应高亮该记录');
  await sleep(220);
  assert.ok(
    scrollCalls.some((c) => c.selector === '#note-' + myNote.id),
    '应滚动到该记录，实际：' + JSON.stringify(scrollCalls)
  );
  ok('从铃铛跳进来后自动展开、高亮并滚动到被回复的记录');

  const jumpNotes = jump.data.detail.notes;
  assert.strictEqual(jumpNotes[0].annotations[0].authorName, '小B', '批注者显示为昵称');
  assert.strictEqual(jumpNotes[0].annotations[0].mine, false);
  const pageRaw = JSON.stringify(jump.data.detail);
  assert.ok(
    pageRaw.indexOf('userA') < 0 && pageRaw.indexOf('userB') < 0,
    '页面数据里不应出现作者标识（openid / 内部账号），只保留昵称'
  );
  ok('批注只显示昵称，页面数据里不含任何作者标识');

  const annId = jumpNotes[0].annotations[0].id;
  jump.onDeleteAnnotation({ currentTarget: { dataset: { id: myNote.id, annotationId: annId } } });
  await sleep(20);
  assert.strictEqual((await mockApi.getCycleDetail(cycledId)).notes[0].annotations.length, 1);
  ok('页面不允许删除对方批注');
  mockApi.setMe('userB');
  await jump.refresh();
  jump.onDeleteAnnotation({ currentTarget: { dataset: { id: myNote.id, annotationId: annId } } });
  await sleep(350);
  assert.strictEqual(jump.data.detail.notes[0].annotations.length, 0);
  ok('删除自己的批注后页面立即刷新');
  mockApi.setMe('userA');
  await jump.refresh();
  const originalModal = wx.showModal;
  wx.showModal = (options) => options.success({ confirm: false });
  jump.onDeleteNote({ currentTarget: { dataset: { id: myNote.id } } });
  await sleep(350);
  assert.ok(jump.data.detail.notes.some((n) => n.id === myNote.id));
  wx.showModal = originalModal;
  jump.onDeleteNote({ currentTarget: { dataset: { id: myNote.id } } });
  await sleep(350);
  assert.ok(!jump.data.detail.notes.some((n) => n.id === myNote.id));
  ok('取消删除保留笔记，确认删除后页面移除笔记');

  const history = loadPage('history/history.js');
  await history.refresh();
  assert.strictEqual(history.data.selected, null);
  assert.deepStrictEqual(history.data.selectedEvents, []);
  history.points = [1, 2].map((index) => ({
    x: index * 80, index, row: { cycleId: 'h' + index, myScore: 8, partnerScore: 9 },
    event: { x: index * 80, y: 20 },
  }));
  history.allEvents = [1, 2].map((index) => ({ id: 'e' + index, cycleId: 'h' + index, date: Date.now() }));
  const queryBefore = wx.createSelectorQuery;
  wx.createSelectorQuery = () => ({
    in() { return this; }, select() { return this; },
    boundingClientRect(fn) { fn({ left: 10, top: 100 }); return this; }, exec() {},
  });
  history.onChartTap({ changedTouches: [{ clientX: 90, clientY: 200 }] });
  assert.strictEqual(history.data.selected, null);
  history.onChartTap({ changedTouches: [{ clientX: 90, clientY: 120 }] });
  assert.deepStrictEqual(history.data.selectedEvents.map((e) => e.id), ['e1']);
  history.onChartTap({ changedTouches: [{ clientX: 170, clientY: 120 }] });
  assert.deepStrictEqual(history.data.selectedEvents.map((e) => e.id), ['e2']);
  history.onChartTap({ changedTouches: [{ clientX: 170, clientY: 120 }] });
  assert.strictEqual(history.data.selected, null);
  assert.deepStrictEqual(history.data.selectedEvents, []);
  wx.createSelectorQuery = queryBefore;
  ok('时间线默认空白，仅点黄色标记显示对应事件，切换期数及再次点击收起');

  await mockApi.resetMock();
  const shareScore = loadPage(path.join('score', 'score.js'));
  await shareScore.refresh();
  assert.ok(!shareScore.onShareAppMessage().title.includes('已打完分'));
  shareScore.onSave();
  await sleep(50);
  assert.strictEqual(shareScore.data.saved, true);
  const shareCard = shareScore.onShareAppMessage();
  assert.ok(shareCard.title.includes('已打完分'));
  assert.strictEqual(shareCard.path, '/pages/exchange/exchange?from=exchange-share');
  assert.ok(require('fs').existsSync(path.join(__dirname, '../miniprogram', shareCard.imageUrl)));
  assert.ok(!shareCard.path.includes('score='));
  shareScore.setData({ autoExchanged: true });
  assert.ok(!shareScore.onShareAppMessage().title.includes('已打完分'));
  const sharedExchange = loadPage(path.join('exchange', 'exchange.js'));
  sharedExchange.onLoad({ from: 'exchange-share' });
  await sharedExchange.refresh();
  assert.strictEqual(sharedExchange.data.fromShare, true);
  assert.ok(sharedExchange.onShareAppMessage().title.includes('已打完分'));
  assert.strictEqual((await mockApi.getAppStatus()).exchangeRequest, null);
  sharedExchange.setData({ status: { cycle: null } });
  assert.ok(!sharedExchange.onShareAppMessage().title.includes('已打完分'));
  ok('打分后可分享，固定封面不截取私密内容，分享不发起交换，自动交换后不再提醒');

  await mockApi.resetMock();
  const diamondSettings = loadPage(path.join('settings', 'settings.js'));
  await diamondSettings.refresh();
  for (const value of ['', '1.5', '-1', '101']) {
    diamondSettings.onCustomDiamonds({ detail: { value } });
    await diamondSettings.saveDiamonds();
    assert.strictEqual((await mockApi.getAppStatus()).pair.diamondAllowance, 10);
  }
  diamondSettings.onCustomDiamonds({ detail: { value: '0' } });
  await diamondSettings.saveDiamonds();
  assert.strictEqual(diamondSettings.data.diamondAllowance, 0);
  assert.strictEqual((await mockApi.getGiftState()).balance, 10);
  await mockApi.setMe('userB');
  await diamondSettings.refresh();
  assert.strictEqual(diamondSettings.data.diamondAllowance, 0);
  ok('设置页拒绝空值及非法额度，允许0且双方读取同一设置，本期余额不变');
  await mockApi.resetMock();
  await mockApi.setMe('userA');
  const editableScore = loadPage(path.join('score', 'score.js'));
  await editableScore.refresh();
  await mockApi.submitScore({ score: 5 });
  editableScore.setData({ saved: true, showEvent: true });
  await editableScore.onEditScore();
  assert.strictEqual(editableScore.data.saved, false);
  assert.strictEqual(editableScore.data.showEvent, false);
  editableScore.onSlideCommit({ detail: { value: 9 } });
  await sleep(850);
  editableScore.onSave();
  await sleep(50);
  assert.strictEqual((await mockApi.getAppStatus()).myScore.score, 9);
  assert.strictEqual(editableScore.data.saved, true);
  await mockApi.requestExchange();
  await mockApi.setMe('userB');
  await mockApi.submitScore({ score: 8 });
  await mockApi.agreeExchange();
  await mockApi.setMe('userA');
  await editableScore.onEditScore();
  assert.strictEqual(editableScore.data.saved, true);
  await assert.rejects(() => mockApi.submitScore({ cycleId: editableScore.data.editingCycleId, score: 9 }));
  assert.strictEqual((await mockApi.getAppStatus()).cycle.status, 'exchanged');
  require('./clock').advanceTo((await mockApi.getAppStatus()).cycle.nextOpenAt);
  assert.strictEqual((await mockApi.getAppStatus()).myScore, null);
  ok('保存后可继续改分并再次保存；原周期交换后拒绝编辑和跨周期保存');
  const drawChart = require('../miniprogram/utils/chart').drawLineChart;
  const segmentCalls = [];
  const chartLabels = [];
  const chartContext = new Proxy({}, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      if ((key === 'moveTo' || key === 'lineTo') && ['me', 'ta'].includes(target.strokeStyle)) segmentCalls.push({ key, args });
      if (key === 'fillText') chartLabels.push({ text:args[0], x:args[1], font:target.font });
    };
  } });
  drawChart({ getContext: () => chartContext }, 350, 230, 1, [
    { index: 1, myScore: 8, partnerScore: 9 },
    { index: 2, gap: true, myScore: null, partnerScore: null },
    { index: 3, myScore: 7, partnerScore: 8 },
  ], { me: 'me', partner: 'ta' });
  assert.strictEqual(segmentCalls.filter((c) => c.key === 'lineTo').length, 0);
  assert.strictEqual(segmentCalls.filter((c) => c.key === 'moveTo').length, 4);
  ok('两条折线遇到暂停位置均断开，恢复后的点不跨暂停连线');
  const historyPaging = loadPage(path.join('history', 'history.js'));
  const originalHistory = mockApi.getHistory;
  const originalQuery = wx.createSelectorQuery;
  wx.createSelectorQuery = () => ({ in() { return this; }, select() { return this; }, boundingClientRect(cb) { cb({ width: 330 }); return this; }, exec() {} });
  historyPaging.draw = () => {};
  const makeRows = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({ cycleId: 'p' + (from + i), index: from + i, myScore: 8, partnerScore: 9, eventCount: 0 }));
  let resolveOlder;
  let olderCalls = 0;
  mockApi.getHistory = async (payload) => {
    if (payload.beforeIndex) { olderCalls++; return new Promise((resolve) => { resolveOlder = resolve; }); }
    return { rows: makeRows(80,100), events: [], hasMore: true, nextBeforeIndex: 80 };
  };
  await historyPaging.refresh();
  assert.strictEqual(historyPaging.data.chartScrollLeft, historyPaging.data.chartContentWidth - 330, '默认定位右侧最新');
  historyPaging._scrollLeft = 12;
  const olderLoad = historyPaging.loadOlder();
  await historyPaging.loadOlder();
  assert.strictEqual(olderCalls, 1);
  resolveOlder({ rows: makeRows(59,79), events: [], hasMore: true, nextBeforeIndex: 59 });
  await olderLoad;
  assert.strictEqual(historyPaging.data.rows.length, 42);
  assert.strictEqual(historyPaging.data.chartScrollLeft, 12 + 21 * historyPaging._step);
  mockApi.getHistory = originalHistory;
  wx.createSelectorQuery = originalQuery;
  ok('图表左旧右新、默认右端最新、重复触底只发一次请求、加载旧期保持位置');
  const exporter = require('../miniprogram/utils/chart-export');
  let exportRequests = 0;
  const exportRows = await exporter.loadAll({ getHistory: async ({beforeIndex}) => {
    exportRequests++;
    const to = beforeIndex ? beforeIndex - 1 : 250;
    const from = Math.max(1, to - 99);
    return { rows: makeRows(from, to), hasMore: from > 1, nextBeforeIndex: from > 1 ? from : null };
  } });
  assert.strictEqual(exportRequests, 3);
  assert.strictEqual(exportRows.length, 250);
  assert.strictEqual(exportRows[0].index, 1);
  assert.strictEqual(exportRows[249].index, 250);
  assert.ok(exportRows.every(r => !r.cycleId && r.eventCount === 0));
  const bands = exporter.bandsFor(exportRows);
  const segments = bands.flatMap(b => b.slice(1).map((r,i) => [b[i].index,r.index]));
  assert.strictEqual(segments.length, 249, '全部相邻期数线段均被导出');
  assert.strictEqual(new Set(segments.map(s => s.join(','))).size, 249);
  await assert.rejects(() => exporter.loadAll({ getHistory: async () => ({ rows: [], hasMore: true, nextBeforeIndex: 5 }) }));
  await assert.rejects(() => exporter.loadAll({}, () => false));
  const exportCanvas = { getContext: () => chartContext };
  wx.createSelectorQuery = () => ({ in() { return this; }, select() { return this; }, fields() { return this; }, exec(cb) { cb([{ node: exportCanvas }]); } });
  wx.canvasToTempFilePath = options => { assert.strictEqual(options.canvas, exportCanvas); assert.strictEqual(options.fileType, 'png'); options.success({ tempFilePath: 'test-chart.png' }); };
  const allImages = await exporter.generateAll(historyPaging, exportRows);
  assert.strictEqual(allImages.length, 4);
  assert.strictEqual(allImages[0].first, 1);
  assert.strictEqual(allImages[3].last, 250);
  assert.strictEqual(await exporter.generate(historyPaging, [exportRows.slice(0,14)]), 'test-chart.png');
  assert.strictEqual(exportCanvas.width, 1120);
  assert.strictEqual(exportCanvas.height, 612);
  assert.ok(chartLabels.some(label => label.text === '第14期' && label.x === 514 && label.font === '14px sans-serif'), '导出图标签使用独立字号，末期铺至右端');
  assert.strictEqual(allImages[0].width, 560);
  assert.strictEqual(allImages[0].height, 1426);
  const preview = loadPage(path.join('history','history.js'));
  preview.setData({ exportImage:'short.png', exportImages:[{ path:'short.png', width:560, height:306 }] });
  wx.getWindowInfo = () => ({ windowHeight:700 });
  wx.createSelectorQuery = () => ({ in(){return this;}, select(){return this;}, boundingClientRect(cb){cb({width:300});return this;}, exec(){} });
  preview.sizeExportPreview();
  assert.strictEqual(preview.data.exportGalleryHeight, 164, '短图高度贴合图片，不保留固定屏幕占位');
  preview.data.exportImages[0].height = 1426;
  preview.sizeExportPreview();
  assert.strictEqual(preview.data.exportGalleryHeight, 385, '长图限制高度，由内部滚动阅读');
  wx.createSelectorQuery = () => ({ in() { return this; }, select() { return this; }, fields() { return this; }, exec(cb) { cb([{ node: exportCanvas }]); } });
  wx.canvasToTempFilePath = options => options.fail(new Error('failed'));
  await assert.rejects(() => exporter.generate(historyPaging, [exportRows.slice(0,14)]));
  let sharePath, savedPath, previewPath;
  wx.showShareImageMenu = options => { sharePath = options.path; };
  exporter.share('test-chart.png');
  assert.strictEqual(sharePath, 'test-chart.png');
  delete wx.showShareImageMenu;
  wx.previewImage = options => { previewPath = options.current; };
  exporter.share('test-chart.png');
  assert.strictEqual(previewPath, 'test-chart.png');
  wx.saveImageToPhotosAlbum = options => { savedPath = options.filePath; options.success(); options.complete(); };
  await exporter.save('test-chart.png');
  assert.strictEqual(savedPath, 'test-chart.png');
  wx.createSelectorQuery = originalQuery;
  ok('250期全部导出、跨行线段无遗漏、高清PNG不带私密正文、失败不静默截断、分享和保存');
  const full = loadPage(path.join('history-fullscreen', 'history-fullscreen.js'));
  assert.strictEqual(full.data.fullscreen, true);
  wx.getWindowInfo = () => ({ screenWidth: 812, screenHeight: 375, safeArea: { left:44, right:768, bottom:354 }, statusBarHeight: 0 });
  wx.getMenuButtonBoundingClientRect = () => ({ bottom: 36 });
  full.updateSafeArea();
  assert.deepStrictEqual([full.data.safeLeft, full.data.safeRight, full.data.safeBottom, full.data.safeTop], [44,44,21,44]);
  full.data.selected = { cycleId: 'old' };
  full._chart = {};
  full.draw = () => {};
  full.closeEvent();
  assert.strictEqual(full.data.selected, null);
  assert.strictEqual(full._chart, null);
  const originalEvents = mockApi.getCycleEvents;
  mockApi.getCycleEvents = async () => ({ events: [{ id: 'event1', cycleId: 'p9', date: Date.now(), reason: '测试正文' }], nextBeforeId: null });
  full.allEvents = [];
  full.points = [{ index:9, event:{x:90,y:20}, row:{cycleId:'p9',myScore:8,partnerScore:9} }];
  wx.createSelectorQuery = () => ({ in(){return this;}, select(){return this;}, boundingClientRect(cb){cb({left:20,top:30});return this;}, exec(){} });
  full.onChartTap({changedTouches:[{clientX:110,clientY:50}]});
  await sleep(5);
  assert.strictEqual(full.data.selected.cycleId, 'p9');
  assert.strictEqual(full.data.selectedEvents[0].reason, '测试正文');
  full.closeEvent();
  assert.strictEqual(full.data.selected, null);
  wx.createSelectorQuery = originalQuery;
  mockApi.getCycleEvents = originalEvents;
  const fs = require('fs');
  const fullConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/history-fullscreen/history-fullscreen.json')));
  assert.strictEqual(fullConfig.pageOrientation, 'landscape');
  const historyMarkup = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/history/history.wxml'), 'utf8');
  assert.ok(!/回到最新|已到最早记录/.test(historyMarkup));
  assert.ok(historyMarkup.includes('bindscrolltoupper="onChartUpper"'));
  ok('全屏独立横屏配置、刘海胶囊安全区、关闭事件恢复画布、删除多余按钮');
  const retryPage = loadPage(path.join('history', 'history.js'));
  retryPage.setData({ rows: [{ cycleId: 'old', index: 1 }], hasMore: false });
  const savedHistoryApi = mockApi.getHistory;
  const retryRequests = [];
  mockApi.getHistory = async options => {
    retryRequests.push(options);
    if (retryRequests.length % 2) throw new Error('temporary');
    return { rows: [], events: [], hasMore: false, nextBeforeIndex: null };
  };
  await retryPage.refresh();
  await retryPage.retryHistory();
  assert.strictEqual(retryRequests.length, 2, '已有数据且没有更早记录时仍能重试刷新');
  assert.strictEqual(retryRequests[1].beforeIndex, undefined);
  retryPage.setData({ hasMore: true });
  retryPage._beforeIndex = 22;
  await retryPage.loadOlder();
  await retryPage.retryHistory();
  assert.strictEqual(retryRequests.length, 4);
  assert.strictEqual(retryRequests[3].beforeIndex, 22, '翻页失败重试保留原游标');
  mockApi.getHistory = savedHistoryApi;
  ok('刷新与历史翻页失败分别重试，不因已有记录而跳过刷新');
  console.log(`\n全部通过：${passed} 项页面断言 ✓`);
  // 页面里的轮询定时器会拖住事件循环，断言跑完直接退出
  process.exit(0);
})().catch((e) => {
  console.error('\n✗ 测试失败：' + (e && e.message));
  process.exit(1);
});
