const assert = require('assert');
const calls = [];
let initCount = 0;
global.wx = { cloud: {
  init() { initCount++; },
  async callFunction(request) {
    calls.push(request);
    return { result: { ok: true, data: { timings: { totalMs: 1 } } } };
  },
} };
const api = require('../miniprogram/services/cloud');
(async () => {
  await Promise.all([api.init(), api.getAppStatus()]);
  assert.strictEqual(initCount, 1);
  assert.deepStrictEqual(calls.map((r) => r.name + '.' + r.data.action), ['cycle.getCurrent']);
  calls.length = 0;
  await api.getExchangePage('history-id');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].data.action, 'getExchangePage');
  assert.strictEqual(calls[0].data.payload.cycleId, 'history-id');
  console.log('启动适配层：首屏 1 次云调用，无 login；交换详情 1 次云调用 ✓');
  wx.cloud.callFunction = async () => ({ requestID: 'test-request', result: {
    ok: false, error: '服务暂时不可用，请稍后重试', diagnostic: { version: 'gift-diag-1', stage: 'gift.inbox', code: '-502005' },
  } });
  await assert.rejects(api.getGiftState(), (e) => e.diagnostic.stage === 'gift.inbox' && e.requestId === 'test-request');
  console.log('礼物错误诊断与请求编号传递到前端 ✓');
})().catch((e) => { console.error(e); process.exitCode = 1; });
