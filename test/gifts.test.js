const assert = require('assert');
const Module = require('module');
const fs = require('fs');
const path = require('path');
const store = {};
global.wx = {
  getStorageSync: (key) => store[key],
  setStorageSync: (key, value) => { store[key] = value; },
  removeStorageSync: (key) => { delete store[key]; },
  showToast() {},
  showModal: (options) => options.success({ confirm: true }),
  nextTick: (fn) => fn(),
};
const api = require('../miniprogram/services/mock');
const { advanceTo } = require('./clock');
let definition;
global.Component = (value) => { definition = value; };
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === '../../services/api.js') return api;
  return originalLoad.apply(this, arguments);
};
require('../miniprogram/components/gift-hub/gift-hub');
Module._load = originalLoad;
function component() {
  const instance = Object.assign({}, definition.methods, {
    data: JSON.parse(JSON.stringify(definition.data)), _visible: true, events: [],
    setData(patch) { Object.assign(this.data, patch); },
    triggerEvent(name, data) { this.events.push({ name, data }); },
  });
  return instance;
}

(async () => {
  const root = path.join(__dirname, '../miniprogram');
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  for (const route of app.pages) {
    const pageFile = path.join(root, route);
    if (!fs.readFileSync(pageFile + '.wxml', 'utf8').includes('<gift-hub')) continue;
    const registration = JSON.parse(fs.readFileSync(pageFile + '.json', 'utf8')).usingComponents['gift-hub'];
    const componentPath = path.resolve(path.dirname(pageFile), registration);
    for (const ext of ['js', 'json', 'wxml', 'wxss']) assert.ok(fs.existsSync(componentPath + '.' + ext), componentPath + '.' + ext);
    assert.strictEqual(JSON.parse(fs.readFileSync(componentPath + '.json', 'utf8')).component, true);
  }
  const failed = component();
  const originalState = api.getGiftState;
  const originalError = console.error;
  let logged = false;
  console.error = () => { logged = true; };
  api.getGiftState = async () => { throw new Error('未知操作: getGiftState'); };
  await failed.refreshGifts();
  assert.strictEqual(failed.data.loading, false);
  assert.ok(failed.data.error.includes('重试'));
  assert.strictEqual(logged, true);
  console.error = originalError;
  api.getGiftState = originalState;
  await failed.refreshGifts();
  assert.strictEqual(failed.data.error, '');
  assert.strictEqual(failed.data.state.available, true);
  console.log('✓ 各页面组件注册路径与四文件完整，加载失败显示重试提示并能恢复');
  await api.resetMock();
  await api.setMe('userA');
  const sender = component();
  await sender.refreshGifts();
  assert.strictEqual(sender.data.state.balance, 10);
  // 模拟服务端已提交、响应在网络中丢失；重试必须沿用存储的请求编号。
  const originalSend = api.sendGift;
  api.sendGift = async (p) => { await originalSend(p); throw new Error('网络断开'); };
  const tapFlower = { currentTarget: { dataset: { type: 'flower' } } };
  await sender.sendGift(tapFlower);
  const key = 'LOVE_GIFT_PENDING_' + sender.data.state.walletKey;
  assert.ok(store[key]);
  api.sendGift = originalSend;
  await sender.sendGift(tapFlower);
  assert.strictEqual(store[key], undefined);
  assert.strictEqual((await api.getGiftState()).balance, 9);
  await api.setMe('userB');
  const receiver = component();
  await receiver.refreshGifts();
  assert.strictEqual(receiver.data.effect.type, 'flower');
  assert.strictEqual(receiver.data.state.inbox.length, 1);
  receiver.pause();
  assert.strictEqual(receiver.data.effect, null);
  assert.strictEqual((await api.getGiftState()).inbox.length, 1);
  receiver._visible = true;
  await receiver.refreshGifts();
  const originalAck = api.acknowledgeGift;
  api.acknowledgeGift = async () => { throw new Error('offline'); };
  await receiver.receiveGift();
  assert.ok(receiver.data.effect);
  api.acknowledgeGift = originalAck;
  await receiver.receiveGift();
  assert.strictEqual(receiver.data.effect, null);
  assert.strictEqual((await api.getGiftState()).inbox.length, 0);
  assert.strictEqual(receiver.events.at(-1).data.active, false);
  console.log('✓ 送礼响应丢失安全重试、收礼展示、后台不吞未读、已读失败可重试');

  const state = await api.getGiftState();
  const concurrent = await Promise.allSettled([
    api.sendGift({ cycleId: state.cycleId, type: 'car', requestId: 'concurrent_car_1' }),
    api.sendGift({ cycleId: state.cycleId, type: 'car', requestId: 'concurrent_car_2' }),
  ]);
  assert.strictEqual(concurrent.filter((r) => r.status === 'fulfilled').length, 1);
  assert.strictEqual((await api.getGiftState()).balance, 0);
  await api.setMe('userA');
  await api.submitScore({ score: 8, comment: '' });
  await api.requestExchange();
  await api.setMe('userB');
  await api.submitScore({ score: 9, comment: '' });
  advanceTo((await api.agreeExchange()).nextOpenAt);
  assert.strictEqual((await api.getGiftState()).balance, 10);
  await api.setMe('userA');
  const next = await api.getGiftState();
  assert.strictEqual(next.balance, 10);
  assert.strictEqual(next.inbox[0].type, 'car');
  console.log('✓ 演示模式并发送礼不透支、新周期各自重置10颗、跨期保留未读礼物');

  await api.resetMock();
  await api.setMe('userA');
  const batchState = await api.getGiftState();
  for (let i = 0; i < 10; i++) {
    await api.sendGift({ cycleId: batchState.cycleId, type: 'flower', requestId: 'batch_flower_' + i });
  }
  await api.setMe('userB');
  const batch = component();
  await batch.refreshGifts();
  assert.strictEqual(batch.data.effect.count, 10);
  assert.strictEqual(batch.data.effect.ids.length, 10);
  api.acknowledgeGift = async () => { throw new Error('offline'); };
  await batch.receiveGift();
  assert.strictEqual(batch.data.effect.count, 10);
  assert.strictEqual((await api.getGiftState()).inbox.length, 10);
  api.acknowledgeGift = originalAck;
  await batch.receiveGift();
  assert.strictEqual(batch.data.effect, null);
  assert.strictEqual((await api.getGiftState()).inbox.length, 0);
  assert.strictEqual(batch.events.filter((e) => e.data.active).length, 1);
  console.log('✓ 十朵花只展示一组，批量收下失败可重试，成功后全部已读');

  // 后到的礼物和不同类型不应被当前展示组一起收下。
  await api.resetMock();
  await api.setMe('userA');
  const arrivalState = await api.getGiftState();
  await api.sendGift({ cycleId: arrivalState.cycleId, type: 'flower', requestId: 'arrival_first' });
  await api.setMe('userB');
  const arrival = component();
  await arrival.refreshGifts();
  await api.setMe('userA');
  await api.sendGift({ cycleId: arrivalState.cycleId, type: 'flower', requestId: 'arrival_second' });
  await api.sendGift({ cycleId: arrivalState.cycleId, type: 'letter', requestId: 'arrival_letter' });
  await api.setMe('userB');
  await arrival.refreshGifts();
  assert.strictEqual(arrival.data.effect.count, 1);
  await arrival.receiveGift();
  assert.strictEqual((await api.getGiftState()).inbox.length, 2);
  assert.strictEqual(arrival.data.effect.type, 'flower');
  await arrival.receiveGift();
  assert.strictEqual(arrival.data.effect.type, 'letter');
  await arrival.receiveGift();
  assert.strictEqual((await api.getGiftState()).inbox.length, 0);
  console.log('✓ 展示期间新到礼物不被误读，不同类型分别播放');

  await api.resetMock();
  await api.setMe('userA');
  const quantitySender = component();
  await quantitySender.refreshGifts();
  assert.strictEqual(quantitySender.onQuantityChange, undefined);
  const shelf = fs.readFileSync(path.join(root, 'components/gift-hub/gift-hub.wxml'), 'utf8');
  assert.ok(!shelf.includes('<picker'));
  const quantityKey = 'LOVE_GIFT_PENDING_' + quantitySender.data.state.walletKey;
  store[quantityKey] = { type: 'flower', quantity: 10, cycleId: quantitySender.data.state.cycleId, requestId: 'legacy_quantity_10' };
  api.sendGift = async (p) => { await originalSend(p); throw new Error('网络断开'); };
  await quantitySender.sendGift(tapFlower);
  assert.strictEqual(store[quantityKey].quantity, 10);
  api.sendGift = originalSend;
  await quantitySender.sendGift(tapFlower);
  assert.strictEqual(store[quantityKey], undefined);
  assert.strictEqual((await api.getGiftState()).balance, 0);
  await api.setMe('userB');
  const quantityReceiver = component();
  await quantityReceiver.refreshGifts();
  assert.strictEqual(quantityReceiver.data.effect.count, 10);
  assert.strictEqual(quantityReceiver.data.effect.ids.length, 1);
  await quantityReceiver.receiveGift();
  assert.strictEqual((await api.getGiftState()).inbox.length, 0);
  console.log('✓ 礼物栏恢复原布局，兼容旧版多份待确认请求和收礼数量');
  await api.resetMock();
  await api.setMe('userA');
  await api.updateDiamondAllowance(100);
  assert.strictEqual((await api.getGiftState()).balance, 10);
  await api.submitScore({ score: 8 });
  await api.requestExchange();
  await api.setMe('userB');
  assert.strictEqual((await api.getAppStatus()).pair.diamondAllowance, 100);
  await api.submitScore({ score: 8 });
  advanceTo((await api.agreeExchange()).nextOpenAt);
  assert.strictEqual((await api.getGiftState()).balance, 100);
  await api.updateDiamondAllowance(0);
  assert.strictEqual((await api.getGiftState()).balance, 100);
  await api.submitScore({ score: 8 });
  await api.requestExchange();
  await api.setMe('userA');
  await api.submitScore({ score: 8 });
  advanceTo((await api.agreeExchange()).nextOpenAt);
  assert.strictEqual((await api.getGiftState()).balance, 0);
  await api.setMe('userB');
  assert.strictEqual((await api.getGiftState()).balance, 0);
  await assert.rejects(() => api.updateDiamondAllowance(1.5));
  console.log('✓ 演示模式共享额度，100和0均在下一期生效且双方一致');
  const slow = component();
  slow.data.state = { available: true, inbox: [{ id: 'slow', type: 'flower' }] };
  slow.data.effect = { ids: ['slow'] };
  slow.refreshGifts = async () => {};
  let finishRead;
  let ackCalls = 0;
  api.acknowledgeGift = () => { ackCalls++; return new Promise((resolve) => { finishRead = resolve; }); };
  const receiving = slow.receiveGift();
  await slow.receiveGift();
  assert.strictEqual(slow.data.receiving, true);
  assert.strictEqual(ackCalls, 1, '慢请求期间连点关闭/收下不能重复提交');
  const markup = fs.readFileSync(path.join(root, 'components/gift-hub/gift-hub.wxml'), 'utf8');
  const closeTag = markup.match(/<[^>]+class="gift-close"[^>]*>/)[0];
  assert.ok(!closeTag.startsWith('<button'), '关闭控件不应进入会变成白色长条的原生button禁用态');
  const receiveTag = markup.match(/<[^>]+class="gift-receive"[^>]*>/)[0];
  assert.ok(!/\s(disabled|loading)=/.test(receiveTag), '收下等待状态不切换原生禁用外观或转圈');
  finishRead({ acknowledged: true });
  await receiving;
  assert.strictEqual(slow.data.effect, null);
  assert.strictEqual(slow.data.receiving, false);
  api.acknowledgeGift = originalAck;
  console.log('✓ 慢请求期间关闭控件外观不切换原生禁用态、收下无转圈、连点只提交一次');
})().catch((error) => { console.error(error); process.exitCode = 1; });
