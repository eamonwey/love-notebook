/**
 * track 云函数：分数变化事件与历史追踪
 * 集合：users / pairs / cycles / events
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// ===== 内容安全 =====
// 用户输入文本统一过微信 msgSecCheck 2.0（场景：4 社交日志）。
// 判定违规：拒绝保存；接口自身故障（权限/频率/网络）：放行并记日志，不阻断主流程。
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
    console.error('msgSecCheck error, allow content:', e && (e.errCode || e.errMsg || e.message));
    return;
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
    return Object.assign({ _id: add._id, id: add._id }, data);
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
    const partner = partnerOf(pair, openid);
    const cyc = await db
      .collection('cycles')
      .where({ pairId: pair._id, status: 'exchanged' })
      .orderBy('index', 'asc')
      .limit(100)
      .get();
    const cycTotal = (await db.collection('cycles').where({ pairId: pair._id, status: 'exchanged' }).count()).total;
    const rows = cyc.data.map((c) => ({
      cycleId: c._id,
      index: c.index,
      startDate: c.startDate,
      endDate: c.endDate,
      exchangedAt: c.exchangedAt,
      myScore: c.scores && c.scores[openid] ? c.scores[openid].score : null,
      partnerScore: partner && c.scores && c.scores[partner] ? c.scores[partner].score : null,
    }));
    const ev = await db.collection('events').where({ pairId: pair._id }).orderBy('createdAt', 'desc').limit(200).get();
    const evTotal = (await db.collection('events').where({ pairId: pair._id }).count()).total;
    const map = await usersMap(pair);
    // 可见性规则与分数一致：进行中周期的事件仅本人可见，交换后双方可见
    const exchangedIds = {};
    cyc.data.forEach((c) => {
      exchangedIds[c._id] = true;
    });
    const events = ev.data
      .filter((e) => e.author === openid || exchangedIds[e.cycleId])
      .map((e) => Object.assign({}, e, { id: e._id, authorName: map[e.author] ? map[e.author].name : '微信用户' }));
    const act = await db.collection('cycles').where({ pairId: pair._id, status: 'active' }).limit(1).get();
    const active = act.data[0];
    return {
      rows: rows,
      events: events,
      activeCycle: active ? { id: active._id, index: active.index } : null,
      // 截断标记：超限时前端会提示（避免旧数据看起来像丢了）
      cyclesTruncated: cycTotal > rows.length,
      eventsTruncated: evTotal > events.length,
    };
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
    return { ok: false, error: e.message };
  }
};
