/**
 * 双人全流程测试（纯 Node，不需要微信开发者工具）。
 * 通过 stub 全局 wx 存储 API，直接驱动 mock 服务，验证全部业务规则：
 *   功能1 周期打分 + 交换门槛（一方未打分不能交换，交换前不可见）
 *   功能2 感受笔记（随时记录、交换后可见并可批注、交换后不可删）
 *   功能3 周期管理（周期长度自定义、分数仅限当前周期）
 *   功能4 分数变化事件（变化提示记录 + 手动记录 + 历史追踪）
 */
const assert = require('assert');

const store = {};
global.wx = {
  getStorageSync: (k) => store[k],
  setStorageSync: (k, v) => {
    store[k] = v;
  },
  removeStorageSync: (k) => {
    delete store[k];
  },
};

const api = require('../miniprogram/services/mock.js');

async function expectThrow(promise, keyword) {
  try {
    await promise;
  } catch (e) {
    assert.ok(
      !keyword || e.message.includes(keyword),
      `错误信息应包含「${keyword}」，实际为「${e.message}」`
    );
    return e;
  }
  throw new Error('期望抛出异常，但没有抛出');
}

let passed = 0;
function ok(label) {
  passed++;
  console.log('  ✓ ' + label);
}

(async () => {
  console.log('功能1：周期打分与交换门槛');

  await api.init();
  let s = await api.getAppStatus();
  assert.strictEqual(s.isMock, true);
  assert.strictEqual(s.cycle.index, 1);
  assert.strictEqual(s.bothScored, false);
  ok('首次启动自动创建第 1 期，双方均未打分');

  // 没有直接交换入口：必须一方发起请求、对方同意
  await api.requestExchange();
  api.setMe('userB');
  await expectThrow(api.agreeExchange(), '完成打分');
  ok('双方都未打分时，同意交换被拒绝');

  // A 打分（含校验）
  api.setMe('userA');
  await api.requestExchange(); // 自己重复发起：静默覆盖刷新，不报错
  await expectThrow(api.submitScore({ score: 11, comment: '' }), '0-10');
  ok('分数超出 0-10 会被拒绝');

  let r = await api.submitScore({ score: 8, comment: '这周很甜' });
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.prevScore, null);
  s = await api.getAppStatus();
  assert.strictEqual(s.myScore.score, 8);
  assert.strictEqual(s.bothScored, false);
  api.setMe('userB');
  await expectThrow(api.agreeExchange(), '完成打分');
  ok('只有 A 打分时，同意交换仍被拒绝');

  s = await api.getAppStatus();
  assert.strictEqual(s.myScore, null);
  assert.strictEqual(s.partnerDone, true);
  assert.strictEqual(s.bothScored, false);
  ok('B 视角：自己未打分，只知道 A 已完成（看不到 A 的分数）');

  console.log('功能1：交换后互相可见');

  await api.submitScore({ score: 7, comment: '还行' });
  r = await api.agreeExchange();
  assert.ok(r.exchangedCycleId);
  s = await api.getAppStatus();
  assert.strictEqual(s.cycle.index, 2);
  assert.strictEqual(s.myScore, null);
  ok('B 打分后同意请求，交换成功，自动进入第 2 期');

  api.setMe('userA');
  const d1 = await api.getCycleDetail(r.exchangedCycleId);
  assert.strictEqual(d1.my.score, 8);
  assert.strictEqual(d1.partner.score, 7);
  assert.strictEqual(d1.partner.name, '小B');
  ok('交换后 A 可以看到 B 的分数（8 vs 7）');

  const activeDetail = await api.getCycleDetail(s.cycle.id);
  assert.strictEqual(activeDetail.status, 'active');
  assert.strictEqual(activeDetail.partner.locked, true);
  ok('当前未交换的周期，对方数据保持锁定');

  console.log('功能2：感受笔记与批注');

  let noteA = await api.addNote({ type: 'unhappy', content: '游戏打太多了' });
  assert.ok(noteA.id);
  api.setMe('userB');
  const dActive = await api.getCycleDetail(s.cycle.id);
  assert.strictEqual(dActive.notes.length, 0);
  await expectThrow(api.annotate({ noteId: noteA.id, content: '哼' }), '交换后');
  ok('B 在交换前看不到 A 的笔记，也不能批注');

  await api.addNote({ type: 'happy', content: '一起做了饭' });
  api.setMe('userA');
  await api.deleteNote(noteA.id);
  noteA = await api.addNote({ type: 'happy', content: '周末去爬山了' });
  ok('交换前可以随时增删自己的记录');

  console.log('功能3+4：第二期打分、变化事件与追踪');

  r = await api.submitScore({ score: 6, comment: '有点小摩擦' });
  assert.strictEqual(r.prevScore, 8);
  assert.strictEqual(r.changed, true);
  assert.ok(r.cycleId);
  ok('A 第 2 期打 6 分，与上期 8 分比较，提示记录原因');

  await api.addEvent({ cycleId: r.cycleId, prevScore: 8, newScore: 6, reason: '为旅行计划吵架' });
  ok('分数变化原因记录成功');

  // 事件可见性与分数一致：进行中周期的事件对方交换前不可见
  api.setMe('userB');
  let hB = await api.getHistory();
  assert.strictEqual(hB.events.filter((e) => e.reason === '为旅行计划吵架').length, 0);
  ok('交换前，对方看不到进行中周期的分数变化事件');

  api.setMe('userA');

  // 一方发起交换请求，另一方打完分同意后交换
  await api.requestExchange();
  api.setMe('userB');
  const sReq = await api.getAppStatus();
  assert.ok(sReq.exchangeRequest && sReq.exchangeRequest.from === 'userA');
  await expectThrow(api.agreeExchange(), '完成打分');
  ok('对方未打分时，同意交换会被拒绝');

  // 拒绝（暂不）后请求撤下，可以再次发起
  await api.cancelExchangeRequest();
  const sDecl = await api.getAppStatus();
  assert.strictEqual(sDecl.exchangeRequest, null);
  ok('拒绝后请求被撤下');

  api.setMe('userA');
  await api.requestExchange();
  api.setMe('userB');
  await expectThrow(api.requestExchange(), '对方已向你发起');
  ok('对方已有请求待处理时，不能重复发起');
  await api.submitScore({ score: 9, comment: '更好了' });
  r = await api.agreeExchange();
  ok('B 打分后同意再次发起的请求，完成第 2 期交换');

  const d2 = await api.getCycleDetail(r.exchangedCycleId);
  assert.strictEqual(d2.notes.length, 2);
  const aNote = d2.notes.find((n) => n.author === 'userA');
  assert.ok(aNote, '交换后应能看到 A 的笔记');
  await api.annotate({ noteId: aNote.id, content: '下次早点说呀' });
  const d2again = await api.getCycleDetail(r.exchangedCycleId);
  const aNote2 = d2again.notes.find((n) => n.id === aNote.id);
  assert.strictEqual(aNote2.annotations.length, 1);
  assert.strictEqual(aNote2.annotations[0].authorName, '小B');
  ok('交换后 B 看到双方笔记，并成功批注 A 的笔记');

  const hB2 = await api.getHistory();
  assert.ok(hB2.events.some((e) => e.reason === '为旅行计划吵架'));
  ok('交换后，对方可以看到该期的分数变化事件');

  api.setMe('userA');
  const bNote = d2.notes.find((n) => n.author === 'userB');
  await expectThrow(api.deleteNote(bNote.id), '自己');
  ok('不能删除对方的记录');

  api.setMe('userB');
  await expectThrow(api.deleteNote(bNote.id), '不能再删除');
  ok('已交换周期的记录不可删除（内容冻结）');

  api.setMe('userA');
  const h = await api.getHistory();
  assert.strictEqual(h.rows.length, 2);
  assert.deepStrictEqual(h.rows.map((x) => x.myScore), [8, 6]);
  assert.deepStrictEqual(h.rows.map((x) => x.partnerScore), [7, 9]);
  assert.ok(h.events.length >= 1);
  assert.strictEqual(h.events[0].reason, '为旅行计划吵架');
  assert.strictEqual(h.events[0].authorName, '小A');
  assert.strictEqual(h.activeCycle.index, 3);
  ok('历史追踪返回两期分数曲线数据与事件时间线');

  // 删除事件：只能删自己的
  api.setMe('userB');
  await expectThrow(api.deleteEvent(h.events[0].id), '自己');
  ok('不能删除对方的事件');
  api.setMe('userA');
  await api.deleteEvent(h.events[0].id);
  const h2 = await api.getHistory();
  assert.ok(h2.events.every((e) => e.id !== h.events[0].id));
  ok('可以删除自己的事件');

  console.log('功能3：周期自定义');

  r = await api.updateCycleDays(3);
  assert.strictEqual(r.cycleDays, 3);
  s = await api.getAppStatus();
  assert.strictEqual(s.pair.cycleDays, 3);
  await expectThrow(api.updateCycleDays(0), '1-90');
  ok('周期天数可自定义（下一期生效），非法值被拒绝');

  console.log('约定交换时间');

  s = await api.getAppStatus();
  await expectThrow(api.setExchangePlan({ day: 1, hour: 0 }), '未来的时间');
  r = await api.setExchangePlan({ day: s.pair.cycleDays, hour: 23 });
  assert.ok(r.exchangePlan.time > Date.now());
  s = await api.getAppStatus();
  assert.ok(s.exchangePlan && s.exchangePlan.day === s.pair.cycleDays);
  await api.clearExchangePlan();
  s = await api.getAppStatus();
  assert.strictEqual(s.exchangePlan, null);
  ok('可约定/取消交换时间，过去的时间会被拒绝');

  console.log('到期自动交换');

  // 白盒：直接把当前周期改为"已到期且仅 A 已打分"，验证不会自动交换
  s = await api.getAppStatus();
  const dbRaw = store['LOVE_MOCK_DB_V1'];
  const act = dbRaw.cycles.find((c) => c.status === 'active');
  act.endDate = Date.now() - 1000;
  act.scores.userA = { score: 7, comment: '', scoredAt: Date.now() };
  wx.setStorageSync('LOVE_MOCK_DB_V1', dbRaw);
  s = await api.getAppStatus();
  assert.strictEqual(s.cycle.index, 3);
  ok('周期到期但一方未打分：不自动交换，可补打分');

  // B 补齐打分的瞬间自动交换
  api.setMe('userB');
  r = await api.submitScore({ score: 8, comment: '' });
  assert.strictEqual(r.autoExchanged, true);
  s = await api.getAppStatus();
  assert.strictEqual(s.cycle.index, 4);
  ok('到期后双方补齐打分，立即自动交换并进入下一期');

  console.log('服务端校验');

  await expectThrow(api.addNote({ type: 'happy', content: '长'.repeat(501) }), '500');
  ok('笔记超过 500 字会被拒绝');
  await expectThrow(api.addEvent({ reason: '吵架了', prevScore: 99, newScore: 1 }), '0-10');
  ok('事件分数超出 0-10 会被拒绝');

  console.log('重置');

  await api.resetMock();
  s = await api.getAppStatus();
  assert.strictEqual(s.cycle.index, 1);
  assert.strictEqual(s.bothScored, false);
  ok('重置后回到全新第 1 期');

  console.log(`\n全部通过：${passed} 项业务断言 ✓`);
})().catch((e) => {
  console.error('\n✗ 测试失败：' + e.message);
  process.exit(1);
});
