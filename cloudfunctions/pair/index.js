/**
 * pair 云函数：伴侣配对（邀请码）、昵称、周期天数设置
 * 集合：users / pairs
 */
const cloud = require('wx-server-sdk');
const { cycleEnd } = require('./cycle-calendar');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function userDocId(openid) {
  return 'u_' + crypto.createHash('sha256').update(String(openid)).digest('hex').slice(0, 32);
}

function pairDocId() {
  return 'pair_' + crypto.randomBytes(16).toString('hex');
}

async function getUser(openid) {
  const res = await db.collection('users').where({ openid: openid }).limit(1).get();
  return res.data[0] || null;
}

async function ensureUser(openid, nickname) {
  let u = await getUser(openid);
  if (!u) {
    const id = userDocId(openid);
    const data = { _id: id, openid: openid, nickname: nickname || '微信用户', pairId: '', createdAt: Date.now() };
    try {
      await db.collection('users').add({ data: data });
      u = data;
    } catch (e) {
      // 同一微信首次并发进入时，确定性 ID 只允许一个请求创建成功。
      const again = await getUser(openid);
      if (!again) throw e;
      u = again;
    }
  } else if (nickname && nickname !== u.nickname) {
    await db.collection('users').doc(u._id).update({ data: { nickname: nickname } });
    u.nickname = nickname;
  }
  return u;
}

async function getPairById(pairId) {
  try {
    const res = await db.collection('pairs').doc(pairId).get();
    return res.data;
  } catch (e) {
    return null;
  }
}

// 全角字符归一（中文输入法输码常见坑），统一大写并去空格
function normalizeCode(raw) {
  return String(raw || '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .toUpperCase()
    .trim();
}

// ===== 内容安全 =====
// 用户输入文本统一过微信 msgSecCheck 2.0（场景：1 资料，昵称属于个人资料）。
// 判定违规或安全接口故障时均拒绝本次保存，避免审核不可用时违规内容落库。
async function msgSecCheck(openid, content) {
  let res = null;
  try {
    res = await cloud.openapi.security.msgSecCheck({
      openid: openid,
      scene: 1,
      version: 2,
      content: String(content || ''),
    });
  } catch (e) {
    const errCode = e && (e.errCode !== undefined ? e.errCode : e.errcode);
    if (errCode === 87014 || String((e && (e.errMsg || e.message)) || '').indexOf('87014') >= 0) {
      throw new Error('昵称可能包含平台不允许的文字（微信安全检测），请换一个试试');
    }
    console.error('msgSecCheck unavailable:', e && (e.errCode || e.errMsg || e.message));
    throw new Error('内容安全检测暂时不可用，请稍后重试');
  }
  if (res && res.result && res.result.suggest && res.result.suggest !== 'pass') {
    throw new Error('昵称可能包含平台不允许的文字（微信安全检测），请换一个试试');
  }
}

const handlers = {
  async create(payload, openid) {
    const days = Number(payload.days);
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('请先选择交换周期（1-90 天的整数）');
    const u = await ensureUser(openid);
    let stalePairId = '';
    if (u.pairId) {
      const mine = await getPairById(u.pairId);
      if (mine) return { pair: { _id: mine._id, code: mine.code, status: mine.status, users: mine.users }, code: mine.code };
      stalePairId = u.pairId;
    }
    let code = '';
    for (;;) {
      code = '';
      for (let i = 0; i < 6; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
      const dup = await db.collection('pairs').where({ code: code, status: 'open' }).count();
      if (dup.total === 0) break;
    }
    const id = pairDocId();
    const data = { _id: id, users: [openid], owner: openid, code: code, cycleDays: days, status: 'open', createdAt: Date.now() };
    const txResult = await db.runTransaction(async (transaction) => {
      const freshUser = (await transaction.collection('users').doc(u._id).get()).data;
      if (freshUser.pairId && freshUser.pairId !== stalePairId) return { existingPairId: freshUser.pairId };
      const stored = Object.assign({}, data);
      delete stored._id;
      await transaction.collection('pairs').doc(id).set({ data: stored });
      await transaction.collection('users').doc(u._id).update({ data: { pairId: id } });
      return { created: true };
    });
    const txData = txResult && txResult.result ? txResult.result : txResult;
    if (txData && txData.existingPairId) {
      const existing = await getPairById(txData.existingPairId);
      if (existing) {
        return { pair: { _id: existing._id, code: existing.code, status: existing.status, users: existing.users }, code: existing.code };
      }
      throw new Error('配对状态异常，请稍后重试');
    }
    return { pair: { _id: id, code: code, status: 'open', users: [openid] }, code: code };
  },

  async join(payload, openid) {
    const u = await ensureUser(openid);
    const code = normalizeCode(payload.code);
    if (!code) throw new Error('请输入对方的邀请码');
    let pendingPairId = '';
    let stalePairId = '';
    if (u.pairId) {
      const mine = await getPairById(u.pairId);
      if (mine && mine.users.indexOf(openid) >= 0) {
        if (mine.users.length >= 2) throw new Error('你已绑定伴侣，无法再次接受邀请');
        if (mine.code === code) throw new Error('这是你自己的邀请码，把TA发给对方吧');
        // 自己曾生成过邀请但还没人加入：在下面的事务中一并作废。
        pendingPairId = mine._id;
      } else if (!mine) {
        stalePairId = u.pairId;
      }
    }
    const res = await db.collection('pairs').where({ code: code, status: 'open' }).limit(1).get();
    const pair = res.data[0];
    if (!pair) {
      // 细分原因：码存在但已失效（closed/archived），还是根本不存在
      const any = await db.collection('pairs').where({ code: code }).limit(1).get();
      if (any.data[0]) throw new Error('该邀请码已失效（已完成邀请或已解绑），请让对方重新生成');
      throw new Error('邀请码无效，请核对后重试');
    }
    if (pair.users.length >= 2) throw new Error('该邀请码已被使用');
    if (pair.users.indexOf(openid) >= 0) {
      await db.collection('users').doc(u._id).update({ data: { pairId: pair._id } });
      return { pair: pair };
    }
    // 原子加入：仅当邀请仍开放且只有发起人一人时才写入（条件更新），
    // 杜绝两个并发接受把同一邀请变成三人配对
    const oldPairId = pendingPairId && pendingPairId !== pair._id ? pendingPairId : '';
    const owner = await getUser(pair.users[0]);
    if (!owner) throw new Error('邀请已失效');
    // 只恢复这两个微信账号共同拥有的最近一本封存笔记本。
    const previous = await db.collection('pairs').where({ status: 'archived', users: _.all([pair.users[0], openid]) })
      .orderBy('createdAt', 'desc').limit(1).get();
    const archived = previous.data[0];
    const lastCycles = archived ? await db.collection('cycles').where({ pairId: archived._id }).orderBy('index', 'desc').limit(1).get() : { data: [] };
    const lastCycle = lastCycles.data[0];
    const txResult = await db.runTransaction(async (transaction) => {
      const fresh = (await transaction.collection('pairs').doc(pair._id).get()).data;
      const freshUser = (await transaction.collection('users').doc(u._id).get()).data;
      if (freshUser.pairId && freshUser.pairId !== oldPairId && freshUser.pairId !== stalePairId && freshUser.pairId !== pair._id) {
        throw new Error('你的配对状态已变化，请刷新后重试');
      }
      if (fresh.status !== 'open' || !fresh.users || fresh.users.length !== 1) {
        throw new Error('该邀请码刚被其他人使用，请让对方重新生成');
      }
      if (fresh.users.indexOf(openid) >= 0) throw new Error('这是你自己的邀请码，把TA发给对方吧');
      const freshOwner = (await transaction.collection('users').doc(owner._id).get()).data;
      if (freshOwner.pairId !== pair._id) throw new Error('对方配对状态已变化，请重新邀请');
      const users = fresh.users.concat([openid]);
      if (archived) {
        const restored = (await transaction.collection('pairs').doc(archived._id).get()).data;
        if (restored.status !== 'archived' || restored.users.length !== 2 || !users.every((id) => restored.users.includes(id))) throw new Error('历史配对状态已变化，请重试');
        const now = Date.now();
        const index = lastCycle ? lastCycle.index + 1 : 1;
        await transaction.collection('pairs').doc(restored._id).update({ data: { status: 'closed', resumedAt: now } });
        await transaction.collection('pairs').doc(pair._id).update({ data: { status: 'closed' } });
        await transaction.collection('users').doc(u._id).update({ data: { pairId: restored._id } });
        await transaction.collection('users').doc(owner._id).update({ data: { pairId: restored._id } });
        if (lastCycle && lastCycle.status === 'archived') {
          await transaction.collection('cycles').doc(lastCycle._id).update({ data: { resumedAt: now } });
        }
        await transaction.collection('cycles').doc('cyc_' + restored._id + '_' + index).set({ data: {
          pairId: restored._id, index, startDate: now, endDate: cycleEnd(now, restored.cycleDays || 7),
          diamondAllowance: Number.isInteger(restored.diamondAllowance) ? restored.diamondAllowance : 10,
          status: 'active', scores: {}, exchangedAt: null, createdAt: now,
        } });
        if (oldPairId) await transaction.collection('pairs').doc(oldPairId).update({ data: { status: 'closed' } });
        return { restoredPair: Object.assign({}, restored, { status: 'closed', resumedAt: now }) };
      }
      await transaction.collection('pairs').doc(pair._id).update({ data: { users: users, status: 'closed' } });
      await transaction.collection('users').doc(u._id).update({ data: { pairId: pair._id } });
      if (oldPairId) {
        await transaction.collection('pairs').doc(oldPairId).update({ data: { status: 'closed' } });
      }
      return { users: users };
    });
    const result = txResult && txResult.result ? txResult.result : txResult;
    if (result.restoredPair) return { pair: result.restoredPair, restored: true };
    return { pair: Object.assign({}, pair, { users: result.users, status: 'closed' }) };
  },

  async preview(payload, openid) {
    const code = normalizeCode(payload.code);
    if (!code) throw new Error('邀请码无效');
    const res = await db.collection('pairs').where({ code: code, status: 'open' }).limit(1).get();
    const pair = res.data[0];
    if (!pair) {
      const any = await db.collection('pairs').where({ code: code }).limit(1).get();
      if (any.data[0]) throw new Error('该邀请码已失效（已完成邀请或已解绑），请让对方重新生成');
      throw new Error('邀请码无效，请核对后重试');
    }
    if (pair.users.length >= 2) throw new Error('该邀请已被使用');
    if (pair.users.indexOf(openid) >= 0) throw new Error('这是你自己发出的邀请');
    const owner = await getUser(pair.users[0]);
    const previous = await db.collection('pairs').where({ status: 'archived', users: _.all([pair.users[0], openid]) }).orderBy('createdAt', 'desc').limit(1).get();
    const archived = previous.data[0];
    return { ownerName: owner ? owner.nickname : 'TA', cycleDays: archived ? archived.cycleDays : pair.cycleDays, restoresHistory: !!archived };
  },

  async get(payload, openid) {
    const u = await ensureUser(openid);
    if (!u.pairId) return { me: openid, pair: null, users: { [openid]: { name: u.nickname } } };
    const pair = await getPairById(u.pairId);
    if (!pair) return { me: openid, pair: null, users: { [openid]: { name: u.nickname } } };
    const users = {};
    await Promise.all(pair.users.map(async (oid) => {
      const ou = oid === openid ? u : await getUser(oid);
      users[oid] = { name: ou ? ou.nickname : '微信用户' };
    }));
    return {
      me: openid,
      pair: { _id: pair._id, code: pair.code, status: pair.status, cycleDays: pair.cycleDays, users: pair.users,
        diamondAllowance: Number.isInteger(pair.diamondAllowance) ? pair.diamondAllowance : 10 },
      users: users,
    };
  },

  async updateCycleDays(payload, openid) {
    const days = Math.round(Number(payload.days));
    if (!(days >= 1 && days <= 90)) throw new Error('周期天数需要在 1-90 之间');
    const u = await ensureUser(openid);
    if (!u.pairId) throw new Error('还没有配对');
    await db.collection('pairs').doc(u.pairId).update({ data: { cycleDays: days } });
    return { cycleDays: days };
  },

  async updateDiamondAllowance(payload, openid) {
    const amount = payload.amount;
    if (!Number.isInteger(amount) || amount < 0 || amount > 100) throw new Error('钻石额度需要是0–100的整数');
    const u = await ensureUser(openid);
    if (!u.pairId) throw new Error('请先完成双方配对');
    await db.runTransaction(async (tx) => {
      const user = (await tx.collection('users').doc(u._id).get()).data;
      const pair = (await tx.collection('pairs').doc(u.pairId).get()).data;
      if (!pair || user.pairId !== pair._id || pair.status === 'archived' || pair.users.length !== 2 || !pair.users.includes(openid)) throw new Error('请先完成双方配对');
      await tx.collection('pairs').doc(pair._id).update({ data: { diamondAllowance: amount } });
    });
    return { diamondAllowance: amount };
  },

  // 单方面解绑：无需对方同意。双方 pairId 清空，pair 归档封存（历史保留在数据库，不再展示）
  async unbind(payload, openid) {
    const u = await ensureUser(openid);
    if (!u.pairId) return { ok: true, unbound: true };
    const pair = await getPairById(u.pairId);
    if (pair) {
      const others = [];
      for (let i = 0; i < pair.users.length; i++) {
        if (pair.users[i] !== openid) {
          const other = await getUser(pair.users[i]);
          if (other) others.push(other);
        }
      }
      const active = await db.collection('cycles').where({ pairId: pair._id, status: 'active' }).limit(100).get();
      const latest = await db.collection('cycles').where({ pairId: pair._id }).orderBy('index', 'desc').limit(1).get();
      // 周期中断与双方解绑一起提交，避免恢复时误续上未结束的周期。
      await db.runTransaction(async (transaction) => {
        const freshUser = (await transaction.collection('users').doc(u._id).get()).data;
        const freshPair = (await transaction.collection('pairs').doc(pair._id).get()).data;
        if (freshUser.pairId !== pair._id || freshPair.status === 'archived') throw new Error('配对状态已变化，请刷新');
        if ((freshPair.cycleRevision || 0) !== (pair.cycleRevision || 0)) throw new Error('周期状态已变化，请重新解绑');
        const pausedAt = Date.now();
        await transaction.collection('pairs').doc(pair._id).update({ data: { status: 'archived', pausedAt } });
        for (const cycle of active.data) {
          const current = (await transaction.collection('cycles').doc(cycle._id).get()).data;
          if (current.status !== 'active') throw new Error('周期状态已变化，请重新解绑');
          await transaction.collection('cycles').doc(cycle._id).update({ data: { status: 'archived', pausedAt, exchangeRequest: _.remove(), exchangePlan: _.remove() } });
        }
        if (!active.data.length && freshPair.users.length === 2) {
          const index = latest.data.length ? latest.data[0].index + 1 : 1;
          await transaction.collection('cycles').doc('cyc_' + pair._id + '_' + index).set({ data: {
            pairId: pair._id, index, status: 'archived', pausedAt, startDate: pausedAt, endDate: pausedAt, scores: {}, createdAt: pausedAt,
          } });
        }
        await transaction.collection('users').doc(u._id).update({ data: { pairId: '' } });
        for (let i = 0; i < others.length; i++) {
          if (others[i].pairId === pair._id) {
            await transaction.collection('users').doc(others[i]._id).update({ data: { pairId: '' } });
          }
        }
      });
    } else {
      await db.collection('users').doc(u._id).update({ data: { pairId: '' } });
    }
    return { ok: true, unbound: true };
  },

  async setNickname(payload, openid) {
    const nickname = String(payload.nickname || '').trim();
    if (!nickname) throw new Error('昵称不能为空');
    if (nickname.length > 20) throw new Error('昵称不能超过 20 字');
    await msgSecCheck(openid, nickname);
    await ensureUser(openid, nickname);
    return { nickname: nickname };
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
    if (internal) console.error('[pair] internal request failure:', e);
    return { ok: false, error: internal ? '服务暂时不可用，请稍后重试' : e.message };
  }
};
