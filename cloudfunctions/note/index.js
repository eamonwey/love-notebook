/**
 * note 云函数：感受记录（开心/不满）与批注
 * 集合：users / pairs / cycles / notes
 * 规则：只能删除自己的记录/批注（交换后也可删除）；批注仅限已交换的周期。
 */
const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const MAX_NOTES_PER_CYCLE = 100;
const { cycleEnd, normalizeActive } = require('./cycle-calendar');

// ===== 内容安全 =====
// 用户输入文本统一过微信 msgSecCheck 2.0（场景：4 社交日志）。
// 判定违规或安全接口故障时均拒绝本次保存，避免审核不可用时违规内容落库。
async function msgSecCheck(openid, content) {
  let res = null;
  try {
    res = await cloud.openapi.security.msgSecCheck({
      openid: openid,
      scene: 4,
      version: 2,
      content: String(content || ''),
    });
  } catch (e) {
    const errCode = e && (e.errCode !== undefined ? e.errCode : e.errcode);
    if (errCode === 87014 || String((e && (e.errMsg || e.message)) || '').indexOf('87014') >= 0) {
      throw new Error('内容可能包含平台不允许的文字（微信安全检测），请调整后重试');
    }
    console.error('msgSecCheck unavailable:', e && (e.errCode || e.errMsg || e.message));
    throw new Error('内容安全检测暂时不可用，请稍后重试');
  }
  if (res && res.result && res.result.suggest && res.result.suggest !== 'pass') {
    throw new Error('内容可能包含平台不允许的文字（微信安全检测），请调整后重试');
  }
}

async function getUser(openid) {
  const res = await db.collection('users').where({ openid: openid }).limit(1).get();
  const u = res.data[0];
  if (!u || !u.pairId) throw new Error('还没有和TA配对，请先在「设置」完成配对');
  return u;
}

async function getPair(pairId) {
  const res = await db.collection('pairs').doc(pairId).get();
  return res.data;
}

async function ensureCurrentCycle(pair) {
  // 与 cycle 云函数一致：双方都绑定后才开始第一期计时
  if (pair.users.length !== 2) throw new Error('等双方完成绑定后，第一期才开始计时');
  const res = await db.collection('cycles').where({ pairId: pair._id, status: 'active' }).get();
  if (res.data.length > 0) {
    // 多条时取打分最多的那条（历史并发遗留；cycle 云函数加载时会自动合并清理）
    let best = res.data[0];
    for (let i = 1; i < res.data.length; i++) {
      if (Object.keys(res.data[i].scores || {}).length > Object.keys(best.scores || {}).length) best = res.data[i];
    }
    return normalizeActive(db, best);
  }
  const lastRes = await db.collection('cycles').where({ pairId: pair._id }).orderBy('index', 'desc').limit(1).get();
  const last = lastRes.data[0];
  if (last && last.status === 'exchanged' && last.nextOpenAt > Date.now()) return last;
  const days = pair.cycleDays || 7;
  const now = last && last.nextOpenAt ? last.nextOpenAt : Date.now();
  const index = last ? last.index + 1 : 1;
  const data = {
    pairId: pair._id,
    index: index,
    startDate: now,
    endDate: cycleEnd(now, days),
    diamondAllowance: Number.isInteger(pair.diamondAllowance) ? pair.diamondAllowance : 10,
    status: 'active',
    scores: {},
    exchangedAt: null,
    createdAt: now,
  };
  // 确定性 ID：与 cycle 云函数一致，并发创建只会成功一次
  await require('./cycle-store')(db, pair, data);
  const again = await db.collection('cycles').where({ pairId: pair._id, status: 'active' }).get();
  if (!again.data.length) throw new Error('创建周期失败，请稍后重试');
  let best = again.data[0];
  for (let i = 1; i < again.data.length; i++) {
    if (Object.keys(again.data[i].scores || {}).length > Object.keys(best.scores || {}).length) best = again.data[i];
  }
  return best;
}

async function getDoc(col, id) {
  try {
    const res = await db.collection(col).doc(id).get();
    return res.data;
  } catch (e) {
    return null;
  }
}

async function getDeletableNote(id, openid) {
  if (typeof id !== 'string' || !id) throw new Error('请选择要删除的记录');
  const u = await getUser(openid);
  const pair = await getPair(u.pairId);
  if (!pair || pair.status === 'archived' || !(pair.users || []).includes(openid)) {
    throw new Error('配对已失效');
  }
  const note = await getDoc('notes', id);
  if (!note) throw new Error('记录不存在');
  if (note.pairId !== pair._id) throw new Error('只能删除自己笔记本里的内容');
  return note;
}

function partnerOf(pair, openid) {
  const list = (pair.users || []).filter((x) => x !== openid);
  return list[0] || null;
}

async function usersMap(pair) {
  const map = {};
  for (let i = 0; i < pair.users.length; i++) {
    const oid = pair.users[i];
    const res = await db.collection('users').where({ openid: oid }).limit(1).get();
    map[oid] = { name: res.data[0] ? res.data[0].nickname : '微信用户' };
  }
  return map;
}

function cut(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// 作者身份只以「昵称」对外，openid 一律不下发到前端；
// 昵称缺失时退化为「我 / TA」，界面上不可能出现作者的 id。
function nameOf(map, oid, openid) {
  const name = map && map[oid] && map[oid].name ? map[oid].name : '';
  return name || (oid === openid ? '我' : 'TA');
}

function publicNote(n, map, openid) {
  return {
    id: n._id,
    cycleId: n.cycleId,
    type: n.type,
    content: n.content,
    createdAt: n.createdAt,
    mine: n.author === openid,
    authorName: nameOf(map, n.author, openid),
    annotations: (n.annotations || []).map((a) => ({
      id: a.id,
      content: a.content,
      createdAt: a.createdAt,
      mine: a.author === openid,
      authorName: nameOf(map, a.author, openid),
    })),
  };
}

// 小铃铛的数据源：伴侣对我的记录写的批注。
// 返回最近 REPLY_LIST_MAX 条（含已读，便于回看），unreadCount 是未读总数。
// 已读位置记在 users.replyReadAt（时间戳），打开铃铛后由 markRepliesRead 推进。
const REPLY_LIST_MAX = 20;
async function collectReplies(u, openid) {
  const pair = await getPair(u.pairId);
  const since = Number(u.replyReadAt || 0);
  // 旧记录也可能收到新批注：分页扫描我的全部记录，不按创建时间截断。
  const res = { data: [] };
  let cursor;
  for (;;) {
    const condition = { pairId: pair._id, author: openid };
    if (cursor) condition._id = _.gt(cursor);
    const page = await db.collection('notes').where(condition).orderBy('_id', 'asc').limit(100).get();
    res.data.push(...page.data);
    if (page.data.length < 100) break;
    cursor = page.data[page.data.length - 1]._id;
  }
  const map = await usersMap(pair);
  const all = [];
  res.data.forEach((n) => {
    (n.annotations || []).forEach((a) => {
      if (!a || !a.author || a.author === openid) return;
      const at = Number(a.createdAt || 0);
      all.push({
        key: String(a.id || at),
        noteId: n._id,
        cycleId: n.cycleId,
        type: n.type,
        noteExcerpt: cut(n.content, 40),
        createdAt: at,
        content: String(a.content || ''),
        authorName: nameOf(map, a.author, openid),
        unread: at > since,
      });
    });
  });
  all.sort((a, b) => b.createdAt - a.createdAt);
  let unreadCount = 0;
  all.forEach((it) => {
    if (it.unread) unreadCount++;
  });
  const items = all.slice(0, REPLY_LIST_MAX);
  // 补上期数，方便列表上显示「第 N 期」
  const indexMap = {};
  const cycleIds = [];
  items.forEach((it) => {
    if (it.cycleId && !indexMap[it.cycleId]) {
      indexMap[it.cycleId] = true;
      cycleIds.push(it.cycleId);
    }
  });
  if (cycleIds.length) {
    const cres = await db.collection('cycles').where({ _id: _.in(cycleIds) }).limit(100).get();
    const idx = {};
    cres.data.forEach((c) => {
      idx[c._id] = c.index;
    });
    items.forEach((it) => {
      it.cycleIndex = idx[it.cycleId] || null;
    });
  }
  return { items: items, unreadCount: unreadCount, replyReadAt: since };
}

const handlers = {
  async add(payload, openid) {
    if (payload.type !== 'happy' && payload.type !== 'unhappy') throw new Error('请选择记录类型');
    const content = String(payload.content || '').trim();
    if (!content) throw new Error('写点什么再保存吧');
    if (content.length > 500) throw new Error('笔记不能超过 500 字');
    await msgSecCheck(openid, content);
    const u = await getUser(openid);
    const pair = await getPair(u.pairId);
    const cycle = await ensureCurrentCycle(pair);
    if (cycle.status !== 'active' && !(cycle.status === 'exchanged' && cycle.nextOpenAt > Date.now())) throw new Error('周期已结束，请刷新后记录');
    const noteCount = await db.collection('notes').where({ cycleId: cycle._id }).count();
    if (noteCount.total >= MAX_NOTES_PER_CYCLE) throw new Error('本期最多记录 100 条，请在下一期继续记录');
    const data = {
      pairId: pair._id,
      cycleId: cycle._id,
      author: openid,
      type: payload.type,
      content: content,
      annotations: [],
      createdAt: Date.now(),
    };
    const noteId = 'note_' + crypto.randomBytes(16).toString('hex');
    // 周期状态确认与写入笔记放在同一事务里，杜绝“刚交换完又写入旧周期”的竞态。
    await db.runTransaction(async (transaction) => {
      const fresh = (await transaction.collection('cycles').doc(cycle._id).get()).data;
      if (!fresh || (fresh.status !== 'active' && !(fresh.status === 'exchanged' && fresh.nextOpenAt > Date.now()))) throw new Error('周期已结束，请刷新后记录');
      if (!Number.isInteger(fresh.noteCount) && (fresh.noteRevision || 0) !== (cycle.noteRevision || 0)) throw new Error('记录状态已变化，请重试');
      const count = Number.isInteger(fresh.noteCount) ? fresh.noteCount : noteCount.total;
      if (count >= MAX_NOTES_PER_CYCLE) throw new Error('本期最多记录 100 条，请在下一期继续记录');
      await transaction.collection('cycles').doc(cycle._id).update({ data: { noteCount: count + 1, noteRevision: (fresh.noteRevision || 0) + 1 } });
      await transaction.collection('notes').doc(noteId).set({ data: data });
    });
    return publicNote(Object.assign({ _id: noteId }, data), {}, openid);
  },

  async remove(payload, openid) {
    const note = await getDeletableNote(payload.id, openid);
    if (note.author !== openid) throw new Error('只能删除自己的记录');
    await db.runTransaction(async (tx) => {
      const current = (await tx.collection('notes').doc(payload.id).get()).data;
      if (!current || current.author !== openid) throw new Error('记录状态已变化，请刷新');
      const cycle = (await tx.collection('cycles').doc(note.cycleId).get()).data;
      const update = { noteRevision: (cycle.noteRevision || 0) + 1 };
      if (Number.isInteger(cycle.noteCount)) update.noteCount = Math.max(0, cycle.noteCount - 1);
      await tx.collection('cycles').doc(note.cycleId).update({ data: update });
      await tx.collection('notes').doc(payload.id).remove();
    });
    return { ok: true };
  },

  async removeAnnotation(payload, openid) {
    if (typeof payload.annotationId !== 'string' || !payload.annotationId) throw new Error('请选择要删除的批注');
    const note = await getDeletableNote(payload.noteId, openid);
    const ann = (note.annotations || []).find((a) => a.id === payload.annotationId);
    if (!ann) throw new Error('批注不存在');
    if (ann.author !== openid) throw new Error('只能删除自己的批注');
    // 原子移除目标，不覆盖并发新增的其他批注。
    await db.collection('notes').doc(payload.noteId).update({
      data: { annotations: _.pull({ id: payload.annotationId, author: openid }) },
    });
    return { ok: true };
  },

  async listMine(payload, openid) {
    const u = await getUser(openid);
    const pair = await getPair(u.pairId);
    const cycle = await ensureCurrentCycle(pair);
    const res = await db
      .collection('notes')
      .where({ cycleId: cycle._id, author: openid })
      .orderBy('createdAt', 'desc')
      .limit(101)
      .get();
    // 只有存在批注时才需要昵称映射，省掉无谓的查询
    let map = {};
    if (res.data.some((n) => (n.annotations || []).length)) map = await usersMap(pair);
    return {
      cycle: { id: cycle._id, index: cycle.index, status: cycle.status, nextOpenAt: cycle.nextOpenAt || null },
      notes: res.data.slice(0, 100).map((n) => publicNote(n, map, openid)),
      notesTruncated: res.data.length > 100,
    };
  },

  async annotate(payload, openid) {
    const content = String(payload.content || '').trim();
    if (!content) throw new Error('批注内容不能为空');
    if (content.length > 200) throw new Error('批注不能超过 200 字');
    await msgSecCheck(openid, content);
    // 归属校验：调用者必须处于有效配对，且笔记属于自己这本笔记本
    const u = await getUser(openid);
    const pair = await getPair(u.pairId);
    const note = await getDoc('notes', payload.noteId);
    if (!note) throw new Error('记录不存在');
    if (note.pairId !== pair._id) throw new Error('只能批注自己笔记本里的记录');
    const cycle = await getDoc('cycles', note.cycleId);
    if (!cycle || cycle.status !== 'exchanged') throw new Error('交换后才能批注');
    const ann = { id: 'a_' + crypto.randomBytes(12).toString('hex'), author: openid, content: content, createdAt: Date.now() };
    const updated = await db.collection('notes').doc(payload.noteId).update({ data: { annotations: _.push(ann) } });
    if (!updated.stats || updated.stats.updated === 0) throw new Error('记录已被删除，请刷新后重试');
    return { ok: true };
  },

  // 首页小铃铛：伴侣对我记录写的批注（含最近已读，便于回看）+ 未读总数
  async unreadReplies(payload, openid) {
    const u = await getUser(openid);
    return await collectReplies(u, openid);
  },

  // 打开铃铛后把已展示的批注标为已读。
  // 只允许时间戳向前推进，并且不采信未来的时间（两台手机时钟可能不一致）
  async markRepliesRead(payload, openid) {
    const u = await getUser(openid);
    const cur = Number(u.replyReadAt || 0);
    const raw = payload && payload.upTo != null ? Number(payload.upTo) : Date.now();
    if (!isFinite(raw) || raw <= 0) return { readAt: cur };
    const upTo = Math.min(Math.floor(raw), Date.now());
    if (upTo <= cur) return { readAt: cur };
    const result = await db.runTransaction(async (tx) => {
      const fresh = (await tx.collection('users').doc(u._id).get()).data;
      const readAt = Math.max(Number(fresh.replyReadAt || 0), upTo);
      await tx.collection('users').doc(u._id).update({ data: { replyReadAt: readAt } });
      return { readAt };
    });
    return result && result.result ? result.result : result;
  },
};

exports.main = async (event) => {
  try {
    const { OPENID } = cloud.getWXContext();
    const handler = handlers[event.action];
    if (!handler) throw new Error('未知操作: ' + event.action);
    const data = await handler(event.payload || {}, OPENID);
    return { ok: true, data: data };
  } catch (e) {
    const internal = e && (e.errCode !== undefined || e.errcode !== undefined || e.name === 'TypeError');
    if (internal) console.error('[note] internal request failure:', e);
    return { ok: false, error: internal ? '服务暂时不可用，请稍后重试' : e.message };
  }
};
