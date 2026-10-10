/**
 * 云函数离线回归测试（纯 Node，不需要微信开发者工具与云环境）。
 *
 * 用 Module._load 拦截把 wx-server-sdk 换成内存桩，直接驱动 cloudfunctions/ 下的真实代码。
 * test/flow.test.js 只覆盖 miniprogram/services/mock.js，云函数此前零覆盖，
 * 下面这几个用例专门锁住已修复的线上缺陷：
 *   1. cycle.getCurrent 在「已生成邀请、对方还没接受」时的空值保护（原会抛 TypeError）
 *   2. reminder 游标必须在 continue 之前推进（原会重复查询同一页导致死循环）
 *   3. track.history 取「最近 100 期」而不是最早 100 期，且事件可见性不再依赖这 100 期
 *   4. reminder 到期自动交换的正常路径
 *
 * 运行：node test/cloud.test.js
 */
const assert = require('assert');
const path = require('path');
const Module = require('module');

/* ================= 内存数据库桩 ================= */

const coll = { users: [], pairs: [], cycles: [], notes: [], events: [], gifts: [] };
let ctxOpenid = 'openid_A';
let queryCount = 0;
let readCount = 0;
let QUERY_CAP = 400; // 超过即判定为死循环，避免测试真的卡死

function resetData(next) {
  Object.keys(coll).forEach((k) => {
    coll[k].length = 0;
    (next[k] || []).forEach((d) => coll[k].push(JSON.parse(JSON.stringify(d))));
  });
  queryCount = 0;
  readCount = 0;
}

function getPath(doc, p) {
  return p.split('.').reduce((o, k) => (o == null ? o : o[k]), doc);
}

function setPath(doc, p, v) {
  const ks = p.split('.');
  let o = doc;
  for (let i = 0; i < ks.length - 1; i++) {
    if (o[ks[i]] == null || typeof o[ks[i]] !== 'object') o[ks[i]] = {};
    o = o[ks[i]];
  }
  o[ks[ks.length - 1]] = v;
}

function delPath(doc, p) {
  const ks = p.split('.');
  let o = doc;
  for (let i = 0; i < ks.length - 1; i++) {
    if (o[ks[i]] == null) return;
    o = o[ks[i]];
  }
  delete o[ks[ks.length - 1]];
}

function applyUpdate(doc, data) {
  Object.keys(data).forEach((k) => {
    const v = data[k];
    if (v && typeof v === 'object' && v.__op === 'remove') delPath(doc, k);
    else if (v && typeof v === 'object' && v.__op === 'push') setPath(doc, k, (getPath(doc, k) || []).concat([v.v]));
    else if (v && typeof v === 'object' && v.__op === 'pull') setPath(doc, k, (getPath(doc, k) || []).filter((a) => !matches(a, v.v)));
    else setPath(doc, k, v);
  });
}

function matches(doc, cond) {
  return Object.keys(cond).every((k) => {
    const c = cond[k];
    if (c && typeof c === 'object' && c.__op) {
      const v = getPath(doc, k);
      if (c.__op === 'gt') return v > c.v;
      if (c.__op === 'lt') return v < c.v;
      if (c.__op === 'in') return (c.v || []).indexOf(v) >= 0;
      if (c.__op === 'all') return Array.isArray(v) && c.v.every((x) => v.includes(x));
      if (c.__op === 'size') return Array.isArray(v) && v.length === c.n;
      return false;
    }
    return getPath(doc, k) === c;
  });
}

class Query {
  constructor(name, cond) {
    this.name = name;
    this.cond = Object.assign({}, cond || {});
    this._order = null;
    this._limit = 20;
  }
  where(c) {
    Object.assign(this.cond, c);
    return this;
  }
  orderBy(f, d) {
    this._order = { f: f, d: d };
    return this;
  }
  limit(n) {
    this._limit = n;
    return this;
  }
  rows() {
    let rows = coll[this.name].filter((d) => matches(d, this.cond));
    if (this._order) {
      const f = this._order.f;
      const sign = this._order.d === 'desc' ? -1 : 1;
      rows = rows.slice().sort((a, b) => (a[f] > b[f] ? 1 : a[f] < b[f] ? -1 : 0) * sign);
    }
    return rows;
  }
  async get() {
    if (this.name === 'gifts' && giftReadFailure) throw giftReadFailure;
    readCount++;
    queryCount++;
    if (queryCount > QUERY_CAP) throw new Error('QUERY_CAP_EXCEEDED（查询次数异常，疑似死循环）');
    return { data: this.rows().slice(0, this._limit) };
  }
  async count() {
    readCount++;
    return { total: this.rows().length };
  }
  async update({ data }) {
    const rows = this.rows();
    rows.forEach((d) => applyUpdate(d, data));
    return { stats: { updated: rows.length } };
  }
}

function collection(name) {
  return {
    where: (c) => new Query(name, c),
    doc: (id) => ({
      get: async () => {
        readCount++;
        const d = coll[name].find((x) => x._id === id);
        if (!d) throw new Error('document.get: not exists');
        return { data: d };
      },
      update: async ({ data }) => {
        const d = coll[name].find((x) => x._id === id);
        if (d) applyUpdate(d, data);
        return { stats: { updated: d ? 1 : 0 } };
      },
      set: async ({ data }) => {
        if (name === 'gifts' && giftWriteFailure) throw new Error('gift write failed');
        const i = coll[name].findIndex((x) => x._id === id);
        const next = Object.assign({}, data, { _id: id });
        if (i >= 0) coll[name][i] = next;
        else coll[name].push(next);
        return { stats: { created: i < 0 ? 1 : 0, updated: i >= 0 ? 1 : 0 } };
      },
      remove: async () => {
        const i = coll[name].findIndex((x) => x._id === id);
        if (i >= 0) coll[name].splice(i, 1);
        return { stats: { removed: 1 } };
      },
    }),
    add: async ({ data }) => {
      if (data._id && coll[name].some((x) => x._id === data._id)) {
        const e = new Error('duplicate _id');
        e.errCode = -502001;
        throw e;
      }
      const doc = Object.assign({}, data);
      if (!doc._id) doc._id = 'auto_' + coll[name].length + '_' + Math.random().toString(36).slice(2, 6);
      coll[name].push(doc);
      return { _id: doc._id };
    },
    count: async () => ({ total: coll[name].length }),
  };
}

let transactionQueue = Promise.resolve();
function runTransaction(callback) {
  const result = transactionQueue.then(() => executeTransaction(callback));
  transactionQueue = result.catch(() => {});
  return result;
}
async function executeTransaction(callback) {
  const snapshot = {};
  Object.keys(coll).forEach((k) => { snapshot[k] = JSON.parse(JSON.stringify(coll[k])); });
  try {
    return await callback({ collection: collection });
  } catch (e) {
    Object.keys(coll).forEach((k) => {
      coll[k].length = 0;
      snapshot[k].forEach((d) => coll[k].push(d));
    });
    throw e;
  }
}

const command = {
  gt: (v) => ({ __op: 'gt', v: v }),
  lt: (v) => ({ __op: 'lt', v: v }),
  in: (arr) => ({ __op: 'in', v: arr }),
  all: (arr) => ({ __op: 'all', v: arr }),
  remove: () => ({ __op: 'remove' }),
  push: (v) => ({ __op: 'push', v: v }),
  pull: (v) => ({ __op: 'pull', v: v }),
  size: (n) => ({ __op: 'size', n: n }),
};

const sentMessages = [];
let securityFailure = null;
let giftWriteFailure = false;
let giftReadFailure = null;
const cloud = {
  DYNAMIC_CURRENT_ENV: 'dyn',
  init() {},
  database: () => ({ collection: collection, command: command, runTransaction: runTransaction }),
  createCollection: async () => ({}),
  getWXContext: () => ({ OPENID: ctxOpenid }),
  openapi: {
    subscribeMessage: {
      send: async (p) => {
        sentMessages.push(p);
        return {};
      },
    },
    security: {
      msgSecCheck: async () => {
        if (securityFailure) throw securityFailure;
        return { result: { suggest: 'pass' } };
      },
    },
  },
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'wx-server-sdk') return cloud;
  return origLoad.apply(this, arguments);
};

const cf = (name) => require(path.join(__dirname, '..', 'cloudfunctions', name, 'index.js'));
const cycleFn = cf('cycle');
const trackFn = cf('track');
const noteFn = cf('note');
const reminderFn = cf('reminder');
const pairFn = cf('pair');

/* ================= 断言辅助 ================= */

let passed = 0;
function ok(label) {
  passed++;
  console.log('  ✓ ' + label);
}

const U_A = { _id: 'uA', openid: 'openid_A', nickname: '小A', pairId: 'p1' };
const U_B = { _id: 'uB', openid: 'openid_B', nickname: '小B', pairId: 'p1' };

(async () => {
  console.log('云函数：cycle.getCurrent 空值保护');

  // 已生成邀请、对方还没接受：pair.users 只有 1 人，此时没有周期
  resetData({
    users: [{ _id: 'u1', openid: 'openid_A', nickname: '小A', pairId: 'p1' }],
    pairs: [{ _id: 'p1', users: ['openid_A'], owner: 'openid_A', code: 'ABC123', cycleDays: 7, status: 'open' }],
  });
  ctxOpenid = 'openid_A';
  let r = await cycleFn.main({ action: 'getCurrent', payload: {} });
  assert.strictEqual(r.ok, true, '不该返回错误：' + r.error);
  assert.strictEqual(r.data.bound, false);
  assert.strictEqual(r.data.cycle, null);
  assert.strictEqual(r.data.myScore, null);
  assert.strictEqual(r.data.partnerDone, false);
  assert.strictEqual(r.data.bothScored, false);
  assert.strictEqual(r.data.exchangeRequest, null);
  ok('未完成绑定时返回 bound:false + cycle:null（首页「对方还没接受邀请」引导可用）');
  assert.strictEqual(readCount, 2, '等待绑定只读用户和配对，不查周期/历史/重复昵称');

  // 双方绑定完成：第 1 期开始计时
  resetData({
    users: [U_A, U_B],
    pairs: [{ _id: 'p1', users: ['openid_A', 'openid_B'], owner: 'openid_A', code: 'ABC123', cycleDays: 7, status: 'closed' }],
  });
  r = await cycleFn.main({ action: 'getCurrent', payload: {} });
  assert.strictEqual(r.ok, true, '不该返回错误：' + r.error);
  assert.strictEqual(r.data.bound, true);
  assert.ok(r.data.cycle && r.data.cycle.index === 1, '绑定后应创建第 1 期');
  assert.strictEqual(r.data.bothScored, false);
  ok('绑定完成后自动创建第 1 期');

  readCount = 0;
  r = await cycleFn.main({ action: 'getCurrent' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(readCount, 6, '普通首页数据库读取由 7 次降到 6 次');
  ['userMs', 'pairMs', 'usersMs', 'cycleMs', 'historyMs', 'totalMs'].forEach((k) => {
    assert.ok(Number.isFinite(r.data.timings[k]), '返回有效的分段耗时 ' + k);
  });
  const activeId = r.data.cycle.id;
  coll.notes.push({ _id: 'private', cycleId: activeId, author: 'openid_B', content: '私密', createdAt: 1 });
  readCount = 0;
  r = await cycleFn.main({ action: 'getExchangePage', payload: { cycleId: activeId } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(readCount, 8, '合并状态和详情复用身份/配对/昵称，不能重复读取');
  assert.strictEqual(r.data.detail.partner.locked, true);
  assert.strictEqual(r.data.detail.notes.length, 0, '合并接口不能暴露未交换的伴侣笔记');
  coll.cycles.push({ _id: 'foreign', pairId: 'someone_else', status: 'exchanged' });
  r = await cycleFn.main({ action: 'getExchangePage', payload: { cycleId: 'foreign' } });
  assert.strictEqual(r.ok, false, '合并接口仍验证详情归属');
  ok('首屏/合并详情查询预算、分段耗时与隐私边界通过');

  console.log('云函数：发起交换请求的门槛');

  const activeCycles = (scores) => [
    {
      _id: 'cyc_p1_1',
      pairId: 'p1',
      index: 1,
      status: 'active',
      startDate: Date.now(),
      endDate: Date.now() + 7 * 86400000,
      scores: scores,
    },
  ];
  const basePair = [{ _id: 'p1', users: ['openid_A', 'openid_B'], status: 'closed', cycleDays: 7 }];

  resetData({ users: [U_A, U_B], pairs: basePair, cycles: activeCycles({}) });
  ctxOpenid = 'openid_A';
  let rq = await cycleFn.main({ action: 'requestExchange', payload: {} });
  assert.strictEqual(rq.ok, false, '未完成打分不该允许发起交换请求');
  assert.ok(rq.error.indexOf('打分') >= 0, '提示应说明先打分，实际：' + rq.error);
  assert.strictEqual(coll.cycles[0].exchangeRequest, undefined, '不该写入交换请求');
  ok('自己未完成打分时，发起交换请求被服务端拒绝');

  resetData({
    users: [U_A, U_B],
    pairs: basePair,
    cycles: activeCycles({ openid_A: { score: 8, comment: '', scoredAt: 1 } }),
  });
  ctxOpenid = 'openid_A';
  rq = await cycleFn.main({ action: 'requestExchange', payload: {} });
  assert.strictEqual(rq.ok, true, rq.error);
  assert.strictEqual(rq.data.resent, false);
  assert.strictEqual(coll.cycles[0].exchangeRequest.from, 'openid_A');
  rq = await cycleFn.main({ action: 'requestExchange', payload: {} });
  assert.strictEqual(rq.data.resent, true, '重复发起应为幂等刷新');
  ok('完成打分后可以发起，重复发起幂等刷新');

  ctxOpenid = 'openid_B';
  rq = await cycleFn.main({ action: 'requestExchange', payload: {} });
  assert.strictEqual(rq.ok, false);
  assert.ok(rq.error.indexOf('对方已向你发起') >= 0, '对方已有请求时应优先提示去处理：' + rq.error);
  ok('对方已有待处理请求时，优先提示先去处理');

  console.log('云函数：reminder 定时扫描');

  // 一页 100 条活动周期全都属于「已归档配对」：必须正常结束，不能原地打转
  const pairs = [];
  const cycles = [];
  for (let i = 0; i < 100; i++) {
    const pid = 'p' + String(i).padStart(3, '0');
    pairs.push({ _id: pid, users: ['o' + i], status: 'archived', cycleDays: 7 });
    cycles.push({ _id: 'cyc_' + pid + '_1', pairId: pid, index: 1, status: 'active', scores: {}, endDate: Date.now() - 1000 });
  }
  resetData({ pairs: pairs, cycles: cycles });
  QUERY_CAP = 400;
  r = await reminderFn.main();
  assert.strictEqual(r.ok, true, '不该返回错误：' + r.error);
  assert.strictEqual(r.data.checked, 100);
  assert.ok(queryCount <= 150, '一页 100 条只该产生百来次查询，实际 ' + queryCount + ' 次（游标未推进会无限重复）');
  ok('整页被跳过时正常结束（游标推进修复：' + queryCount + ' 次查询，未死循环）');

  // 正常路径：到期 + 双方已打分 → 自动交换并发下一期
  resetData({
    pairs: [{ _id: 'p1', users: ['openid_A', 'openid_B'], status: 'closed', cycleDays: 7 }],
    cycles: [
      {
        _id: 'cyc_p1_1',
        pairId: 'p1',
        index: 1,
        status: 'active',
        endDate: Date.now() - 1000,
        scores: { openid_A: { score: 8 }, openid_B: { score: 7 } },
      },
    ],
  });
  sentMessages.length = 0;
  r = await reminderFn.main();
  assert.strictEqual(r.data.autoExchanged, 1);
  assert.strictEqual(coll.cycles.find((c) => c.index === 1).status, 'exchanged');
  const nextCycle = coll.cycles.find((c) => c.index === 2);
  assert.ok(nextCycle && nextCycle.status === 'active' && nextCycle.endDate > Date.now(), '应创建下一期');
  assert.strictEqual(nextCycle.startDate, coll.cycles.find((c) => c.index === 1).endDate, '下一期应从上一期截止时刻开始');
  assert.strictEqual(sentMessages.length, 0, '自动交换不再发送微信通知');
  ok('到期自动交换从原截止时刻开启下一期，且不发送微信通知');

  // 已保存的旧提醒计划不清库：到点也不得推送，周期仍保持进行中。
  nextCycle.exchangePlan = { time: Date.now() - 1000, notified: false };
  r = await reminderFn.main();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(nextCycle.status, 'active');
  assert.strictEqual(sentMessages.length, 0, '旧版到点提醒计划也不得发送');
  ok('旧约定到点不发送通知，且不会提前交换');

  console.log('云函数：track.history 取数方向与事件可见性');

  const rowsCycles = [];
  for (let i = 1; i <= 120; i++) {
    rowsCycles.push({
      _id: 'cyc_p1_' + i,
      pairId: 'p1',
      index: i,
      status: 'exchanged',
      startDate: i * 1000,
      endDate: i * 1000 + 500,
      exchangedAt: i * 1000 + 500,
      scores: { openid_A: { score: 8 }, openid_B: { score: 7 } },
    });
  }
  rowsCycles.push({ _id: 'cyc_p1_121', pairId: 'p1', index: 121, status: 'active', scores: {}, startDate: 0, endDate: 0 });
  resetData({
    users: [U_A, U_B],
    pairs: [{ _id: 'p1', users: ['openid_A', 'openid_B'], status: 'closed', cycleDays: 7 }],
    cycles: rowsCycles,
    events: [
      { _id: 'e1', pairId: 'p1', cycleId: 'cyc_p1_5', author: 'openid_B', reason: '很久以前对方的事件', createdAt: 5, date: 5 },
      { _id: 'e2', pairId: 'p1', cycleId: 'cyc_p1_121', author: 'openid_B', reason: '进行中对方的事件', createdAt: 6, date: 6 },
      { _id: 'e3', pairId: 'p1', cycleId: 'cyc_p1_121', author: 'openid_A', reason: '进行中我的事件', createdAt: 7, date: 7 },
    ],
  });
  ctxOpenid = 'openid_A';
  const h = await trackFn.main({ action: 'history', payload: {} });
  assert.strictEqual(h.ok, true, '不该返回错误：' + h.error);
  assert.strictEqual(h.data.rows.length, 100);
  assert.strictEqual(h.data.rows[0].index, 21, '应取最近 100 期（21-120），而不是最早的 100 期');
  assert.strictEqual(h.data.rows[99].index, 120);
  assert.strictEqual(h.data.cyclesTruncated, true);
  ok('期数超过 100 时取的是最近 100 期');

  const reasons = h.data.events.map((e) => e.reason);
  assert.ok(reasons.indexOf('很久以前对方的事件') >= 0, '第 100 期之前的历史周期里对方的事件仍应可见');
  assert.strictEqual(reasons.indexOf('进行中对方的事件'), -1, '进行中周期里对方的事件应不可见');
  assert.ok(reasons.indexOf('进行中我的事件') >= 0, '自己进行中的事件应可见');
  ok('事件可见性按「是否属于进行中周期」判定，补齐了交换前互相不可见的规则');

  assert.strictEqual(h.data.eventsTruncated, false, '3 条事件不该被误报成「仅显示最近 200 条」');
  ok('截断标记不再被可见性过滤误报');

  console.log('云函数：getDetail 的作者显示（批注只给昵称）');

  resetData({
    users: [U_A, U_B],
    pairs: [{ _id: 'p1', users: ['openid_A', 'openid_B'], status: 'closed', cycleDays: 7 }],
    cycles: [
      {
        _id: 'cyc_p1_1',
        pairId: 'p1',
        index: 1,
        status: 'exchanged',
        exchangedAt: 1000,
        scores: { openid_A: { score: 8, comment: '' }, openid_B: { score: 7, comment: '' } },
      },
    ],
    notes: [
      {
        _id: 'n1',
        pairId: 'p1',
        cycleId: 'cyc_p1_1',
        author: 'openid_A',
        type: 'unhappy',
        content: '这周你老是打游戏',
        createdAt: 100,
        annotations: [
          { id: 'a1', author: 'openid_B', content: '下次我注意', createdAt: 200 },
          { id: 'a2', author: 'openid_A', content: '也希望你多陪我', createdAt: 210 },
        ],
      },
    ],
  });
  ctxOpenid = 'openid_A';
  const det = await cycleFn.main({ action: 'getDetail', payload: { cycleId: 'cyc_p1_1' } });
  assert.strictEqual(det.ok, true, '不该返回错误：' + det.error);
  const n0 = det.data.notes[0];
  assert.strictEqual(n0.authorName, '小A');
  assert.strictEqual(n0.mine, true);
  assert.strictEqual(n0.annotations.length, 2);
  assert.strictEqual(n0.annotations[0].authorName, '小B', '对方批注显示昵称');
  assert.strictEqual(n0.annotations[0].mine, false);
  assert.strictEqual(n0.annotations[1].authorName, '小A', '自己的批注同样显示昵称');
  assert.strictEqual(n0.annotations[1].mine, true);
  assert.strictEqual(n0.annotations[0].author, undefined, '批注不下发作者 openid');
  assert.ok(
    JSON.stringify(det.data).indexOf('openid_') === -1,
    '整个详情数据里都不该出现 openid（作者的 id 不进前端）'
  );
  ok('批注与记录的作者只给昵称（含 mine 标记），openid 不下发到前端');

  // 作者无法解析时退化为「我 / TA」，而不是回落到某个 id
  resetData({
    users: [U_A, U_B],
    pairs: [{ _id: 'p1', users: ['openid_A', 'openid_B'], status: 'closed', cycleDays: 7 }],
    cycles: [{ _id: 'cyc_p1_1', pairId: 'p1', index: 1, status: 'exchanged', exchangedAt: 1000, scores: {} }],
    notes: [
      {
        _id: 'n9',
        pairId: 'p1',
        cycleId: 'cyc_p1_1',
        author: 'openid_GHOST',
        type: 'happy',
        content: '历史脏数据',
        createdAt: 100,
        annotations: [{ id: 'a9', author: 'openid_GHOST', content: '脏数据批注', createdAt: 200 }],
      },
    ],
  });
  const det2 = await cycleFn.main({ action: 'getDetail', payload: { cycleId: 'cyc_p1_1' } });
  assert.strictEqual(det2.data.notes[0].authorName, 'TA');
  assert.strictEqual(det2.data.notes[0].annotations[0].authorName, 'TA');
  assert.ok(JSON.stringify(det2.data).indexOf('openid_GHOST') === -1, '脏数据里的标识也不该外泄');
  ok('作者无法解析时退化为「我 / TA」，绝不回落到 id');

  console.log('云函数：note 未读回复（首页小铃铛）');

  resetData({
    users: [U_A, U_B],
    pairs: [{ _id: 'p1', users: ['openid_A', 'openid_B'], status: 'closed', cycleDays: 7 }],
    cycles: [{ _id: 'cyc_p1_1', pairId: 'p1', index: 1, status: 'exchanged', scores: {}, exchangedAt: 1000 }],
    notes: [
      {
        _id: 'n1',
        pairId: 'p1',
        cycleId: 'cyc_p1_1',
        author: 'openid_A',
        type: 'unhappy',
        content: '这周你老是打游戏，我有点不开心',
        createdAt: 100,
        annotations: [
          { id: 'a1', author: 'openid_B', content: '下次我注意', createdAt: 200 },
          { id: 'a2', author: 'openid_A', content: '我自己补一句', createdAt: 210 },
        ],
      },
      {
        _id: 'n2',
        pairId: 'p1',
        cycleId: 'cyc_p1_1',
        author: 'openid_B',
        type: 'happy',
        content: '一起看了电影',
        createdAt: 300,
        annotations: [{ id: 'a3', author: 'openid_A', content: '我批注对方的记录', createdAt: 400 }],
      },
    ],
  });
  ctxOpenid = 'openid_A';
  let rep = await noteFn.main({ action: 'unreadReplies', payload: {} });
  assert.strictEqual(rep.ok, true, '不该返回错误：' + rep.error);
  assert.strictEqual(rep.data.unreadCount, 1);
  assert.strictEqual(rep.data.items.length, 1);
  assert.strictEqual(rep.data.items[0].content, '下次我注意');
  assert.strictEqual(rep.data.items[0].authorName, '小B');
  assert.strictEqual(rep.data.items[0].cycleIndex, 1);
  assert.strictEqual(rep.data.items[0].noteId, 'n1');
  assert.strictEqual(rep.data.items[0].unread, true);
  assert.ok(rep.data.items[0].noteExcerpt.indexOf('打游戏') >= 0, '应带出被回复记录的摘要');
  ok('只把「伴侣对我记录的批注」算作回复（我批注对方记录不算）');

  const marked = await noteFn.main({ action: 'markRepliesRead', payload: { upTo: 200 } });
  assert.strictEqual(marked.data.readAt, 200);
  rep = await noteFn.main({ action: 'unreadReplies', payload: {} });
  assert.strictEqual(rep.data.unreadCount, 0);
  assert.strictEqual(rep.data.items.length, 1, '已读的回复仍保留在列表里，便于回看');
  assert.strictEqual(rep.data.items[0].unread, false);
  ok('标为已读后未读数归零，列表仍可回看');

  const back = await noteFn.main({ action: 'markRepliesRead', payload: { upTo: 100 } });
  assert.strictEqual(back.data.readAt, 200, '已读时间戳只向前推进');
  const future = await noteFn.main({ action: 'markRepliesRead', payload: { upTo: Date.now() + 86400000 } });
  assert.ok(future.data.readAt <= Date.now(), '不采信未来的时间戳');
  ok('已读位置只向前推进，且不采信未来时间');

  let removed = await noteFn.main({ action: 'remove', payload: { id: 'n2' } });
  assert.strictEqual(removed.ok, false);
  assert.ok(removed.error.includes('自己'));
  removed = await noteFn.main({ action: 'removeAnnotation', payload: { noteId: 'n1', annotationId: 'a1' } });
  assert.strictEqual(removed.ok, false);
  assert.ok(removed.error.includes('自己'));
  ok('云端拒绝删除对方笔记及对方批注（包括自己笔记上的对方批注）');

  removed = await noteFn.main({ action: 'removeAnnotation', payload: { noteId: 'n2', annotationId: 'a3' } });
  assert.strictEqual(removed.ok, true);
  assert.strictEqual(coll.notes.find((n) => n._id === 'n2').annotations.length, 0);
  ctxOpenid = 'openid_B';
  removed = await noteFn.main({ action: 'removeAnnotation', payload: { noteId: 'n1', annotationId: 'a1' } });
  assert.strictEqual(removed.ok, true);
  assert.deepStrictEqual(coll.notes.find((n) => n._id === 'n1').annotations.map((a) => a.id), ['a2']);
  ctxOpenid = 'openid_A';
  rep = await noteFn.main({ action: 'unreadReplies', payload: {} });
  assert.strictEqual(rep.data.items.length, 0);
  ok('删除自己批注保留其他批注，并从回复列表移除');

  coll.notes[0].pairId = 'other-pair';
  removed = await noteFn.main({ action: 'remove', payload: { id: 'n1' } });
  assert.strictEqual(removed.ok, false);
  coll.notes[0].pairId = 'p1';
  coll.pairs[0].status = 'archived';
  removed = await noteFn.main({ action: 'remove', payload: { id: 'n1' } });
  assert.strictEqual(removed.ok, false);
  coll.pairs[0].status = 'closed';
  ok('拒绝跨笔记本及失效配对删除');

  removed = await noteFn.main({ action: 'remove', payload: { id: 'n1' } });
  assert.strictEqual(removed.ok, true);
  assert.ok(!coll.notes.some((n) => n._id === 'n1'));
  assert.ok(coll.notes.some((n) => n._id === 'n2'));
  ok('云端允许删除已交换的自己的笔记及附属批注，不影响对方笔记');

  console.log('云函数：配对事务与内容安全故障');

  resetData({});
  ctxOpenid = 'openid_NEW';
  let pairResult = await pairFn.main({ action: 'get', payload: {} });
  assert.strictEqual(pairResult.ok, true);
  pairResult = await pairFn.main({ action: 'get', payload: {} });
  assert.strictEqual(pairResult.ok, true);
  assert.strictEqual(coll.users.filter((u) => u.openid === 'openid_NEW').length, 1);
  assert.ok(coll.users[0]._id.indexOf('u_') === 0);
  ok('首次用户使用确定性文档 ID，重复进入不会创建重复用户');

  for (const days of [undefined, '', 0, 91, 2.5]) {
    const invalid = await pairFn.main({ action: 'create', payload: { days } });
    assert.strictEqual(invalid.ok, false);
    assert.strictEqual(coll.pairs.length, 0);
  }
  const chosen = await pairFn.main({ action: 'create', payload: { days: 10 } });
  assert.strictEqual(chosen.ok, true, chosen.error);
  assert.strictEqual(coll.pairs[0].cycleDays, 10);
  ctxOpenid = 'openid_PARTNER';
  const preview = await pairFn.main({ action: 'preview', payload: { code: chosen.data.code } });
  assert.strictEqual(preview.data.cycleDays, 10);
  const joined = await pairFn.main({ action: 'join', payload: { code: chosen.data.code } });
  assert.strictEqual(joined.ok, true, joined.error);
  const first = await cycleFn.main({ action: 'getCurrent', payload: {} });
  assert.strictEqual(first.ok, true, first.error);
  assert.strictEqual(first.data.cycle.endDate, Math.floor((first.data.cycle.startDate + 28800000) / 86400000) * 86400000 - 28800000 + 10 * 86400000);
  ok('新邀请必须选择有效周期，接受前可预览，第一期按自定义10天创建');

  resetData({
    users: [
      { _id: 'uA', openid: 'openid_A', nickname: '小A', pairId: 'own' },
      { _id: 'uB', openid: 'openid_B', nickname: '小B', pairId: 'target' },
    ],
    pairs: [
      { _id: 'own', users: ['openid_A'], owner: 'openid_A', code: 'OWN123', status: 'open', cycleDays: 7 },
      { _id: 'target', users: ['openid_B'], owner: 'openid_B', code: 'JOIN88', status: 'open', cycleDays: 7 },
    ],
  });
  ctxOpenid = 'openid_A';
  pairResult = await pairFn.main({ action: 'join', payload: { code: 'JOIN88' } });
  assert.strictEqual(pairResult.ok, true, pairResult.error);
  assert.strictEqual(coll.pairs.find((p) => p._id === 'own').status, 'closed');
  assert.deepStrictEqual(coll.pairs.find((p) => p._id === 'target').users, ['openid_B', 'openid_A']);
  assert.strictEqual(coll.users.find((u) => u._id === 'uA').pairId, 'target');
  ok('接受邀请在一个事务内完成旧邀请作废、目标加入和用户绑定');

  coll.cycles.push({ _id: 'cyc_target_1', pairId: 'target', status: 'active', scores: {} });
  pairResult = await pairFn.main({ action: 'unbind', payload: {} });
  assert.strictEqual(pairResult.ok, true, pairResult.error);
  assert.strictEqual(coll.pairs.find((p) => p._id === 'target').status, 'archived');
  assert.strictEqual(coll.users.find((u) => u._id === 'uA').pairId, '');
  assert.strictEqual(coll.users.find((u) => u._id === 'uB').pairId, '');
  assert.strictEqual(coll.cycles[0].status, 'archived');
  ok('解绑原子归档配对并清空双方引用，随后终止活动周期');

  resetData({});
  ctxOpenid = 'openid_SAFE';
  securityFailure = new Error('security service timeout');
  pairResult = await pairFn.main({ action: 'setNickname', payload: { nickname: '不应保存' } });
  securityFailure = null;
  assert.strictEqual(pairResult.ok, false);
  assert.ok(pairResult.error.includes('安全检测暂时不可用'));
  assert.strictEqual(coll.users.length, 0);
  ok('内容安全服务故障时拒绝保存，不再失败放行');

  resetData({
    users: [U_A, U_B],
    pairs: [{ _id: 'p1', users: ['openid_A', 'openid_B'], status: 'closed', cycleDays: 7 }],
    cycles: [{ _id: 'cyc_p1_1', pairId: 'p1', index: 1, status: 'active', scores: {}, startDate: 1, endDate: Date.now() + 10000 }],
    notes: Array.from({ length: 100 }, (_, i) => ({
      _id: 'limit_' + i,
      pairId: 'p1',
      cycleId: 'cyc_p1_1',
      author: 'openid_A',
      type: 'happy',
      content: String(i),
      createdAt: i,
      annotations: [],
    })),
  });
  ctxOpenid = 'openid_A';
  const capped = await noteFn.main({ action: 'add', payload: { type: 'happy', content: '第101条' } });
  assert.strictEqual(capped.ok, false);
  assert.ok(capped.error.includes('最多记录 100 条'));
  assert.strictEqual(coll.notes.length, 100);
  ok('单期笔记达到展示上限后拒绝继续写入，避免内容静默消失');

  console.log('云函数：礼物与周期钻石');
  resetData({
    users: [{ _id: 'uA', openid: 'openid_A', nickname: '小A', pairId: 'p1' }, { _id: 'uB', openid: 'openid_B', nickname: '小B', pairId: 'p1' }],
    pairs: [{ _id: 'p1', users: ['openid_A', 'openid_B'], status: 'closed', cycleDays: 7 }],
    cycles: [{ _id: 'giftcycle1', pairId: 'p1', index: 1, status: 'active', scores: {}, startDate: Date.now(), endDate: Date.now() + 86400000 }],
  });
  ctxOpenid = 'openid_A';
  giftReadFailure = Object.assign(new Error('collection read failed: private-query'), { errCode: -502005 });
  const diagnosticFailure = await cycleFn.main({ action: 'getGiftState' });
  assert.strictEqual(diagnosticFailure.ok, false);
  assert.strictEqual(diagnosticFailure.diagnostic.stage, 'gift.inbox');
  assert.strictEqual(diagnosticFailure.diagnostic.code, '-502005');
  assert.strictEqual(diagnosticFailure.diagnostic.version, 'gift-diag-1');
  assert.ok(!JSON.stringify(diagnosticFailure).includes('private-query'));
  giftReadFailure = null;
  ok('礼物查询失败返回步骤和错误码，原始数据库消息不下发');
  let giftState = await cycleFn.main({ action: 'getGiftState' });
  assert.strictEqual(giftState.data.balance, 10);
  const giftPayload = { cycleId: 'giftcycle1', type: 'flower', requestId: 'test_flower_1', cost: 0, to: 'outsider' };
  giftWriteFailure = true;
  const writeFailed = await cycleFn.main({ action: 'sendGift', payload: giftPayload });
  assert.strictEqual(writeFailed.ok, false);
  assert.strictEqual(coll.gifts.length, 0);
  assert.strictEqual((coll.cycles[0].giftLedger || []).length, 0);
  giftWriteFailure = false;
  ok('礼物写入失败时事务回滚，不扣钻石');
  const sendFlower = await cycleFn.main({ action: 'sendGift', payload: giftPayload });
  assert.strictEqual(sendFlower.ok, true, sendFlower.error);
  assert.strictEqual(sendFlower.data.balance, 9);
  assert.strictEqual(coll.gifts[0].to, 'openid_B');
  assert.strictEqual(coll.gifts[0].cost, 1);
  const repeatFlower = await cycleFn.main({ action: 'sendGift', payload: giftPayload });
  assert.strictEqual(repeatFlower.data.id, sendFlower.data.id);
  assert.strictEqual(repeatFlower.data.balance, 9);
  assert.strictEqual(coll.gifts.length, 1);
  ok('价格与收件人由服务端决定，同请求重试只扣一次');
  const invalidGift = await cycleFn.main({ action: 'sendGift', payload: { ...giftPayload, type: '__proto__' } });
  assert.strictEqual(invalidGift.ok, false);
  const expensive = await cycleFn.main({ action: 'sendGift', payload: { ...giftPayload, type: 'car', requestId: 'test_car_fail' } });
  assert.strictEqual(expensive.ok, false);
  assert.strictEqual(coll.gifts.length, 1);
  const sendLetter = await cycleFn.main({ action: 'sendGift', payload: { ...giftPayload, type: 'letter', requestId: 'test_letter_1' } });
  assert.strictEqual(sendLetter.data.balance, 4);
  await cycleFn.main({ action: 'acknowledgeGift', payload: { id: sendFlower.data.id } });
  assert.strictEqual(coll.gifts[0].seen, false);
  ctxOpenid = 'openid_B';
  giftState = await cycleFn.main({ action: 'getGiftState' });
  assert.strictEqual(giftState.data.balance, 10);
  assert.strictEqual(giftState.data.inbox.length, 2);
  assert.ok(!JSON.stringify(giftState.data.inbox).includes('openid_'));
  const sendCar = await cycleFn.main({ action: 'sendGift', payload: { ...giftPayload, type: 'car', requestId: 'test_car_1' } });
  assert.strictEqual(sendCar.data.balance, 0);
  await cycleFn.main({ action: 'acknowledgeGift', payload: { id: sendFlower.data.id } });
  giftState = await cycleFn.main({ action: 'getGiftState' });
  assert.strictEqual(giftState.data.inbox.length, 1);
  ok('三种价格正确、双方余额独立、余额不足拒绝，仅收件人可标记已读');
  coll.cycles[0].status = 'exchanged';
  coll.cycles.push({ _id: 'giftcycle2', pairId: 'p1', index: 2, status: 'active', scores: {}, startDate: Date.now(), endDate: Date.now() + 86400000 });
  giftState = await cycleFn.main({ action: 'getGiftState' });
  assert.strictEqual(giftState.data.balance, 10);
  assert.strictEqual(giftState.data.inbox.length, 1);
  const staleGift = await cycleFn.main({ action: 'sendGift', payload: { ...giftPayload, requestId: 'test_old_cycle' } });
  assert.strictEqual(staleGift.ok, false);
  ctxOpenid = 'openid_A';
  const oldRetry = await cycleFn.main({ action: 'sendGift', payload: giftPayload });
  assert.strictEqual(oldRetry.data.id, sendFlower.data.id);
  giftState = await cycleFn.main({ action: 'getGiftState' });
  assert.strictEqual(giftState.data.balance, 10);
  assert.strictEqual(giftState.data.inbox[0].type, 'car');
  ctxOpenid = 'openid_B';
  const unreadIds = coll.gifts.filter((g) => g.to === 'openid_B' && !g.seen).map((g) => g._id);
  const ackBatch = await cycleFn.main({ action: 'acknowledgeGift', payload: { ids: unreadIds.concat(sendCar.data.id) } });
  assert.strictEqual(ackBatch.ok, true);
  assert.ok(coll.gifts.filter((g) => unreadIds.includes(g._id)).every((g) => g.seen));
  assert.strictEqual(coll.gifts.find((g) => g._id === sendCar.data.id).seen, false);
  for (const ids of [[], [null], Array(21).fill(sendCar.data.id)]) {
    assert.strictEqual((await cycleFn.main({ action: 'acknowledgeGift', payload: { ids } })).ok, false);
  }
  ctxOpenid = 'openid_A';
  ok('批量收下校验编号及数量，不能标记其他收件人的礼物');
  const quantityPayload = { cycleId: 'giftcycle2', type: 'flower', quantity: 10, requestId: 'quantity_test_10' };
  for (const quantity of [0, -1, 1.5, '2', 11, null]) {
    assert.strictEqual((await cycleFn.main({ action: 'sendGift', payload: { ...quantityPayload, quantity } })).ok, false);
  }
  const quantitySend = await cycleFn.main({ action: 'sendGift', payload: quantityPayload });
  assert.strictEqual(quantitySend.ok, true);
  assert.strictEqual(quantitySend.data.balance, 0);
  assert.strictEqual(coll.gifts.find((g) => g._id === quantitySend.data.id).quantity, 10);
  assert.strictEqual((await cycleFn.main({ action: 'sendGift', payload: quantityPayload })).data.id, quantitySend.data.id);
  assert.strictEqual((await cycleFn.main({ action: 'sendGift', payload: { ...quantityPayload, quantity: 1 } })).ok, false);
  assert.strictEqual((await cycleFn.main({ action: 'sendGift', payload: { ...quantityPayload, requestId: 'quantity_overdraw' } })).ok, false);
  ctxOpenid = 'openid_B';
  assert.strictEqual((await cycleFn.main({ action: 'getGiftState' })).data.inbox[0].quantity, 10);
  ctxOpenid = 'openid_A';
  ok('一次送十份原子扣费、数量校验、防透支、重试幂等且不能篡改数量');
  coll.pairs[0].status = 'archived';
  const archivedGift = await cycleFn.main({ action: 'sendGift', payload: { ...giftPayload, cycleId: 'giftcycle2', requestId: 'test_archived' } });
  assert.strictEqual(archivedGift.ok, false);
  giftState = await cycleFn.main({ action: 'getGiftState' });
  assert.strictEqual(giftState.data.available, false);
  ok('新周期恢复10颗、旧礼物未读保留、旧请求不扣新余额、解绑后不能赠送');

  resetData({
    users: [{ _id: 'uA', openid: 'openid_A', nickname: '小A', pairId: 'p1' }, { _id: 'uB', openid: 'openid_B', nickname: '小B', pairId: 'p1' }],
    pairs: [{ _id: 'p1', users: ['openid_A', 'openid_B'], status: 'closed', cycleDays: 7 }],
    cycles: [{ _id: 'allowance_old', pairId: 'p1', index: 1, status: 'active', scores: {}, endDate: Date.now() + 86400000 }],
  });
  ctxOpenid = 'openid_A';
  for (const amount of [-1, 101, 1.5, '10', '', null]) {
    assert.strictEqual((await pairFn.main({ action: 'updateDiamondAllowance', payload: { amount } })).ok, false);
  }
  assert.strictEqual((await pairFn.main({ action: 'updateDiamondAllowance', payload: { amount: 100 } })).ok, true);
  ctxOpenid = 'openid_B';
  assert.strictEqual((await pairFn.main({ action: 'get' })).data.pair.diamondAllowance, 100);
  assert.strictEqual((await cycleFn.main({ action: 'getGiftState' })).data.balance, 10);
  coll.cycles[0].status = 'exchanged';
  assert.strictEqual((await cycleFn.main({ action: 'getGiftState' })).data.balance, 100);
  ctxOpenid = 'openid_A';
  assert.strictEqual((await cycleFn.main({ action: 'getGiftState' })).data.balance, 100);
  await pairFn.main({ action: 'updateDiamondAllowance', payload: { amount: 0 } });
  assert.strictEqual((await cycleFn.main({ action: 'getGiftState' })).data.balance, 100);
  const activeAllowance = coll.cycles.find((c) => c.status === 'active');
  activeAllowance.endDate = Date.now() - 1000;
  activeAllowance.scores = { openid_A: { score: 8 }, openid_B: { score: 8 } };
  await reminderFn.main();
  const zeroState = (await cycleFn.main({ action: 'getGiftState' })).data;
  assert.strictEqual(zeroState.balance, 0);
  assert.strictEqual(zeroState.allowance, 0);
  assert.strictEqual((await cycleFn.main({ action: 'sendGift', payload: { cycleId: zeroState.cycleId, type: 'flower', requestId: 'zero_allowance_test' } })).ok, false);
  ctxOpenid = 'openid_B';
  assert.strictEqual((await cycleFn.main({ action: 'getGiftState' })).data.balance, 0);
  ctxOpenid = 'outsider';
  assert.strictEqual((await pairFn.main({ action: 'updateDiamondAllowance', payload: { amount: 30 } })).ok, false);
  ctxOpenid = 'openid_A';
  coll.pairs[0].status = 'archived';
  assert.strictEqual((await pairFn.main({ action: 'updateDiamondAllowance', payload: { amount: 30 } })).ok, false);
  ok('共用额度0–100整数校验、旧期不变、新期双方一致、定时换期支持0、非成员及归档禁止修改');

  for (const amount of [undefined, 0, 37, 100]) {
    resetData({
      users: [{ _id: 'uA', openid: 'openid_A', nickname: '小A', pairId: 'p1' }, { _id: 'uB', openid: 'openid_B', nickname: '小B', pairId: 'p1' }],
      pairs: [{ _id: 'p1', users: ['openid_A', 'openid_B'], status: 'closed', cycleDays: 7, diamondAllowance: amount }],
      cycles: [],
    });
    ctxOpenid = 'openid_A';
    assert.strictEqual((await noteFn.main({ action: 'listMine' })).ok, true);
    assert.strictEqual(coll.cycles[0].diamondAllowance, amount === undefined ? 10 : amount);
    assert.strictEqual((await cycleFn.main({ action: 'getGiftState' })).data.balance, amount === undefined ? 10 : amount);
    const staleScore = await cycleFn.main({ action: 'submitScore', payload: { cycleId: 'old_cycle', score: 2 } });
    assert.strictEqual(staleScore.ok, false);
    assert.deepStrictEqual(coll.cycles[0].scores, {});
  }
  ok('记录页建周期继承默认/0/37/100额度，旧周期打分请求不能写入新周期');

  resetData({
    users: [{ _id: 'uA', openid: 'openid_A', nickname: '小A', pairId: 'pAB' }, { _id: 'uB', openid: 'openid_B', nickname: '小B', pairId: 'pAB' }, { _id: 'uC', openid: 'openid_C', nickname: '小C', pairId: '' }],
    pairs: [{ _id: 'pAB', users: ['openid_A', 'openid_B'], status: 'closed', cycleDays: 14, diamondAllowance: 27, createdAt: 1 }],
    cycles: [
      { _id: 'pastAB', pairId: 'pAB', index: 1, status: 'exchanged', scores: { openid_A: { score: 8 }, openid_B: { score: 9 } } },
      { _id: 'pausedAB', pairId: 'pAB', index: 2, status: 'active', endDate: Date.now() - 1000, scores: { openid_A: { score: 3 }, openid_B: { score: 4 } } },
    ],
    notes: [{ _id: 'keptNote', pairId: 'pAB', cycleId: 'pastAB', author: 'openid_B', content: '共同历史', annotations: [] }],
    events: [{ _id: 'privatePaused', pairId: 'pAB', cycleId: 'pausedAB', author: 'openid_B', reason: '未交换私密事件', createdAt: 1 }],
  });
  ctxOpenid = 'openid_A';
  assert.strictEqual((await pairFn.main({ action: 'unbind' })).ok, true);
  const pauseTime = coll.cycles.find((c) => c._id === 'pausedAB').pausedAt;
  assert.ok(pauseTime);
  await reminderFn.main();
  assert.strictEqual(coll.cycles.find((c) => c._id === 'pausedAB').status, 'archived');
  const reunionInvite = await pairFn.main({ action: 'create', payload: { days: 3 } });
  ctxOpenid = 'openid_B';
  const reunionPreview = await pairFn.main({ action: 'preview', payload: { code: reunionInvite.data.code } });
  assert.strictEqual(reunionPreview.data.restoresHistory, true);
  assert.strictEqual(reunionPreview.data.cycleDays, 14);
  const reunion = await pairFn.main({ action: 'join', payload: { code: reunionInvite.data.code } });
  assert.strictEqual(reunion.ok, true, reunion.error);
  assert.strictEqual(reunion.data.restored, true);
  assert.strictEqual(reunion.data.pair._id, 'pAB');
  assert.ok(coll.users.filter((u) => u._id !== 'uC').every((u) => u.pairId === 'pAB'));
  const resumed = coll.cycles.find((c) => c.pairId === 'pAB' && c.status === 'active');
  assert.strictEqual(resumed.index, 3);
  assert.deepStrictEqual(resumed.scores, {});
  assert.strictEqual(resumed.diamondAllowance, 27);
  assert.strictEqual(resumed.endDate, Math.floor((resumed.startDate + 28800000) / 86400000) * 86400000 - 28800000 + 14 * 86400000);
  assert.ok(coll.cycles.find((c) => c._id === 'pausedAB').resumedAt >= pauseTime);
  ctxOpenid = 'openid_A';
  const reunionHistory = await trackFn.main({ action: 'history' });
  assert.deepStrictEqual(reunionHistory.data.rows.map((r) => r.gap), [false, true]);
  assert.strictEqual(reunionHistory.data.rows[1].partnerScore, null);
  assert.strictEqual(reunionHistory.data.events.length, 0);
  assert.ok((await cycleFn.main({ action: 'getDetail', payload: { cycleId: 'pastAB' } })).data.notes.some((n) => n.content === '共同历史'));
  await pairFn.main({ action: 'unbind' });
  const anotherInvite = await pairFn.main({ action: 'create', payload: { days: 7 } });
  ctxOpenid = 'openid_C';
  const different = await pairFn.main({ action: 'join', payload: { code: anotherInvite.data.code } });
  assert.strictEqual(different.ok, true, different.error);
  assert.notStrictEqual(different.data.pair._id, 'pAB');
  assert.strictEqual((await trackFn.main({ action: 'history' })).data.rows.length, 0);
  assert.strictEqual((await cycleFn.main({ action: 'getDetail', payload: { cycleId: 'pastAB' } })).ok, false);
  await pairFn.main({ action: 'unbind' });
  ctxOpenid = 'openid_B';
  const thirdInvite = await pairFn.main({ action: 'create', payload: { days: 5 } });
  ctxOpenid = 'openid_A';
  assert.strictEqual((await pairFn.main({ action: 'join', payload: { code: thirdInvite.data.code } })).data.pair._id, 'pAB');
  assert.strictEqual(coll.cycles.find((c) => c.pairId === 'pAB' && c.status === 'active').index, 4);
  assert.strictEqual(coll.notes.length, 1);
  ok('解绑暂停交换、同伴侣恢复旧记录和设置并开新期、未交换内容不泄露、换伴侣隔离、反复恢复保留断点');

  const realNow = Date.now;
  try {
    for (const days of [1, 7]) {
      let clock = Date.UTC(2026, 8, 28, 12); // 北京时间20点
      Date.now = () => clock;
      const midnight = Date.UTC(2026, 8, 28, 16);
      resetData({
        users: [{ _id: 'uA', openid: 'openid_A', nickname: '小A', pairId: 'p1' }, { _id: 'uB', openid: 'openid_B', nickname: '小B', pairId: 'p1' }],
        pairs: [{ _id: 'p1', users: ['openid_A', 'openid_B'], status: 'closed', cycleDays: days, diamondAllowance: 25 }],
        cycles: [{ _id: 'early', pairId: 'p1', index: 1, status: 'active', startDate: clock, endDate: clock + days * 86400000, diamondAllowance: 10,
          exchangeRequest: { from: 'openid_A' }, scores: { openid_A: { score: 8 }, openid_B: { score: 9 } } }],
      });
      ctxOpenid = 'openid_B';
      const early = await cycleFn.main({ action: 'agreeExchange' });
      assert.strictEqual(early.ok, true, early.error);
      assert.strictEqual(early.data.nextOpenAt, midnight);
      assert.strictEqual(coll.cycles.length, 1);
      assert.strictEqual((await cycleFn.main({ action: 'getCurrent' })).data.cycle.status, 'exchanged');
      assert.strictEqual((await cycleFn.main({ action: 'submitScore', payload: { score: 1, cycleId: 'early' } })).ok, false);
      assert.strictEqual((await cycleFn.main({ action: 'requestExchange' })).ok, false);
      const extra = await noteFn.main({ action: 'add', payload: { type: 'happy', content: '交换后的补充' } });
      assert.strictEqual(extra.ok, true, extra.error);
      assert.strictEqual(extra.data.cycleId, 'early');
      ctxOpenid = 'openid_A';
      assert.ok((await cycleFn.main({ action: 'getDetail', payload: { cycleId: 'early' } })).data.notes.some((n) => n.content === '交换后的补充'));
      assert.strictEqual((await noteFn.main({ action: 'annotate', payload: { noteId: extra.data.id, content: '看到了' } })).ok, true);
      const giftBefore = await cycleFn.main({ action: 'sendGift', payload: { type: 'flower', cycleId: 'early', requestId: 'midnight_flower' } });
      assert.strictEqual(giftBefore.data.balance, 9);
      clock = midnight - 1;
      await reminderFn.main();
      assert.strictEqual((await cycleFn.main({ action: 'getGiftState' })).data.balance, 9);
      assert.strictEqual((await noteFn.main({ action: 'listMine' })).data.cycle.id, 'early');
      assert.strictEqual(coll.cycles.length, 1);
      clock = midnight;
      // 记录页先进入，也必须只在零点开始新期，并保留配置额度。
      const newNote = await noteFn.main({ action: 'add', payload: { type: 'happy', content: '新一天' } });
      assert.strictEqual(newNote.ok, true, newNote.error);
      assert.notStrictEqual(newNote.data.cycleId, 'early');
      const after = (await cycleFn.main({ action: 'getCurrent' })).data;
      assert.strictEqual(after.cycle.index, 2);
      assert.strictEqual(after.cycle.startDate, midnight);
      assert.strictEqual(after.cycle.endDate, midnight + days * 86400000);
      assert.strictEqual(after.myScore, null);
      assert.strictEqual((await cycleFn.main({ action: 'getGiftState' })).data.balance, 25);
      assert.strictEqual(coll.cycles.length, 2);
    }
  } finally { Date.now = realNow; }
  ok('1/7天周期提前交换均等北京时间次日0点；之前可补笔记批注和送礼，不可改分再交换；零点记录页开新期并重置额度');

  resetData({
    users: [{ _id: 'uA', openid: 'openid_A', pairId: 'p1' }, { _id: 'uB', openid: 'openid_B', pairId: 'p1' }],
    pairs: [{ _id: 'p1', status: 'closed', users: ['openid_A', 'openid_B'] }],
    cycles: Array.from({ length: 250 }, (_, i) => ({ _id: 'history_' + (i + 1), pairId: 'p1', index: i + 1,
      status: i === 100 ? 'archived' : 'exchanged', scores: { openid_A: { score: 8 }, openid_B: { score: 9 } } })),
    events: Array.from({ length: 120 }, (_, i) => ({ _id: 'event_' + String(i).padStart(3, '0'), pairId: 'p1', cycleId: 'history_1', cycleIndex: 1, author: 'openid_B', date: i, reason: '很久以前' })),
  });
  ctxOpenid = 'openid_A';
  let beforeIndex;
  const pagedRows = [];
  do {
    const payload = beforeIndex ? { pageSize: 21, beforeIndex } : { pageSize: 21 };
    const page = await trackFn.main({ action: 'history', payload });
    assert.strictEqual(page.ok, true, page.error);
    assert.ok(page.data.rows.length <= 21);
    pagedRows.unshift(...page.data.rows);
    beforeIndex = page.data.nextBeforeIndex;
  } while (beforeIndex);
  assert.deepStrictEqual(pagedRows.map((r) => r.index), Array.from({ length: 250 }, (_, i) => i + 1));
  assert.strictEqual(pagedRows[100].gap, true);
  assert.strictEqual(pagedRows[0].eventCount, 120);
  let beforeId;
  const eventIds = [];
  do {
    const payload = Object.assign({ cycleId: 'history_1' }, beforeId ? { beforeId } : {});
    const page = await trackFn.main({ action: 'cycleEvents', payload });
    assert.strictEqual(page.ok, true, page.error);
    eventIds.push(...page.data.events.map((e) => e.id));
    beforeId = page.data.nextBeforeId;
  } while (beforeId);
  assert.strictEqual(new Set(eventIds).size, 120);
  coll.cycles.push({ _id: 'other_pair', pairId: 'p2', status: 'exchanged' });
  assert.strictEqual((await trackFn.main({ action: 'cycleEvents', payload: { cycleId: 'other_pair' } })).ok, false);
  assert.strictEqual((await trackFn.main({ action: 'history', payload: { pageSize: 1000 } })).ok, false);
  ok('250期游标分页无遗漏无重复，暂停保留，旧期120条事件可分页读完且禁止跨配对读取');

  resetData({ users:[{_id:'ua',openid:'openid_A',pairId:'p1'},{_id:'ub',openid:'openid_B',pairId:'p1'}], pairs:[{_id:'p1',users:['openid_A','openid_B'],status:'closed',cycleDays:1}],
    cycles:[{_id:'c1',pairId:'p1',index:1,status:'active',scores:{},startDate:Date.now(),endDate:Date.now()+86400000}],
    notes:Array.from({length:101},(_,i)=>({_id:'n'+String(i).padStart(3,'0'),pairId:'p1',cycleId:'c1',author:'openid_A',createdAt:i,annotations:i===0?[{id:'ann',author:'openid_B',createdAt:Date.now(),content:'旧笔记的新回复'}]:[]})) });
  ctxOpenid='openid_A';
  const oldReply=await noteFn.main({action:'unreadReplies'});
  assert.strictEqual(oldReply.data.unreadCount,1,'最旧笔记的新批注不可遗漏');
  assert.ok(!JSON.stringify(oldReply.data).includes('openid_'),'回复接口不返回openid');
  coll.notes.splice(0,2);
  const saves=await Promise.all([noteFn.main({action:'add',payload:{type:'happy',content:'one'}}),noteFn.main({action:'add',payload:{type:'happy',content:'two'}})]);
  assert.strictEqual(saves.filter(r=>r.ok).length,1,'99条时并发写入只允许一个成功');
  assert.strictEqual(coll.notes.length,100);
  assert.ok(!JSON.stringify(saves.find(r=>r.ok).data).includes('openid_'));
  const added=saves.find(r=>r.ok).data;
  assert.strictEqual((await noteFn.main({action:'remove',payload:{id:added.id}})).ok,true);
  assert.strictEqual((await noteFn.main({action:'add',payload:{type:'happy',content:'released slot'}})).ok,true);
  const ev=await trackFn.main({action:'addEvent',payload:{cycleId:'c1',reason:'event',prevScore:1,newScore:2}});
  assert.strictEqual(ev.ok,true);
  assert.ok(!JSON.stringify(ev.data).includes('openid_'));
  await Promise.all([noteFn.main({action:'markRepliesRead',payload:{upTo:200}}),noteFn.main({action:'markRepliesRead',payload:{upTo:100}})]);
  assert.strictEqual(coll.users[0].replyReadAt,200);
  ok('旧笔记回复分页无遗漏、并发名额与删除释放、已读单调、响应无openid');

  for (const fn of [cycleFn,noteFn]) {
    resetData({users:[{_id:'ua',openid:'openid_A',pairId:'p1'},{_id:'ub',openid:'openid_B',pairId:'p1'}],pairs:[{_id:'p1',users:['openid_A','openid_B'],status:'closed',cycleDays:1}]});
    const originalGet=Query.prototype.get;
    let fired=false;
    Query.prototype.get=async function() {
      if (!fired && this.name==='cycles' && this.cond.status==='active') {
        fired=true;
        const unbind=await pairFn.main({action:'unbind'});
        assert.strictEqual(unbind.ok,true,unbind.error);
      }
      return originalGet.call(this);
    };
    let stale;
    try { stale=await fn.main({action:fn===cycleFn?'getCurrent':'listMine'}); }
    finally { Query.prototype.get=originalGet; }
    assert.strictEqual(stale.ok,false,'解绑后的旧请求不可继续建期');
    assert.strictEqual(coll.cycles.filter(c=>c.status==='active').length,0);
  }
  ok('首页/记录页与解绑并发，封存后不再建活动周期');
  const helperFs = require('fs');
  const helperPath = name => path.join(__dirname, '..', 'cloudfunctions', name, 'cycle-store.js');
  const helperSource = helperFs.readFileSync(helperPath('cycle'), 'utf8');
  for (const name of ['cycle', 'note', 'reminder']) {
    assert.strictEqual(helperFs.readFileSync(helperPath(name), 'utf8'), helperSource, '建周期保护副本保持一致');
    resetData({ pairs: [{ _id: 'p1', users: ['openid_A', 'openid_B'], status: 'closed', pausedAt: 100, resumedAt: 200 }] });
    const create = require(helperPath(name));
    const dbForTest = { collection, runTransaction };
    await assert.rejects(() => create(dbForTest, { _id: 'p1' }, { index: 2, status: 'active' }), /配对状态已变化/);
    assert.strictEqual(coll.cycles.length, 0, '复合后拒绝解绑前遗留的建期请求');
    assert.strictEqual(await create(dbForTest, { ...coll.pairs[0] }, { index: 2, status: 'active' }), true);
    assert.strictEqual(await create(dbForTest, { ...coll.pairs[0] }, { index: 2, status: 'active' }), false);
    assert.strictEqual(coll.cycles.length, 1, '相同期号重复创建幂等');
  }
  ok('三个建期入口保护一致，复合后旧请求失效，相同期号创建幂等');
  const calendarPaths = ['cycle', 'note', 'pair', 'reminder'].map(name => path.join(__dirname, '..', 'cloudfunctions', name, 'cycle-calendar.js'));
  calendarPaths.push(path.join(__dirname, '..', 'miniprogram/utils/cycle-calendar.js'));
  calendarPaths.forEach(file => assert.strictEqual(helperFs.readFileSync(file, 'utf8'), helperFs.readFileSync(calendarPaths[0], 'utf8')));
  try {
    let clock = Date.parse('2026-10-07T20:00:00+08:00');
    Date.now = () => clock;
    const nextMidnight = Date.parse('2026-10-08T00:00:00+08:00');
    const seedCalendar = days => resetData({
      users: [{ _id: 'ua', openid: 'openid_A', pairId: 'p1' }, { _id: 'ub', openid: 'openid_B', pairId: 'p1' }],
      pairs: [{ _id: 'p1', status: 'closed', users: ['openid_A', 'openid_B'], cycleDays: days }],
    });
    ctxOpenid = 'openid_A';
    for (const days of [1, 7]) {
      for (const entry of [cycleFn, noteFn]) {
        clock = Date.parse('2026-10-07T20:00:00+08:00');
        seedCalendar(days);
        const result = await entry.main({ action: entry === cycleFn ? 'getCurrent' : 'listMine' });
        assert.strictEqual(result.ok, true, result.error);
        const current = coll.cycles[0];
        const deadline = nextMidnight + (days - 1) * 86400000;
        assert.strictEqual(current.endDate, deadline, '首次建期按自然日到零点');
        current.scores = { openid_A: { score: 8 }, openid_B: { score: 9 } };
        clock = deadline - 1;
        await reminderFn.main();
        assert.strictEqual(current.status, 'active', '零点前不自动交换');
        clock = deadline;
        const exchanged = await reminderFn.main();
        assert.strictEqual(exchanged.data.autoExchanged, 1);
        assert.strictEqual(current.status, 'exchanged');
        assert.strictEqual(coll.cycles.find(c => c.index === 2).endDate, deadline + days * 86400000);
      }
    }
    for (const entry of [cycleFn, noteFn, reminderFn]) {
      clock = nextMidnight;
      seedCalendar(7); // 设置已改为7天，但旧的本期仍然是1天。
      const start = Date.parse('2026-10-07T20:00:00+08:00');
      coll.cycles.push({ _id: 'legacy', pairId: 'p1', index: 1, status: 'active', startDate: start, endDate: start + 86400000, scores: { openid_A: { score: 8 } } });
      await entry.main({ action: entry === cycleFn ? 'getCurrent' : 'listMine' });
      assert.strictEqual(coll.cycles[0].endDate, nextMidnight, '旧活动周期沿用原定天数校正');
      assert.strictEqual(coll.cycles[0].status, 'active', '缺少一方分数时继续等待');
      clock = nextMidnight + 20 * 3600000;
      ctxOpenid = 'openid_B';
      const scored = await cycleFn.main({ action: 'submitScore', payload: { score: 9, cycleId: 'legacy' } });
      assert.strictEqual(scored.ok, true, scored.error);
      assert.strictEqual(scored.data.autoExchanged, true);
      assert.strictEqual(coll.cycles.find(c => c.index === 2).endDate, nextMidnight + 7 * 86400000, '补分后的新期也按自然日结束');
      ctxOpenid = 'openid_A';
    }
  } finally { Date.now = realNow; }
  ok('自然日零点边界：1/7天、首页/记录/定时入口、旧期校正、未打齐等待及补分');
  console.log(`\n全部通过：${passed} 项云函数断言 ✓`);
})().catch((e) => {
  console.error('\n✗ 测试失败：' + (e && e.message));
  process.exit(1);
});
