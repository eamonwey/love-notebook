/**
 * note 云函数：感受记录（开心/不满）与批注
 * 集合：users / pairs / cycles / notes
 * 规则：交换前只能写/删自己的记录；批注仅限已交换的周期。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

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
    return best;
  }
  const lastRes = await db.collection('cycles').where({ pairId: pair._id }).orderBy('index', 'desc').limit(1).get();
  const last = lastRes.data[0];
  const days = pair.cycleDays || 7;
  const now = Date.now();
  const index = last ? last.index + 1 : 1;
  const data = {
    pairId: pair._id,
    index: index,
    startDate: now,
    endDate: now + days * 24 * 60 * 60 * 1000,
    status: 'active',
    scores: {},
    exchangedAt: null,
    createdAt: now,
  };
  // 确定性 ID：与 cycle 云函数一致，并发创建只会成功一次
  try {
    await db.collection('cycles').add({ data: Object.assign({ _id: 'cyc_' + pair._id + '_' + index }, data) });
  } catch (e) { /* 并发已创建，读取即可 */ }
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
    if (cycle.status !== 'active') throw new Error('本期已交换，下期再记录吧');
    const data = {
      pairId: pair._id,
      cycleId: cycle._id,
      author: openid,
      type: payload.type,
      content: content,
      annotations: [],
      createdAt: Date.now(),
    };
    // 二次确认周期仍开放（缩小与并发交换之间的竞态窗口）
    const fresh = await getDoc('cycles', cycle._id);
    if (!fresh || fresh.status !== 'active') throw new Error('本期已交换，下期再记录吧');
    const add = await db.collection('notes').add({ data: data });
    return Object.assign({ _id: add._id, id: add._id, mine: true }, data);
  },

  async remove(payload, openid) {
    const note = await getDoc('notes', payload.id);
    if (!note) throw new Error('记录不存在');
    if (note.author !== openid) throw new Error('只能删除自己的记录');
    const cycle = await getDoc('cycles', note.cycleId);
    if (!cycle || cycle.status !== 'active') throw new Error('已交换的记录不能再删除');
    await db.collection('notes').doc(payload.id).remove();
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
      .limit(100)
      .get();
    return {
      cycle: { id: cycle._id, index: cycle.index },
      notes: res.data.map((n) => Object.assign({}, n, { id: n._id, mine: true })),
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
    const ann = { id: 'a' + Date.now(), author: openid, content: content, createdAt: Date.now() };
    await db.collection('notes').doc(payload.noteId).update({ data: { annotations: _.push(ann) } });
    return { ok: true };
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
