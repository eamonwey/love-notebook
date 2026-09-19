/**
 * cycle 云函数：周期管理、打分、交换、周期详情（含交换前后的可见性控制）
 * 集合：users / pairs / cycles / notes
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const DAY = 24 * 60 * 60 * 1000;

// ===== 订阅消息 =====
// 在 mp 后台「功能 → 订阅消息 → 公共模板库」选一个字段为「事项 / 时间 / 备注」的提醒类模板，
// 把模板 ID 填到 TEMPLATE_ID；体验版测试时把 NOTIFY_STATE 改为 'trial'。
// 若所选模板的字段编号不同（如 thing4/time5），同步修改 FIELDS。留空 = 不发送。
const TEMPLATE_ID = 'yR-5gQYj_SzXZv_0bLu_ohFcOOyaX3lYrz9fNrvkZuM';
const NOTIFY_STATE = 'formal';
const FIELDS = { thing: 'thing1', time: 'time2', note: 'thing3' };

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':00';
}

function cut(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

async function sendSubscribe(touser, thing, timeText, note) {
  if (!TEMPLATE_ID) return;
  try {
    await cloud.openapi.subscribeMessage.send({
      touser: touser,
      templateId: TEMPLATE_ID,
      page: 'pages/exchange/exchange',
      miniprogramState: NOTIFY_STATE,
      data: {
        [FIELDS.thing]: { value: cut(thing, 20) },
        [FIELDS.time]: { value: timeText },
        [FIELDS.note]: { value: cut(note, 20) },
      },
    });
  } catch (e) {
    // 用户未订阅等情况：静默忽略，不影响主流程
  }
}

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

async function getActiveCycle(pairId) {
  const res = await db.collection('cycles').where({ pairId: pairId, status: 'active' }).limit(20).get();
  if (res.data.length === 0) return null;
  if (res.data.length === 1) return res.data[0];
  // 历史并发可能产生多条 active 周期：合并打分、迁移笔记与事件后只保留一条（自愈）
  const sorted = res.data.slice().sort((a, b) => {
    const as = Object.keys(a.scores || {}).length;
    const bs = Object.keys(b.scores || {}).length;
    if (as !== bs) return bs - as;
    return (a.startDate || 0) - (b.startDate || 0);
  });
  const keep = sorted[0];
  // 打分合并：保留档已有值优先，重复档只补缺口（同人分数不互相覆盖）
  const mergedScores = Object.assign({}, keep.scores || {});
  for (let i = 1; i < sorted.length; i++) {
    const dupScores = sorted[i].scores || {};
    Object.keys(dupScores).forEach((oid) => {
      if (!mergedScores[oid]) mergedScores[oid] = dupScores[oid];
    });
  }
  try {
    await db.collection('cycles').doc(keep._id).update({ data: { scores: mergedScores } });
  } catch (e) {
    console.error('[cycle] 自愈合并打分失败:', keep._id, e && (e.errCode || e.message));
  }
  for (let i = 1; i < sorted.length; i++) {
    const dupId = sorted[i]._id;
    // 迁移引用：笔记与事件指向保留档，避免删除后从界面消失
    try {
      await db.collection('notes').where({ cycleId: dupId }).update({ data: { cycleId: keep._id } });
    } catch (e) {
      console.error('[cycle] 自愈迁移笔记失败:', dupId, e && (e.errCode || e.message));
    }
    try {
      await db.collection('events').where({ cycleId: dupId }).update({ data: { cycleId: keep._id } });
    } catch (e) {
      console.error('[cycle] 自愈迁移事件失败:', dupId, e && (e.errCode || e.message));
    }
    try {
      await db.collection('cycles').doc(dupId).remove();
    } catch (e) {
      console.error('[cycle] 自愈删除重复周期失败:', dupId, e && (e.errCode || e.message));
    }
  }
  keep.scores = mergedScores;
  console.warn('[cycle] 检测到重复活动周期，已自愈合并 pair=' + pairId + ' 保留=' + keep._id);
  return keep;
}

async function createCycle(pair, index, startMs) {
  const days = pair.cycleDays || 7;
  const data = {
    pairId: pair._id,
    index: index,
    startDate: startMs,
    endDate: startMs + days * DAY,
    status: 'active',
    scores: {},
    exchangedAt: null,
    createdAt: startMs,
  };
  // 确定性 ID：同一期并发创建只会成功一次，另一方捕获重复错误后直接读取
  const id = 'cyc_' + pair._id + '_' + index;
  try {
    await db.collection('cycles').add({ data: Object.assign({ _id: id }, data) });
    return Object.assign({ _id: id }, data);
  } catch (e) {
    // 仅当文档确实已存在（并发创建）时才视为正常；其余错误原样抛出，避免掩盖真实故障
    const exists = await getDoc('cycles', id);
    if (exists) return null;
    throw e;
  }
}

async function ensureCurrentCycle(pair) {
  // 只有双方都完成绑定后，第一期才开始计时（修复：绑定前创建周期导致首期提前倒计时）
  if (pair.users.length !== 2) throw new Error('等双方完成绑定后，第一期才开始计时');
  const cur = await getActiveCycle(pair._id);
  if (cur) return cur;
  const lastRes = await db
    .collection('cycles')
    .where({ pairId: pair._id })
    .orderBy('index', 'desc')
    .limit(1)
    .get();
  const last = lastRes.data[0];
  const created = await createCycle(pair, last ? last.index + 1 : 1, Date.now());
  if (created) return created;
  const again = await getActiveCycle(pair._id);
  if (!again) throw new Error('创建周期失败，请稍后重试');
  return again;
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

// 周期到期且双方已打分：自动交换（由 getCurrent / submitScore / reminder 定时任务触发）
async function maybeAutoExchange(pair, cycle, now) {
  if (!cycle || cycle.status !== 'active') return false;
  if (!cycle.endDate || now < cycle.endDate) return false;
  const allDone = pair.users.length === 2 && pair.users.every((oid) => cycle.scores && cycle.scores[oid]);
  if (!allDone) return false;
  // 条件更新：仅当仍处于 active 时才翻转状态，防止与协商交换并发重复执行
  const upd = await db
    .collection('cycles')
    .where({ _id: cycle._id, status: 'active' })
    .update({ data: { status: 'exchanged', exchangedAt: now, exchangeRequest: _.remove() } });
  if (!upd.stats || upd.stats.updated === 0) return false;
  await createCycle(pair, cycle.index + 1, now);
  const map = await usersMap(pair);
  for (let i = 0; i < pair.users.length; i++) {
    await sendSubscribe(pair.users[i], '已自动交换', fmtTime(now), '本期已自动交换，快去看看TA的感受吧');
  }
  return true;
}

const handlers = {
  async getCurrent(payload, openid) {
    const u = await getUser(openid);
    const pair = await getPair(u.pairId);
    const bound = pair.users.length === 2;
    let cycle = null;
    // 只有双方都绑定后才创建/推进周期
    if (bound) {
      cycle = await ensureCurrentCycle(pair);
      // 到期兜底判定：打开小程序时若已到期且双方已打分，自动交换
      const auto = await maybeAutoExchange(pair, cycle, Date.now());
      if (auto) {
        cycle = (await getActiveCycle(pair._id)) || cycle;
      }
    }
    const partner = partnerOf(pair, openid);
    const map = await usersMap(pair);
    const lastRes = await db
      .collection('cycles')
      .where({ pairId: pair._id, status: 'exchanged' })
      .orderBy('index', 'desc')
      .limit(1)
      .get();
    const last = lastRes.data[0];
    const cntRes = await db.collection('cycles').where({ pairId: pair._id, status: 'exchanged' }).count();
    return {
      isMock: false,
      me: openid,
      users: map,
      bound: bound,
      pair: { id: pair._id, cycleDays: pair.cycleDays },
      cycle: cycle
        ? {
            id: cycle._id,
            index: cycle.index,
            startDate: cycle.startDate,
            endDate: cycle.endDate,
            status: cycle.status,
          }
        : null,
      myScore: cycle.scores && cycle.scores[openid] ? cycle.scores[openid] : null,
      partnerDone: !!(partner && cycle.scores && cycle.scores[partner]),
      bothScored: !!(cycle.scores && pair.users.length === 2 && pair.users.every((oid) => cycle.scores[oid])),
      exchangeRequest: cycle.exchangeRequest || null,
      exchangePlan: cycle.exchangePlan || null,
      lastExchanged: last ? { id: last._id, index: last.index } : null,
      exchangedCount: cntRes.total,
    };
  },

  async submitScore(payload, openid) {
    const score = Math.round(Number(payload.score));
    if (isNaN(score) || score < 0 || score > 10) throw new Error('分数需要在 0-10 之间');
    const comment = String(payload.comment || '').trim();
    if (comment.length > 200) throw new Error('留言不能超过 200 字');
    if (comment) await msgSecCheck(openid, comment);
    const u = await getUser(openid);
    const pair = await getPair(u.pairId);
    const cycle = await ensureCurrentCycle(pair);
    if (cycle.status !== 'active') throw new Error('本期已交换');
    // 条件更新：仅当周期仍处于 active 时才写入，防止与并发交换竞态破坏"交换后冻结"
    const upd = await db
      .collection('cycles')
      .where({ _id: cycle._id, status: 'active' })
      .update({ data: { ['scores.' + openid]: { score: score, comment: comment, scoredAt: Date.now() } } });
    if (!upd.stats || upd.stats.updated === 0) {
      throw new Error('本期状态已变化（可能已被交换），请刷新后重试');
    }
    // 同步内存对象：让到期自动交换判定能看到刚写入的分数（修复：最后一人补打分不触发立即交换）
    cycle.scores = cycle.scores || {};
    cycle.scores[openid] = { score: score, comment: comment, scoredAt: Date.now() };
    const prevRes = await db
      .collection('cycles')
      .where({ pairId: pair._id, status: 'exchanged', index: _.lt(cycle.index) })
      .orderBy('index', 'desc')
      .limit(1)
      .get();
    const prev = prevRes.data[0];
    const prevScore = prev && prev.scores && prev.scores[openid] ? prev.scores[openid].score : null;
    // 周期已到期且这是最后一块拼图：立即自动交换
    const autoExchanged = await maybeAutoExchange(pair, cycle, Date.now());
    return {
      ok: true,
      score: score,
      cycleId: cycle._id,
      prevScore: prevScore,
      changed: prevScore !== null && prevScore !== score,
      autoExchanged: !!autoExchanged,
    };
  },

  // 一方发起交换请求，对方同意后交换；请求到达时给对方发订阅提醒
  // 幂等语义：自己重复发起 = 刷新请求并再次提醒对方；对方已有请求时提示先去处理
  async requestExchange(payload, openid) {
    const u = await getUser(openid);
    const pair = await getPair(u.pairId);
    const cycle = await getActiveCycle(pair._id);
    if (!cycle) throw new Error('没有进行中的周期');
    const existing = cycle.exchangeRequest;
    if (existing && existing.from && existing.from !== openid) {
      throw new Error('对方已向你发起交换请求，请先在下方同意或暂不');
    }
    const now = Date.now();
    await db.collection('cycles').doc(cycle._id).update({
      data: { exchangeRequest: { from: openid, at: now } },
    });
    const partner = partnerOf(pair, openid);
    const map = await usersMap(pair);
    if (partner) {
      await sendSubscribe(partner, '交换请求', fmtTime(now), cut((map[openid] ? map[openid].name : 'TA') + '想和你交换感受啦，快去同意吧', 20));
    }
    return { ok: true, resent: !!(existing && existing.from === openid) };
  },

  // 任一方都可撤回/暂不处理当前请求
  async cancelExchangeRequest(payload, openid) {
    const u = await getUser(openid);
    const pair = await getPair(u.pairId);
    const cycle = await getActiveCycle(pair._id);
    if (!cycle) throw new Error('没有进行中的周期');
    // 注意：云数据库 update 传 null 会被忽略，删除字段必须用 _.remove()
    await db.collection('cycles').doc(cycle._id).update({ data: { exchangeRequest: _.remove() } });
    return { ok: true };
  },

  // 同意对方的交换请求：双方都已打分时立即执行交换
  async agreeExchange(payload, openid) {
    const u = await getUser(openid);
    const pair = await getPair(u.pairId);
    const cycle = await getActiveCycle(pair._id);
    if (!cycle) throw new Error('没有进行中的周期');
    const req = cycle.exchangeRequest;
    if (!req || !req.from) throw new Error('当前没有待处理的交换请求');
    if (req.from === openid) throw new Error('已发起请求，等待对方同意');
    const allDone = pair.users.length === 2 && pair.users.every((oid) => cycle.scores && cycle.scores[oid]);
    if (!allDone) throw new Error('双方都完成打分后才能同意交换');
    const now = Date.now();
    // 条件更新：仅当周期仍 active 且待处理请求仍是这条时才翻转，防止并发重复交换
    const upd = await db
      .collection('cycles')
      .where({ _id: cycle._id, status: 'active', 'exchangeRequest.from': req.from })
      .update({ data: { status: 'exchanged', exchangedAt: now, exchangeRequest: _.remove() } });
    if (!upd.stats || upd.stats.updated === 0) {
      throw new Error('本期状态已变化，请刷新后重试');
    }
    await createCycle(pair, cycle.index + 1, now);
    await sendSubscribe(req.from, '交换成功', fmtTime(now), 'TA同意了你的交换请求，快去看看TA的感受吧');
    return { ok: true, exchangedCycleId: cycle._id };
  },

  // 约定交换时间：滚筒选择的「第几天 + 几点」，时间到由 reminder 定时函数提醒双方
  async setExchangePlan(payload, openid) {
    const u = await getUser(openid);
    const pair = await getPair(u.pairId);
    const cycle = await getActiveCycle(pair._id);
    if (!cycle) throw new Error('没有进行中的周期');
    const day = Math.round(Number(payload.day));
    const hour = Math.round(Number(payload.hour));
    if (!(day >= 1 && day <= (pair.cycleDays || 7))) throw new Error('天数超出本期范围');
    if (!(hour >= 0 && hour <= 23)) throw new Error('小时超出范围');
    // 「第 N 天 H 点」按周期开始当天的本地日历日推算（云函数环境为东八区），
    // 修正原先按"起始时刻 + N 天 + H 小时"的时长语义导致的钟点错位
    const start = new Date(cycle.startDate);
    const target = new Date(start.getFullYear(), start.getMonth(), start.getDate() + (day - 1), hour, 0, 0, 0);
    const time = target.getTime();
    if (time <= Date.now()) throw new Error('请选择一个未来的时间');
    const plan = { day: day, hour: hour, time: time, notified: false };
    await db.collection('cycles').doc(cycle._id).update({ data: { exchangePlan: plan } });
    return { exchangePlan: plan };
  },

  async clearExchangePlan(payload, openid) {
    const u = await getUser(openid);
    const pair = await getPair(u.pairId);
    const cycle = await getActiveCycle(pair._id);
    if (!cycle) throw new Error('没有进行中的周期');
    await db.collection('cycles').doc(cycle._id).update({ data: { exchangePlan: _.remove() } });
    return { ok: true };
  },

  async getDetail(payload, openid) {
    const cycleId = payload.cycleId;
    if (!cycleId) throw new Error('缺少周期ID');
    const u = await getUser(openid);
    const pair = await getPair(u.pairId);
    const partner = partnerOf(pair, openid);
    const c = await getDoc('cycles', cycleId);
    if (!c || c.pairId !== pair._id) throw new Error('周期不存在');
    const map = await usersMap(pair);
    const base = {
      id: c._id,
      index: c.index,
      startDate: c.startDate,
      endDate: c.endDate,
      exchangedAt: c.exchangedAt,
      status: c.status,
    };

    if (c.status !== 'exchanged') {
      // 交换前：只能看到自己的分数与自己的笔记
      const mine = await db
        .collection('notes')
        .where({ cycleId: c._id, author: openid })
        .orderBy('createdAt', 'desc')
        .limit(100)
        .get();
      return Object.assign({}, base, {
        my: c.scores && c.scores[openid] ? c.scores[openid] : null,
        partnerDone: !!(partner && c.scores && c.scores[partner]),
        partner: { name: partner && map[partner] ? map[partner].name : '对方', score: null, comment: '', locked: true },
        notes: mine.data.map((n) =>
          Object.assign({}, n, {
            id: n._id,
            mine: true,
            authorName: map[n.author] ? map[n.author].name : '微信用户',
          })
        ),
      });
    }

    // 交换后：双方可见
    const notes = await db.collection('notes').where({ cycleId: c._id }).orderBy('createdAt', 'asc').limit(100).get();
    return Object.assign({}, base, {
      my: c.scores && c.scores[openid] ? c.scores[openid] : null,
      partner: {
        name: partner && map[partner] ? map[partner].name : '对方',
        score: partner && c.scores && c.scores[partner] ? c.scores[partner].score : null,
        comment: partner && c.scores && c.scores[partner] ? c.scores[partner].comment : '',
        locked: false,
      },
      notes: notes.data.map((n) =>
        Object.assign({}, n, {
          id: n._id,
          mine: n.author === openid,
          authorName: map[n.author] ? map[n.author].name : '微信用户',
        })
      ),
    });
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
