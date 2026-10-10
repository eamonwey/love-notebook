/**
 * track 云函数：分数变化事件与历史追踪
 * 集合：users / pairs / cycles / events
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

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

async function getDoc(col, id) {
  try {
    const res = await db.collection(col).doc(id).get();
    return res.data;
  } catch (e) {
    return null;
  }
}

function partnerOf(pair, openid) {
  const list = (pair.users || []).filter((x) => x !== openid);
  return list[0] || null;
}

async function usersMap(pair) {
  const map = {};
  for (let i = 0; i < pair.users.length; i++) {
    const res = await db.collection('users').where({ openid: pair.users[i] }).limit(1).get();
    map[pair.users[i]] = { name: res.data[0] ? res.data[0].nickname : '微信用户' };
  }
  return map;
}

// 事件作者只以「昵称」对外，openid 一律不下发到前端
function nameOf(map, oid, openid) {
  const name = map && map[oid] && map[oid].name ? map[oid].name : '';
  return name || (oid === openid ? '我' : 'TA');
}

const handlers = {
  async addEvent(payload, openid) {
    const reason = String(payload.reason || '').trim();
    if (!reason) throw new Error('写一下发生了什么吧');
    if (reason.length > 200) throw new Error('事件描述不能超过 200 字');
    await msgSecCheck(openid, reason);
    // 服务端校验：分数必须是 0-10 的整数（可为空），时间必须是合理的时间戳
    const checkScore = (v, name) => {
      if (v == null || v === '') return null;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 10) throw new Error(name + '需要在 0-10 之间');
      return n;
    };
    const prevScore = checkScore(payload.prevScore, '变化前分数');
    const newScore = checkScore(payload.newScore, '变化后分数');
    const date = payload.date == null ? Date.now() : Number(payload.date);
    if (!isFinite(date) || date < 946684800000 || date > Date.now() + 86400000) {
      throw new Error('事件时间不合法');
    }
    const u = await getUser(openid);
    const pair = await getPair(u.pairId);
    let cycle = null;
    if (payload.cycleId) {
      cycle = await getDoc('cycles', payload.cycleId);
      if (!cycle || cycle.pairId !== pair._id) throw new Error('周期不存在');
    } else {
      const res = await db.collection('cycles').where({ pairId: pair._id, status: 'active' }).limit(1).get();
      cycle = res.data[0];
    }
    if (!cycle) throw new Error('周期不存在');
    const data = {
      pairId: pair._id,
      cycleId: cycle._id,
      cycleIndex: cycle.index,
      author: openid,
      prevScore: prevScore,
      newScore: newScore,
      reason: reason,
      date: date,
      createdAt: Date.now(),
    };
    const add = await db.collection('events').add({ data: data });
    return { id: add._id, cycleId: cycle._id, cycleIndex: cycle.index,
      prevScore, newScore, reason, date, createdAt: data.createdAt, mine: true, authorName: '我' };
  },

  // 删除事件：只能删除自己添加的
  async remove(payload, openid) {
    const ev = await getDoc('events', payload.id);
    if (!ev) throw new Error('事件不存在');
    if (ev.author !== openid) throw new Error('只能删除自己的事件');
    await db.collection('events').doc(payload.id).remove();
    return { ok: true };
  },

  async history(payload, openid) {
    const u = await getUser(openid);
    const pair = await getPair(u.pairId);
    if (!pair || pair.status === 'archived' || !pair.users.includes(openid)) throw new Error('配对已失效');
    const partner = partnerOf(pair, openid);
    const pageSize = payload.pageSize === undefined ? 100 : payload.pageSize;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('分页数量无效');
    if (payload.beforeIndex !== undefined && (!Number.isInteger(payload.beforeIndex) || payload.beforeIndex < 1)) throw new Error('分页位置无效');
    const condition = { pairId: pair._id, status: db.command.in(['exchanged', 'archived']) };
    if (payload.beforeIndex !== undefined) condition.index = db.command.lt(payload.beforeIndex);
    // 倒序取「最近 100 期」再翻正为时间正序（原实现 asc + limit 取到的是最早的 100 期，
    // 界面提示却写「仅显示最近 100 期」，期数过百时会丢掉最新数据）
    const cyc = await db
      .collection('cycles')
      .where(condition)
      .orderBy('index', 'desc')
      .limit(pageSize + 1)
      .get();
    const hasMore = cyc.data.length > pageSize;
    cyc.data = cyc.data.slice(0, pageSize);
    const cycTotal = payload.pageSize !== undefined ? 0 : (await db.collection('cycles').where({ pairId: pair._id, status: db.command.in(['exchanged', 'archived']) }).count()).total;
    const rows = cyc.data
      .slice()
      .reverse()
      .map((c) => ({
        cycleId: c._id,
        index: c.index,
        startDate: c.startDate,
        endDate: c.endDate,
        exchangedAt: c.exchangedAt,
        gap: c.status === 'archived', pausedAt: c.pausedAt || null, resumedAt: c.resumedAt || null,
        myScore: c.status === 'exchanged' && c.scores && c.scores[openid] ? c.scores[openid].score : null,
        partnerScore: c.status === 'exchanged' && partner && c.scores && c.scores[partner] ? c.scores[partner].score : null,
      }));
    if (payload.pageSize !== undefined) {
      await Promise.all(rows.map(async (r) => {
        r.eventCount = r.gap ? 0 : (await db.collection('events').where({ pairId: pair._id, cycleId: r.cycleId }).count()).total;
      }));
      const active = (await db.collection('cycles').where({ pairId: pair._id, status: 'active' }).limit(1).get()).data[0];
      return { rows, events: [], hasMore, nextBeforeIndex: hasMore && rows.length ? rows[0].index : null,
        activeCycle: active ? { id: active._id, index: active.index } : null, cyclesTruncated: hasMore, eventsTruncated: false };
    }
    const ev = await db.collection('events').where({ pairId: pair._id }).orderBy('createdAt', 'desc').limit(200).get();
    const evTotal = (await db.collection('events').where({ pairId: pair._id }).count()).total;
    const map = await usersMap(pair);
    // 只有实际交换过的事件才向对方公开；中断期不能因归档而解锁。
    // 超出图表窗口的事件按其所属周期状态核实，不从最近100期反推。
    const act = await db.collection('cycles').where({ pairId: pair._id, status: 'active' }).limit(20).get();
    const cycleStates = {};
    cyc.data.concat(act.data).forEach((c) => { cycleStates[c._id] = c.status; });
    await Promise.all([...new Set(ev.data.filter((e) => e.author !== openid).map((e) => e.cycleId))].map(async (id) => {
      if (cycleStates[id]) return;
      const c = await getDoc('cycles', id);
      cycleStates[id] = c && c.pairId === pair._id ? c.status : 'unknown';
    }));
    const events = ev.data
      .filter((e) => e.author === openid || cycleStates[e.cycleId] === 'exchanged')
      .map((e) => ({
        id: e._id,
        cycleId: e.cycleId,
        cycleIndex: e.cycleIndex,
        prevScore: e.prevScore,
        newScore: e.newScore,
        reason: e.reason,
        date: e.date,
        createdAt: e.createdAt,
        mine: e.author === openid,
        authorName: nameOf(map, e.author, openid),
      }));
    const active = act.data[0];
    return {
      rows: rows,
      events: events,
      activeCycle: active ? { id: active._id, index: active.index } : null,
      // 截断标记：按「未经过滤的原始条数」判断，否则对方进行中的事件被隐藏会被误报成截断
      cyclesTruncated: cycTotal > rows.length,
      eventsTruncated: evTotal > ev.data.length,
      hasMore, nextBeforeIndex: hasMore && rows.length ? rows[0].index : null,
    };
  },

  async cycleEvents(payload, openid) {
    const u = await getUser(openid);
    const pair = await getPair(u.pairId);
    const cycle = typeof payload.cycleId === 'string' ? await getDoc('cycles', payload.cycleId) : null;
    if (!pair || pair.status === 'archived' || !pair.users.includes(openid) || !cycle || cycle.pairId !== pair._id) throw new Error('周期不存在');
    const condition = { pairId: pair._id, cycleId: cycle._id };
    if (cycle.status !== 'exchanged') condition.author = openid;
    if (payload.beforeId !== undefined) {
      if (typeof payload.beforeId !== 'string' || !payload.beforeId || payload.beforeId.length > 128) throw new Error('分页位置无效');
      condition._id = db.command.lt(payload.beforeId);
    }
    const result = await db.collection('events').where(condition).orderBy('_id', 'desc').limit(51).get();
    const map = await usersMap(pair);
    const page = result.data.slice(0, 50);
    return { events: page.map((e) => ({ id: e._id, cycleId: e.cycleId, cycleIndex: e.cycleIndex,
      prevScore: e.prevScore, newScore: e.newScore, reason: e.reason, date: e.date, createdAt: e.createdAt,
      mine: e.author === openid, authorName: nameOf(map, e.author, openid) })),
      nextBeforeId: result.data.length > 50 ? page[page.length - 1]._id : null };
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
    if (internal) console.error('[track] internal request failure:', e);
    return { ok: false, error: internal ? '服务暂时不可用，请稍后重试' : e.message };
  }
};
