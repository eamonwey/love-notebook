/**
 * cycle 云函数：周期管理、打分、交换、周期详情（含交换前后的可见性控制）
 * 集合：users / pairs / cycles / notes
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const DAY = 24 * 60 * 60 * 1000;
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
  if (res.data.length === 1) return normalizeActive(db, res.data[0]);
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
  return normalizeActive(db, keep);
}

async function createCycle(pair, index, startMs) {
  const days = pair.cycleDays || 7;
  const data = {
    pairId: pair._id,
    index: index,
    startDate: startMs,
    endDate: cycleEnd(startMs, days),
    diamondAllowance: Number.isInteger(pair.diamondAllowance) ? pair.diamondAllowance : 10,
    status: 'active',
    scores: {},
    exchangedAt: null,
    createdAt: startMs,
  };
  // 确定性 ID：同一期并发创建只会成功一次，另一方捕获重复错误后直接读取
  const id = 'cyc_' + pair._id + '_' + index;
  const created = await require('./cycle-store')(db, pair, data);
  return created ? Object.assign({ _id: id }, data) : null;
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
  if (last && last.status === 'exchanged' && last.nextOpenAt > Date.now()) return last;
  const created = await createCycle(pair, last ? last.index + 1 : 1, last && last.nextOpenAt ? last.nextOpenAt : Date.now());
  if (created) return created;
  const again = await getActiveCycle(pair._id);
  if (!again) throw new Error('创建周期失败，请稍后重试');
  return again;
}

function partnerOf(pair, openid) {
  const list = (pair.users || []).filter((x) => x !== openid);
  return list[0] || null;
}

async function usersMap(pair, knownUser) {
  const map = {};
  await Promise.all(pair.users.map(async (oid) => {
    const u = knownUser && knownUser.openid === oid
      ? knownUser
      : (await db.collection('users').where({ openid: oid }).limit(1).get()).data[0];
    map[oid] = { name: u ? u.nickname : '微信用户' };
  }));
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
  // 截止前已打完：下一期从原截止时刻开始，避免定时任务晚执行造成漂移；
  // 截止后才补齐：从最后一次补分时刻开始，避免新一期一创建就已过期。
  const latestScoredAt = Math.max.apply(null, pair.users.map((oid) => Number(cycle.scores[oid].scoredAt || 0)));
  const nextStart = cycle.endDate && latestScoredAt > cycle.endDate ? latestScoredAt : (cycle.endDate || now);
  await createCycle(pair, cycle.index + 1, nextStart);
  return true;
}

// ===== 对外展示整形 =====
// 记录与批注的作者只以「昵称」对外，openid 等内部标识一律不下发到前端，
// 因此界面上不可能出现作者的 id；昵称缺失时退化为「我 / TA」，同样不含 id。
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

const handlers = {
  async getCurrent(payload, openid, context) {
    const timings = {};
    const started = Date.now();
    const measure = async (key, fn) => {
      const t = Date.now();
      try { return await fn(); } finally { timings[key] = Date.now() - t; }
    };
    const u = await measure('userMs', () => getUser(openid));
    const pair = await measure('pairMs', () => getPair(u.pairId));
    const bound = pair.users.length === 2;
    let cycle = null;
    const mapPromise = measure('usersMs', () => usersMap(pair, u));
    const cyclePromise = measure('cycleMs', async () => {
    // 只有双方都绑定后才创建/推进周期
    if (bound) {
      cycle = await ensureCurrentCycle(pair);
      // 到期兜底判定：打开小程序时若已到期且双方已打分，自动交换
      const auto = await maybeAutoExchange(pair, cycle, Date.now());
      if (auto) {
        cycle = (await getActiveCycle(pair._id)) || cycle;
      }
    }
    });
    // 历史查询须在到期交换完成后执行，避免返回旧的最近一期/总数。
    const historyPromise = (async () => {
      await cyclePromise;
      return measure('historyMs', () => !bound ? Promise.resolve([{ data: [] }, { total: 0 }]) : Promise.all([
        db.collection('cycles').where({ pairId: pair._id, status: 'exchanged' })
          .orderBy('index', 'desc').limit(1).get(),
        db.collection('cycles').where({ pairId: pair._id, status: 'exchanged' }).count(),
      ]));
    })();
    const partner = partnerOf(pair, openid);
    const [map, history] = await Promise.all([mapPromise, historyPromise]);
    const [lastRes, cntRes] = history;
    const last = lastRes.data[0];
    if (context) Object.assign(context, { u, pair, map });
    timings.totalMs = Date.now() - started;
    return {
      timings: timings,
      isMock: false,
      me: openid,
      users: map,
      bound: bound,
      pair: { id: pair._id, cycleDays: pair.cycleDays, diamondAllowance: Number.isInteger(pair.diamondAllowance) ? pair.diamondAllowance : 10 },
      cycle: cycle
        ? {
            id: cycle._id,
            index: cycle.index,
            startDate: cycle.startDate,
            endDate: cycle.endDate,
            status: cycle.status,
            nextOpenAt: cycle.nextOpenAt || null,
          }
        : null,
      // 未完成绑定时（pair.users 只有 1 人）cycle 为 null，必须做空值保护：
      // 否则首页拿到 TypeError，前端的「对方还没有接受邀请」引导永远出不来
      myScore: cycle && cycle.scores && cycle.scores[openid] ? cycle.scores[openid] : null,
      partnerDone: !!(cycle && partner && cycle.scores && cycle.scores[partner]),
      bothScored: !!(cycle && cycle.scores && pair.users.length === 2 && pair.users.every((oid) => cycle.scores[oid])),
      exchangeRequest: (cycle && cycle.exchangeRequest) || null,
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
    if (payload.cycleId !== undefined && payload.cycleId !== cycle._id) throw new Error('周期已变化，请重新打开打分页');
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

  // 一方发起交换请求，对方在交换中心同意后交换
  // 幂等语义：自己重复发起 = 刷新请求；对方已有请求时提示先去处理
  // 门槛：发起方自己必须先完成本期打分（避免"请求已发出但自己一直没打分、对方点不动同意"）
  async requestExchange(payload, openid) {
    const u = await getUser(openid);
    const pair = await getPair(u.pairId);
    const cycle = await getActiveCycle(pair._id);
    if (!cycle) throw new Error('没有进行中的周期');
    const existing = cycle.exchangeRequest;
    if (existing && existing.from && existing.from !== openid) {
      // 对方已有请求：优先提示去处理（此时"自己是否打分"不是最相关的信息）
      throw new Error('对方已向你发起交换请求，请先在下方同意或暂不');
    }
    if (!(cycle.scores && cycle.scores[openid])) {
      throw new Error('先完成本期打分，再发起交换请求');
    }
    const now = Date.now();
    const upd = await db.collection('cycles').where({ _id: cycle._id, status: 'active' }).update({
      data: { exchangeRequest: { from: openid, at: now } },
    });
    if (!upd.stats || upd.stats.updated === 0) throw new Error('本期状态已变化，请刷新后重试');
    return { ok: true, resent: !!(existing && existing.from === openid) };
  },

  // 任一方都可撤回/暂不处理当前请求
  async cancelExchangeRequest(payload, openid) {
    const u = await getUser(openid);
    const pair = await getPair(u.pairId);
    const cycle = await getActiveCycle(pair._id);
    if (!cycle) throw new Error('没有进行中的周期');
    // 注意：云数据库 update 传 null 会被忽略，删除字段必须用 _.remove()
    const upd = await db.collection('cycles').where({ _id: cycle._id, status: 'active' }).update({
      data: { exchangeRequest: _.remove() },
    });
    if (!upd.stats || upd.stats.updated === 0) throw new Error('本期状态已变化，请刷新后重试');
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
    const nextOpenAt = (Math.floor((now + 8 * 3600000) / DAY) + 1) * DAY - 8 * 3600000;
    // 条件更新：仅当周期仍 active 且待处理请求仍是这条时才翻转，防止并发重复交换
    const upd = await db
      .collection('cycles')
      .where({ _id: cycle._id, status: 'active', 'exchangeRequest.from': req.from })
      .update({ data: { status: 'exchanged', exchangedAt: now, nextOpenAt, exchangeRequest: _.remove() } });
    if (!upd.stats || upd.stats.updated === 0) {
      throw new Error('本期状态已变化，请刷新后重试');
    }
    return { ok: true, exchangedCycleId: cycle._id, nextOpenAt };
  },

  async getExchangePage(payload, openid) {
    // context 只在本次调用内共享，绝不接受客户端传来的权限上下文。
    const context = {};
    const status = await handlers.getCurrent({}, openid, context);
    const cycleId = payload.cycleId || (status.lastExchanged && status.lastExchanged.id);
    const t = Date.now();
    const detail = cycleId ? await handlers.getDetail({ cycleId }, openid, context) : null;
    const detailMs = Date.now() - t;
    return { status, detail, timings: Object.assign({}, status.timings, {
      detailMs, totalMs: status.timings.totalMs + detailMs,
    }) };
  },

  async getDetail(payload, openid, context) {
    const cycleId = payload.cycleId;
    if (!cycleId) throw new Error('缺少周期ID');
    const u = context ? context.u : await getUser(openid);
    const pair = context ? context.pair : await getPair(u.pairId);
    const partner = partnerOf(pair, openid);
    const c = await getDoc('cycles', cycleId);
    if (!c || c.pairId !== pair._id) throw new Error('周期不存在');
    const map = context ? context.map : await usersMap(pair, u);
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
        .limit(101)
        .get();
      return Object.assign({}, base, {
        my: c.scores && c.scores[openid] ? c.scores[openid] : null,
        partnerDone: !!(partner && c.scores && c.scores[partner]),
        partner: { name: partner && map[partner] ? map[partner].name : '对方', score: null, comment: '', locked: true },
        notes: mine.data.slice(0, 100).map((n) => publicNote(n, map, openid)),
        notesTruncated: mine.data.length > 100,
      });
    }

    // 交换后：双方可见
    // 取「最近 100 条」再翻成时间正序（原实现 asc + limit 截掉的是最新的 100 条）
    const notesRes = await db
      .collection('notes')
      .where({ cycleId: c._id })
      .orderBy('createdAt', 'desc')
      .limit(101)
      .get();
    const notes = notesRes.data.slice(0, 100).reverse();
    return Object.assign({}, base, {
      my: c.scores && c.scores[openid] ? c.scores[openid] : null,
      partner: {
        name: partner && map[partner] ? map[partner].name : '对方',
        score: partner && c.scores && c.scores[partner] ? c.scores[partner].score : null,
        comment: partner && c.scores && c.scores[partner] ? c.scores[partner].comment : '',
        locked: false,
      },
      // 批注作者同样只给昵称（自己的批注标 mine，界面显示「我」），不下发 openid
      notes: notes.map((n) => publicNote(n, map, openid)),
      notesTruncated: notesRes.data.length > 100,
    });
  },
};

Object.assign(handlers, require('./gifts')({ db, getUser, getPair, ensureCurrentCycle, maybeAutoExchange }));

exports.main = async (event) => {
  try {
    const { OPENID } = cloud.getWXContext();
    const handler = handlers[event.action];
    if (!handler) throw new Error('未知操作: ' + event.action);
    const data = await handler(event.payload || {}, OPENID);
    return { ok: true, data: data };
  } catch (e) {
    const internal = e && (e.errCode !== undefined || e.errcode !== undefined || e.name === 'TypeError');
    if (internal) console.error('[cycle] internal request failure:', e);
    if (['getGiftState', 'sendGift', 'acknowledgeGift'].includes(event.action)) {
      // 只返回固定步骤与错误码；数据库原始消息可能包含身份或查询条件，不下发。
      const stages = ['gift.user', 'gift.pair', 'gift.cycle', 'gift.advance', 'gift.nextCycle', 'gift.inbox'];
      const rawCode = String(e.errCode !== undefined ? e.errCode : e.errcode !== undefined ? e.errcode : e.code || 'UNKNOWN');
      const diagnostic = {
        version: 'gift-diag-1',
        stage: stages.includes(e.giftStage) ? e.giftStage : 'gift.' + event.action,
        code: /^[A-Za-z0-9_-]{1,64}$/.test(rawCode) ? rawCode : 'UNKNOWN',
        type: ['TypeError', 'RangeError', 'ReferenceError'].includes(e.name) ? e.name : 'Error',
      };
      return { ok: false, error: internal ? '服务暂时不可用，请稍后重试' : e.message, diagnostic };
    }
    return { ok: false, error: internal ? '服务暂时不可用，请稍后重试' : e.message };
  }
};
