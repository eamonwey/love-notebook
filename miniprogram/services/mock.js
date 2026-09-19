/**
 * 本地模拟后端：无需开通云开发，即可在开发者工具里完整体验双人流程。
 * 数据存在本地缓存，通过「设置 - 演示身份」在 小A / 小B 之间切换，
 * 分别打分、记录、交换，即可模拟两个人。
 */
const { DAY } = require('../utils/date.js');

const DB_KEY = 'LOVE_MOCK_DB_V1';
const ME_KEY = 'LOVE_MOCK_ME';

/* ---------- 存储基础 ---------- */

function loadDB() {
  let db = wx.getStorageSync(DB_KEY);
  if (!db || !db.cycles || !db.cycles.length) {
    db = seed();
    saveDB(db);
  }
  return db;
}

function saveDB(db) {
  wx.setStorageSync(DB_KEY, db);
}

function seed() {
  const now = Date.now();
  const pair = { id: 'pair_demo', cycleDays: 7, createdAt: now };
  return {
    seq: 1,
    users: {
      userA: { id: 'userA', name: '小A' },
      userB: { id: 'userB', name: '小B' },
    },
    pairs: [pair],
    cycles: [makeCycle(pair, 1, now)],
    notes: [],
    events: [],
  };
}

function makeCycle(pair, index, startMs) {
  const days = pair.cycleDays || 7;
  return {
    id: 'c' + index + '_' + startMs,
    pairId: pair.id,
    index: index,
    startDate: startMs,
    endDate: startMs + days * DAY,
    status: 'active', // active | exchanged
    scores: {}, // { userA: {score, comment, scoredAt}, userB: {...} }
    exchangedAt: null,
  };
}

function nextId(db, prefix) {
  db.seq = (db.seq || 1) + 1;
  return prefix + db.seq;
}

/* ---------- 身份 ---------- */

function getMe() {
  return wx.getStorageSync(ME_KEY) || 'userA';
}

function setMe(id) {
  if (id !== 'userA' && id !== 'userB') throw new Error('无效身份');
  wx.setStorageSync(ME_KEY, id);
  return id;
}

function partnerOf(id) {
  return id === 'userA' ? 'userB' : 'userA';
}

/* ---------- 周期 ---------- */

function getPair(db) {
  return db.pairs[0];
}

function ensureCurrent(db, now) {
  let cur = null;
  db.cycles.forEach((c) => {
    if (c.status === 'active') cur = c;
  });
  if (cur) return cur;
  let maxIndex = 0;
  db.cycles.forEach((c) => {
    if (c.index > maxIndex) maxIndex = c.index;
  });
  const next = makeCycle(getPair(db), maxIndex + 1, now);
  db.cycles.push(next);
  saveDB(db);
  return next;
}

function latestExchangedBefore(db, index) {
  let found = null;
  db.cycles.forEach((c) => {
    if (c.status === 'exchanged' && c.index < index && (!found || c.index > found.index)) found = c;
  });
  return found;
}

function latestExchanged(db) {
  let found = null;
  db.cycles.forEach((c) => {
    if (c.status === 'exchanged' && (!found || c.index > found.index)) found = c;
  });
  return found;
}

// 周期到期且双方已打分：自动交换（打开首页/补打分时触发）
function maybeAutoExchange(db, now) {
  const pair = getPair(db);
  let cycle = null;
  db.cycles.forEach((c) => {
    if (c.status === 'active') cycle = c;
  });
  if (!cycle || now < cycle.endDate) return false;
  if (!(cycle.scores.userA && cycle.scores.userB)) return false;
  cycle.status = 'exchanged';
  cycle.exchangedAt = now;
  cycle.exchangeRequest = null;
  cycle.exchangePlan = null;
  db.cycles.push(makeCycle(pair, cycle.index + 1, now));
  return true;
}

/* ---------- 输出整形 ---------- */

function pubScore(s) {
  return s ? { score: s.score, comment: s.comment, scoredAt: s.scoredAt } : null;
}

function publishNote(db, n, me) {
  return {
    id: n.id,
    cycleId: n.cycleId,
    type: n.type,
    content: n.content,
    createdAt: n.createdAt,
    author: n.author,
    authorName: db.users[n.author] ? db.users[n.author].name : '匿名',
    mine: n.author === me,
    annotations: (n.annotations || []).map((a) => ({
      id: a.id,
      content: a.content,
      createdAt: a.createdAt,
      author: a.author,
      authorName: db.users[a.author] ? db.users[a.author].name : '匿名',
    })),
  };
}

/* ---------- 对外接口（与 cloud.js 同构） ---------- */

async function init() {
  const db = loadDB();
  ensureCurrent(db, Date.now());
  return true;
}

async function getAppStatus() {
  const db = loadDB();
  const now = Date.now();
  // 到期兜底判定：若已到期且双方已打分，先自动交换再开新一期
  if (maybeAutoExchange(db, now)) saveDB(db);
  const cycle = ensureCurrent(db, now);
  const me = getMe();
  const partner = partnerOf(me);
  const pair = getPair(db);
  const last = latestExchanged(db);
  let exchangedCount = 0;
  db.cycles.forEach((c) => {
    if (c.status === 'exchanged') exchangedCount++;
  });
  return {
    isMock: true,
    me: me,
    users: db.users,
    bound: true,
    pair: { id: pair.id, cycleDays: pair.cycleDays },
    cycle: {
      id: cycle.id,
      index: cycle.index,
      startDate: cycle.startDate,
      endDate: cycle.endDate,
      status: cycle.status,
    },
    myScore: pubScore(cycle.scores[me]),
    partnerDone: !!cycle.scores[partner],
    bothScored: !!(cycle.scores.userA && cycle.scores.userB),
    exchangeRequest: cycle.exchangeRequest || null,
    exchangePlan: cycle.exchangePlan || null,
    lastExchanged: last ? { id: last.id, index: last.index } : null,
    exchangedCount: exchangedCount,
  };
}

async function submitScore(payload) {
  const score = Math.round(Number(payload.score));
  if (isNaN(score) || score < 0 || score > 10) throw new Error('分数需要在 0-10 之间');
  const comment = (payload.comment || '').trim();
  if (comment.length > 200) throw new Error('留言不能超过 200 字');
  const db = loadDB();
  const cycle = ensureCurrent(db, Date.now());
  const me = getMe();
  if (cycle.status !== 'active') throw new Error('本期已交换');
  cycle.scores[me] = {
    score: score,
    comment: comment,
    scoredAt: Date.now(),
  };
  const prev = latestExchangedBefore(db, cycle.index);
  const prevScore = prev && prev.scores[me] ? prev.scores[me].score : null;
  saveDB(db);
  // 周期已到期且这是最后一块拼图：立即自动交换
  const autoExchanged = maybeAutoExchange(db, Date.now());
  if (autoExchanged) saveDB(db);
  return {
    ok: true,
    score: score,
    cycleId: cycle.id,
    prevScore: prevScore,
    changed: prevScore !== null && prevScore !== score,
    autoExchanged: autoExchanged,
  };
}

async function requestExchange() {
  const db = loadDB();
  const cycle = ensureCurrent(db, Date.now());
  const me = getMe();
  const existing = cycle.exchangeRequest;
  if (existing && existing.from && existing.from !== me) {
    throw new Error('对方已向你发起交换请求，请先在下方同意或暂不');
  }
  cycle.exchangeRequest = { from: me, at: Date.now() };
  saveDB(db);
  return { ok: true, resent: !!(existing && existing.from === me) };
}

async function cancelExchangeRequest() {
  const db = loadDB();
  const cycle = ensureCurrent(db, Date.now());
  cycle.exchangeRequest = null;
  saveDB(db);
  return { ok: true };
}

async function agreeExchange() {
  const db = loadDB();
  const cycle = ensureCurrent(db, Date.now());
  const me = getMe();
  const req = cycle.exchangeRequest;
  if (!req || !req.from) throw new Error('当前没有待处理的交换请求');
  if (req.from === me) throw new Error('已发起请求，等待对方同意');
  if (!(cycle.scores.userA && cycle.scores.userB)) throw new Error('双方都完成打分后才能同意交换');
  cycle.status = 'exchanged';
  cycle.exchangedAt = Date.now();
  cycle.exchangeRequest = null;
  db.cycles.push(makeCycle(getPair(db), cycle.index + 1, cycle.exchangedAt));
  saveDB(db);
  return { ok: true, exchangedCycleId: cycle.id };
}

async function setExchangePlan(payload) {
  const db = loadDB();
  const cycle = ensureCurrent(db, Date.now());
  const pair = getPair(db);
  const day = Math.round(Number(payload.day));
  const hour = Math.round(Number(payload.hour));
  if (!(day >= 1 && day <= (pair.cycleDays || 7))) throw new Error('天数超出本期范围');
  if (!(hour >= 0 && hour <= 23)) throw new Error('小时超出范围');
  // 与云端一致：「第 N 天 H 点」按周期开始当天的本地日历日推算
  const start = new Date(cycle.startDate);
  const target = new Date(start.getFullYear(), start.getMonth(), start.getDate() + (day - 1), hour, 0, 0, 0);
  const time = target.getTime();
  if (time <= Date.now()) throw new Error('请选择一个未来的时间');
  cycle.exchangePlan = { day: day, hour: hour, time: time, notified: false };
  saveDB(db);
  return { exchangePlan: cycle.exchangePlan };
}

async function clearExchangePlan() {
  const db = loadDB();
  const cycle = ensureCurrent(db, Date.now());
  cycle.exchangePlan = null;
  saveDB(db);
  return { ok: true };
}

async function getCycleDetail(cycleId) {
  const db = loadDB();
  const me = getMe();
  const partner = partnerOf(me);
  let c = null;
  db.cycles.forEach((x) => {
    if (x.id === cycleId) c = x;
  });
  if (!c) throw new Error('周期不存在');

  if (c.status !== 'exchanged') {
    const mine = db.notes
      .filter((n) => n.cycleId === c.id && n.author === me)
      .sort((a, b) => b.createdAt - a.createdAt);
    return {
      id: c.id,
      index: c.index,
      startDate: c.startDate,
      endDate: c.endDate,
      exchangedAt: c.exchangedAt,
      status: c.status,
      my: pubScore(c.scores[me]),
      partnerDone: !!c.scores[partner],
      partner: {
        name: db.users[partner].name,
        score: null,
        comment: '',
        locked: true,
      },
      notes: mine.map((n) => publishNote(db, n, me)),
    };
  }

  const notes = db.notes
    .filter((n) => n.cycleId === c.id)
    .sort((a, b) => a.createdAt - b.createdAt);
  return {
    id: c.id,
    index: c.index,
    startDate: c.startDate,
    endDate: c.endDate,
    exchangedAt: c.exchangedAt,
    status: c.status,
    my: pubScore(c.scores[me]),
    partner: {
      name: db.users[partner].name,
      score: c.scores[partner] ? c.scores[partner].score : null,
      comment: c.scores[partner] ? c.scores[partner].comment : '',
      locked: false,
    },
    notes: notes.map((n) => publishNote(db, n, me)),
  };
}

async function addNote(payload) {
  if (payload.type !== 'happy' && payload.type !== 'unhappy') throw new Error('请选择记录类型');
  const content = (payload.content || '').trim();
  if (!content) throw new Error('写点什么再保存吧');
  if (content.length > 500) throw new Error('笔记不能超过 500 字');
  const db = loadDB();
  const cycle = ensureCurrent(db, Date.now());
  const me = getMe();
  if (cycle.status !== 'active') throw new Error('本期已交换，下期再记录吧');
  const note = {
    id: nextId(db, 'n'),
    pairId: cycle.pairId,
    cycleId: cycle.id,
    author: me,
    type: payload.type,
    content: content,
    createdAt: Date.now(),
    annotations: [],
  };
  db.notes.push(note);
  saveDB(db);
  return publishNote(db, note, me);
}

async function deleteNote(id) {
  const db = loadDB();
  const me = getMe();
  const idx = db.notes.findIndex((n) => n.id === id);
  if (idx < 0) throw new Error('记录不存在');
  if (db.notes[idx].author !== me) throw new Error('只能删除自己的记录');
  let cycle = null;
  db.cycles.forEach((c) => {
    if (c.id === db.notes[idx].cycleId) cycle = c;
  });
  if (!cycle || cycle.status !== 'active') throw new Error('已交换的记录不能再删除');
  db.notes.splice(idx, 1);
  saveDB(db);
  return true;
}

async function getMyNotes() {
  const db = loadDB();
  const cycle = ensureCurrent(db, Date.now());
  const me = getMe();
  const list = db.notes
    .filter((n) => n.cycleId === cycle.id && n.author === me)
    .sort((a, b) => b.createdAt - a.createdAt);
  return {
    cycle: { id: cycle.id, index: cycle.index },
    notes: list.map((n) => publishNote(db, n, me)),
  };
}

async function annotate(payload) {
  const content = (payload.content || '').trim();
  if (!content) throw new Error('批注内容不能为空');
  if (content.length > 200) throw new Error('批注不能超过 200 字');
  const db = loadDB();
  const me = getMe();
  let note = null;
  db.notes.forEach((n) => {
    if (n.id === payload.noteId) note = n;
  });
  if (!note) throw new Error('记录不存在');
  let cycle = null;
  db.cycles.forEach((c) => {
    if (c.id === note.cycleId) cycle = c;
  });
  if (!cycle || cycle.status !== 'exchanged') throw new Error('交换后才能批注');
  note.annotations = note.annotations || [];
  note.annotations.push({
    id: nextId(db, 'a'),
    author: me,
    content: content,
    createdAt: Date.now(),
  });
  saveDB(db);
  return publishNote(db, note, me);
}

async function addEvent(payload) {
  const reason = (payload.reason || '').trim();
  if (!reason) throw new Error('写一下发生了什么吧');
  if (reason.length > 200) throw new Error('事件描述不能超过 200 字');
  const checkScore = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 10) throw new Error('分数需要在 0-10 之间');
    return n;
  };
  const prevScore = checkScore(payload.prevScore);
  const newScore = checkScore(payload.newScore);
  const date = payload.date == null ? Date.now() : Number(payload.date);
  if (!isFinite(date) || date < 946684800000 || date > Date.now() + 86400000) {
    throw new Error('事件时间不合法');
  }
  const db = loadDB();
  let cycle = null;
  if (payload.cycleId) {
    db.cycles.forEach((c) => {
      if (c.id === payload.cycleId) cycle = c;
    });
    if (!cycle) throw new Error('周期不存在');
  } else {
    cycle = ensureCurrent(db, Date.now());
  }
  const ev = {
    id: nextId(db, 'e'),
    pairId: cycle.pairId,
    cycleId: cycle.id,
    cycleIndex: cycle.index,
    author: getMe(),
    prevScore: prevScore,
    newScore: newScore,
    reason: reason,
    date: date,
    createdAt: Date.now(),
  };
  db.events.push(ev);
  saveDB(db);
  return ev;
}

async function deleteEvent(id) {
  const db = loadDB();
  const me = getMe();
  const idx = db.events.findIndex((e) => e.id === id);
  if (idx < 0) throw new Error('事件不存在');
  if (db.events[idx].author !== me) throw new Error('只能删除自己的事件');
  db.events.splice(idx, 1);
  saveDB(db);
  return true;
}

async function getHistory() {
  const db = loadDB();
  const me = getMe();
  const partner = partnerOf(me);
  const rows = db.cycles
    .filter((c) => c.status === 'exchanged')
    .sort((a, b) => a.index - b.index)
    .map((c) => ({
      cycleId: c.id,
      index: c.index,
      startDate: c.startDate,
      endDate: c.endDate,
      exchangedAt: c.exchangedAt,
      myScore: c.scores[me] ? c.scores[me].score : null,
      partnerScore: c.scores[partner] ? c.scores[partner].score : null,
    }));
  const active = ensureCurrent(db, Date.now());
  // 可见性规则与分数一致：进行中周期的事件仅本人可见，交换后双方可见
  const events = db.events
    .filter((e) => {
      if (e.author === me) return true;
      let c = null;
      db.cycles.forEach((x) => {
        if (x.id === e.cycleId) c = x;
      });
      return !!(c && c.status === 'exchanged');
    })
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((e) => Object.assign({}, e, { authorName: db.users[e.author] ? db.users[e.author].name : '匿名' }));
  return {
    rows: rows,
    events: events,
    activeCycle: { id: active.id, index: active.index },
    cyclesTruncated: false,
    eventsTruncated: false,
  };
}

async function updateCycleDays(days) {
  days = Math.round(Number(days));
  if (!(days >= 1 && days <= 90)) throw new Error('周期天数需要在 1-90 之间');
  const db = loadDB();
  getPair(db).cycleDays = days;
  saveDB(db);
  return { cycleDays: days };
}

async function resetMock() {
  wx.removeStorageSync(DB_KEY);
  const db = loadDB();
  ensureCurrent(db, Date.now());
  return true;
}

/* mock 模式下用不到的接口，保持接口面一致并给出提示 */
function notSupported(name) {
  return function () {
    throw new Error('演示模式无需' + name);
  };
}

module.exports = {
  isMock: true,
  init: init,
  getAppStatus: getAppStatus,
  submitScore: submitScore,
  requestExchange: requestExchange,
  cancelExchangeRequest: cancelExchangeRequest,
  agreeExchange: agreeExchange,
  setExchangePlan: setExchangePlan,
  clearExchangePlan: clearExchangePlan,
  getCycleDetail: getCycleDetail,
  addNote: addNote,
  deleteNote: deleteNote,
  getMyNotes: getMyNotes,
  annotate: annotate,
  addEvent: addEvent,
  deleteEvent: deleteEvent,
  getHistory: getHistory,
  updateCycleDays: updateCycleDays,
  resetMock: resetMock,
  setMe: setMe,
  isEnvConfigured: function () {
    return true;
  },
  pairCreate: notSupported('配对'),
  pairJoin: notSupported('配对'),
  pairPreview: notSupported('配对'),
  pairGet: notSupported('配对'),
  unbind: notSupported('解绑'),
  setNickname: notSupported('设置昵称'),
};
