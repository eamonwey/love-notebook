/**
 * 本地模拟后端：无需开通云开发，即可在开发者工具里完整体验双人流程。
 * 数据存在本地缓存，通过「设置 - 演示身份」在 小A / 小B 之间切换，
 * 分别打分、记录、交换，即可模拟两个人。
 */
const { DAY } = require('../utils/date.js');
const { cycleEnd, legacyEnd } = require('../utils/cycle-calendar');

const DB_KEY = 'LOVE_MOCK_DB_V1';
const ME_KEY = 'LOVE_MOCK_ME';

/* ---------- 存储基础 ---------- */

function loadDB() {
  let db = wx.getStorageSync(DB_KEY);
  if (!db || !db.cycles || !db.cycles.length) {
    db = seed();
    saveDB(db);
  }
  // 兼容旧版本地数据：补上小铃铛的已读位置
  if (!db.replyRead) {
    db.replyRead = { userA: 0, userB: 0 };
    saveDB(db);
  }
  let normalized = false;
  db.cycles.forEach(c => {
    const endDate = legacyEnd(c);
    if (endDate !== c.endDate) { c.endDate = endDate; normalized = true; }
  });
  if (normalized) saveDB(db);
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
    // 小铃铛的已读位置：{ userA: 时间戳, userB: 时间戳 }
    replyRead: { userA: 0, userB: 0 },
  };
}

function makeCycle(pair, index, startMs) {
  const days = pair.cycleDays || 7;
  return {
    id: 'c' + index + '_' + startMs,
    pairId: pair.id,
    index: index,
    startDate: startMs,
    endDate: cycleEnd(startMs, days),
    diamondAllowance: Number.isInteger(pair.diamondAllowance) ? pair.diamondAllowance : 10,
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

// 对外统一为 Promise（与 cloud 侧接口约定一致），调用方无论 await 还是 .then 都不会踩坑
async function setMe(id) {
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
  const last = db.cycles.slice().sort((a, b) => b.index - a.index)[0];
  if (last && last.status === 'exchanged' && last.nextOpenAt > now) return last;
  let maxIndex = 0;
  db.cycles.forEach((c) => {
    if (c.index > maxIndex) maxIndex = c.index;
  });
  const next = makeCycle(getPair(db), maxIndex + 1, last && last.nextOpenAt ? last.nextOpenAt : now);
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
  const latestScoredAt = Math.max(Number(cycle.scores.userA.scoredAt || 0), Number(cycle.scores.userB.scoredAt || 0));
  const nextStart = cycle.endDate && latestScoredAt > cycle.endDate ? latestScoredAt : (cycle.endDate || now);
  db.cycles.push(makeCycle(pair, cycle.index + 1, nextStart));
  return true;
}

const MAX_NOTES_PER_CYCLE = 100;

/* ---------- 输出整形 ---------- */

function pubScore(s) {
  return s ? { score: s.score, comment: s.comment, scoredAt: s.scoredAt } : null;
}

// 与云函数 publicNote 同构：作者只以昵称对外，userA/userB 这类内部标识不下发到页面数据
function nameOf(db, oid, me) {
  const u = db.users[oid];
  return (u && u.name) || (oid === me ? '我' : 'TA');
}

function publishNote(db, n, me) {
  return {
    id: n.id,
    cycleId: n.cycleId,
    type: n.type,
    content: n.content,
    createdAt: n.createdAt,
    mine: n.author === me,
    authorName: nameOf(db, n.author, me),
    annotations: (n.annotations || []).map((a) => ({
      id: a.id,
      content: a.content,
      createdAt: a.createdAt,
      mine: a.author === me,
      authorName: nameOf(db, a.author, me),
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
    pair: { id: pair.id, cycleDays: pair.cycleDays, diamondAllowance: Number.isInteger(pair.diamondAllowance) ? pair.diamondAllowance : 10 },
    cycle: {
      id: cycle.id,
      index: cycle.index,
      startDate: cycle.startDate,
      endDate: cycle.endDate,
      status: cycle.status,
      nextOpenAt: cycle.nextOpenAt || null,
    },
    myScore: pubScore(cycle.scores[me]),
    partnerDone: !!cycle.scores[partner],
    bothScored: !!(cycle.scores.userA && cycle.scores.userB),
    exchangeRequest: cycle.exchangeRequest || null,
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
  if (payload.cycleId !== undefined && payload.cycleId !== cycle.id) throw new Error('周期已变化，请重新打开打分页');
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
  if (cycle.status !== 'active') throw new Error('本期已交换，请等待次日0点');
  const me = getMe();
  const existing = cycle.exchangeRequest;
  if (existing && existing.from && existing.from !== me) {
    throw new Error('对方已向你发起交换请求，请先在下方同意或暂不');
  }
  // 与云函数一致：自己已完成本期打分才能发起
  if (!(cycle.scores && cycle.scores[me])) throw new Error('先完成本期打分，再发起交换请求');
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
  if (cycle.status !== 'active') throw new Error('本期已交换，请等待次日0点');
  const me = getMe();
  const req = cycle.exchangeRequest;
  if (!req || !req.from) throw new Error('当前没有待处理的交换请求');
  if (req.from === me) throw new Error('已发起请求，等待对方同意');
  if (!(cycle.scores.userA && cycle.scores.userB)) throw new Error('双方都完成打分后才能同意交换');
  cycle.status = 'exchanged';
  cycle.exchangedAt = Date.now();
  cycle.exchangeRequest = null;
  cycle.nextOpenAt = (Math.floor((cycle.exchangedAt + 8 * 3600000) / DAY) + 1) * DAY - 8 * 3600000;
  saveDB(db);
  return { ok: true, exchangedCycleId: cycle.id, nextOpenAt: cycle.nextOpenAt };
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
      notes: mine.slice(0, 100).map((n) => publishNote(db, n, me)),
      notesTruncated: mine.length > 100,
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
    notes: notes.slice(-100).map((n) => publishNote(db, n, me)),
    notesTruncated: notes.length > 100,
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
  if (cycle.status !== 'active' && !(cycle.status === 'exchanged' && cycle.nextOpenAt > Date.now())) throw new Error('周期已结束，请刷新后记录');
  if (db.notes.filter((n) => n.cycleId === cycle.id).length >= MAX_NOTES_PER_CYCLE) {
    throw new Error('本期最多记录 100 条，请在下一期继续记录');
  }
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
  if (!cycle) throw new Error('周期不存在');
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
    cycle: { id: cycle.id, index: cycle.index, status: cycle.status, nextOpenAt: cycle.nextOpenAt || null },
    notes: list.slice(0, 100).map((n) => publishNote(db, n, me)),
    notesTruncated: list.length > 100,
  };
}

async function deleteAnnotation(payload) {
  const db = loadDB();
  const me = getMe();
  const note = db.notes.find((n) => n.id === payload.noteId);
  if (!note) throw new Error('记录不存在');
  const ann = (note.annotations || []).find((a) => a.id === payload.annotationId);
  if (!ann) throw new Error('批注不存在');
  if (ann.author !== me) throw new Error('只能删除自己的批注');
  note.annotations = note.annotations.filter((a) => a.id !== payload.annotationId || a.author !== me);
  saveDB(db);
  return true;
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

/* ---------- 小铃铛：伴侣对我记录的批注（与云函数 note.unreadReplies 同构） ---------- */

const REPLY_LIST_MAX = 20;

function cut(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function cycleIndexById(db, id) {
  let idx = null;
  db.cycles.forEach((c) => {
    if (c.id === id) idx = c.index;
  });
  return idx;
}

async function getUnreadReplies() {
  const db = loadDB();
  const me = getMe();
  const since = Number((db.replyRead || {})[me] || 0);
  const all = [];
  db.notes.forEach((n) => {
    if (n.author !== me) return;
    (n.annotations || []).forEach((a) => {
      if (!a || !a.author || a.author === me) return;
      const at = Number(a.createdAt || 0);
      all.push({
        key: String(a.id || at),
        noteId: n.id,
        cycleId: n.cycleId,
        type: n.type,
        noteExcerpt: cut(n.content, 40),
        createdAt: at,
        content: String(a.content || ''),
        authorName: nameOf(db, a.author, me),
        unread: at > since,
        cycleIndex: cycleIndexById(db, n.cycleId),
      });
    });
  });
  all.sort((a, b) => b.createdAt - a.createdAt);
  let unreadCount = 0;
  all.forEach((it) => {
    if (it.unread) unreadCount++;
  });
  return { items: all.slice(0, REPLY_LIST_MAX), unreadCount: unreadCount, replyReadAt: since };
}

async function markRepliesRead(upTo) {
  const db = loadDB();
  const me = getMe();
  db.replyRead = db.replyRead || { userA: 0, userB: 0 };
  const cur = Number(db.replyRead[me] || 0);
  const raw = upTo == null ? Date.now() : Number(upTo);
  if (!isFinite(raw) || raw <= 0) return { readAt: cur };
  const next = Math.min(Math.floor(raw), Date.now());
  if (next <= cur) return { readAt: cur };
  db.replyRead[me] = next;
  saveDB(db);
  return { readAt: next };
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

async function getHistory(payload = {}) {
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
    .map((e) => ({
      id: e.id,
      cycleId: e.cycleId,
      cycleIndex: e.cycleIndex,
      prevScore: e.prevScore,
      newScore: e.newScore,
      reason: e.reason,
      date: e.date,
      createdAt: e.createdAt,
      mine: e.author === me,
      authorName: nameOf(db, e.author, me),
    }));
  const eligible = rows.filter((r) => !payload.beforeIndex || r.index < payload.beforeIndex);
  const limit = payload.pageSize || 100;
  const page = eligible.slice(-limit).map((r) => Object.assign({}, r, { eventCount: events.filter((e) => e.cycleId === r.cycleId).length }));
  return {
    rows: page,
    events: payload.pageSize ? [] : events,
    activeCycle: active.status === 'active' ? { id: active.id, index: active.index } : null,
    hasMore: eligible.length > limit,
    nextBeforeIndex: eligible.length > limit ? page[0].index : null,
    cyclesTruncated: eligible.length > limit,
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
  getGiftState: async function () {
    const s = await getAppStatus();
    const db = loadDB();
    const cycle = db.cycles.find((c) => c.id === s.cycle.id);
    const me = getMe();
    return { available: true, walletKey: 'demo_' + me, cycleId: cycle.id, cycleIndex: cycle.index,
      allowance: Number.isInteger(cycle.diamondAllowance) ? cycle.diamondAllowance : 10,
      nextAllowance: Number.isInteger(getPair(db).diamondAllowance) ? getPair(db).diamondAllowance : 10,
      balance: (Number.isInteger(cycle.diamondAllowance) ? cycle.diamondAllowance : 10) - (db.gifts || []).filter((g) => g.cycleId === cycle.id && g.from === me).reduce((n, g) => n + g.cost, 0),
      inbox: (db.gifts || []).filter((g) => g.to === me && !g.seen).slice(0, 20)
        .map((g) => ({ id: g.id, type: g.type, quantity: g.quantity || 1, senderName: g.senderName, senderKey: 'demo_' + g.from, cycleIndex: g.cycleIndex })),
    };
  },
  sendGift: async function (p) {
    const s = await module.exports.getGiftState();
    const prices = { flower: 1, letter: 5, car: 10 };
    if (typeof p.type !== 'string' || !Object.prototype.hasOwnProperty.call(prices, p.type)) throw new Error('请选择有效的礼物');
    const quantity = p.quantity === undefined ? 1 : p.quantity;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) throw new Error('礼物数量必须为1至10的整数');
    if (typeof p.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(p.requestId)) throw new Error('送礼请求无效');
    const db = loadDB();
    const me = getMe();
    const gifts = db.gifts || [];
    const current = ensureCurrent(db, Date.now());
    const remaining = (Number.isInteger(current.diamondAllowance) ? current.diamondAllowance : 10) - gifts.filter((g) => g.cycleId === current.id && g.from === me).reduce((n, g) => n + g.cost, 0);
    const existing = gifts.find((g) => g.from === me && g.cycleId === p.cycleId && g.requestId === p.requestId);
    if (existing) {
      if (existing.type !== p.type || (existing.quantity || 1) !== quantity) throw new Error('请勿重复使用送礼请求');
      return { id: existing.id, balance: remaining };
    }
    if (p.cycleId !== current.id) throw new Error('已进入新周期，请刷新余额后再送礼');
    const cost = prices[p.type] * quantity;
    if (remaining < cost) throw new Error('本期钻石不足，请等待下一期');
    const id = nextId(db, 'gift_');
    gifts.push({ id, requestId: p.requestId, from: me, to: partnerOf(me), type: p.type, quantity, cost,
      cycleId: s.cycleId, cycleIndex: s.cycleIndex, senderName: db.users[me].name, seen: false });
    db.gifts = gifts;
    saveDB(db);
    return { id, balance: remaining - cost };
  },
  acknowledgeGift: async function (id) {
    const ids = Array.isArray(id) ? id : [id];
    if (!ids.length || ids.length > 20 || ids.some((value) => typeof value !== 'string' || !value)) throw new Error('礼物编号无效');
    const db = loadDB();
    (db.gifts || []).filter((g) => ids.includes(g.id) && g.to === getMe()).forEach((g) => { g.seen = true; });
    saveDB(db);
    return { acknowledged: true };
  },
  getExchangePage: async function (cycleId) {
    const status = await getAppStatus();
    const id = cycleId || (status.lastExchanged && status.lastExchanged.id);
    return { status, detail: id ? await getCycleDetail(id) : null };
  },
  isMock: true,
  init: init,
  getAppStatus: getAppStatus,
  submitScore: submitScore,
  requestExchange: requestExchange,
  cancelExchangeRequest: cancelExchangeRequest,
  agreeExchange: agreeExchange,
  getCycleDetail: getCycleDetail,
  addNote: addNote,
  deleteNote: deleteNote,
  getMyNotes: getMyNotes,
  annotate: annotate,
  deleteAnnotation: deleteAnnotation,
  getUnreadReplies: getUnreadReplies,
  markRepliesRead: markRepliesRead,
  addEvent: addEvent,
  deleteEvent: deleteEvent,
  getHistory: getHistory,
  getCycleEvents: async function (payload) {
    const h = await getHistory();
    const list = h.events.filter((e) => e.cycleId === payload.cycleId && (!payload.beforeId || e.id < payload.beforeId))
      .sort((a, b) => a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
    return { events: list.slice(0, 50), nextBeforeId: list.length > 50 ? list[49].id : null };
  },
  updateCycleDays: updateCycleDays,
  updateDiamondAllowance: async function (amount) {
    if (!Number.isInteger(amount) || amount < 0 || amount > 100) throw new Error('钻石额度需要是0–100的整数');
    const db = loadDB();
    getPair(db).diamondAllowance = amount;
    saveDB(db);
    return { diamondAllowance: amount };
  },
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
