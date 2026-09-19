/**
 * pair 云函数：伴侣配对（邀请码）、昵称、周期天数设置
 * 集合：users / pairs
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

async function getUser(openid) {
  const res = await db.collection('users').where({ openid: openid }).limit(1).get();
  return res.data[0] || null;
}

async function ensureUser(openid, nickname) {
  let u = await getUser(openid);
  if (!u) {
    const add = await db
      .collection('users')
      .add({ data: { openid: openid, nickname: nickname || '微信用户', pairId: '', createdAt: Date.now() } });
    u = { _id: add._id, openid: openid, nickname: nickname || '微信用户', pairId: '' };
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
// 判定违规：拒绝保存；接口自身故障（权限/频率/网络）：放行并记日志，不阻断主流程。
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
    console.error('msgSecCheck error, allow content:', e && (e.errCode || e.errMsg || e.message));
    return;
  }
  if (res && res.result && res.result.suggest && res.result.suggest !== 'pass') {
    throw new Error('昵称可能包含平台不允许的文字（微信安全检测），请换一个试试');
  }
}

const handlers = {
  async create(payload, openid) {
    const u = await ensureUser(openid);
    if (u.pairId) {
      const mine = await getPairById(u.pairId);
      if (mine) return { pair: { _id: mine._id, code: mine.code, status: mine.status, users: mine.users }, code: mine.code };
    }
    let code = '';
    for (;;) {
      code = '';
      for (let i = 0; i < 6; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
      const dup = await db.collection('pairs').where({ code: code, status: 'open' }).count();
      if (dup.total === 0) break;
    }
    const data = { users: [openid], owner: openid, code: code, cycleDays: 7, status: 'open', createdAt: Date.now() };
    const add = await db.collection('pairs').add({ data: data });
    await db.collection('users').doc(u._id).update({ data: { pairId: add._id } });
    return { pair: { _id: add._id, code: code, status: 'open', users: [openid] }, code: code };
  },

  async join(payload, openid) {
    const u = await ensureUser(openid);
    const code = normalizeCode(payload.code);
    if (!code) throw new Error('请输入对方的邀请码');
    if (u.pairId) {
      const mine = await getPairById(u.pairId);
      if (mine && mine.users.indexOf(openid) >= 0) {
        if (mine.users.length >= 2) throw new Error('你已绑定伴侣，无法再次接受邀请');
        if (mine.code === code) throw new Error('这是你自己的邀请码，把TA发给对方吧');
        // 自己曾生成过邀请但还没人加入：作废它，再加入对方的
        try {
          await db.collection('pairs').doc(mine._id).update({ data: { status: 'closed' } });
        } catch (e) { /* ignore */ }
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
    const joined = await db
      .collection('pairs')
      .where({ _id: pair._id, status: 'open', users: _.size(1) })
      .update({ data: { users: _.push(openid), status: 'closed' } });
    if (!joined.stats || joined.stats.updated === 0) {
      throw new Error('该邀请码刚被其他人使用，请让对方重新生成');
    }
    await db.collection('users').doc(u._id).update({ data: { pairId: pair._id } });
    return { pair: Object.assign({}, pair, { users: pair.users.concat([openid]), status: 'closed' }) };
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
    return { ownerName: owner ? owner.nickname : 'TA' };
  },

  async get(payload, openid) {
    const u = await ensureUser(openid);
    if (!u.pairId) return { pair: null, users: {} };
    const pair = await getPairById(u.pairId);
    if (!pair) return { pair: null, users: {} };
    const users = {};
    for (let i = 0; i < pair.users.length; i++) {
      const ou = await getUser(pair.users[i]);
      users[pair.users[i]] = { name: ou ? ou.nickname : '微信用户' };
    }
    return {
      pair: { _id: pair._id, code: pair.code, status: pair.status, cycleDays: pair.cycleDays, users: pair.users },
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

  // 单方面解绑：无需对方同意。双方 pairId 清空，pair 归档封存（历史保留在数据库，不再展示）
  async unbind(payload, openid) {
    const u = await ensureUser(openid);
    if (!u.pairId) return { ok: true, unbound: true };
    const pair = await getPairById(u.pairId);
    await db.collection('users').doc(u._id).update({ data: { pairId: '' } });
    if (pair) {
      // 终止进行中的周期并清除请求/计划，防止解绑后定时任务继续通知或自动交换
      try {
        await db
          .collection('cycles')
          .where({ pairId: pair._id, status: 'active' })
          .update({
            data: { status: 'archived', exchangeRequest: _.remove(), exchangePlan: _.remove() },
          });
      } catch (e) { /* ignore */ }
      for (let i = 0; i < pair.users.length; i++) {
        const oid = pair.users[i];
        if (oid === openid) continue;
        const other = await getUser(oid);
        if (other && other.pairId === pair._id) {
          await db.collection('users').doc(other._id).update({ data: { pairId: '' } });
        }
      }
      try {
        await db.collection('pairs').doc(pair._id).update({ data: { status: 'archived' } });
      } catch (e) { /* ignore */ }
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
    return { ok: false, error: e.message };
  }
};
