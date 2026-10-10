/**
 * 微信云开发后端适配层。
 * 与 mock.js 接口完全一致；服务端逻辑见 cloudfunctions/ 下的云函数。
 * 使用前：project.config.json 填好 appid -> 开通云开发 -> 把环境 ID 填到 config/index.js -> 部署云函数。
 */
const config = require('../config/index.js');

let inited = false;
let initPromise = null;

function isEnvConfigured() {
  return !!config.cloudEnvId;
}

function doInit() {
  if (!wx.cloud) {
    return Promise.reject(new Error('基础库过低，请升级微信开发者工具'));
  }
  if (!config.cloudEnvId) {
    return Promise.reject(new Error('CLOUD_ENV_NOT_SET'));
  }
  wx.cloud.init({ env: config.cloudEnvId, traceUser: true });
  // 业务云函数通过 getWXContext 获取身份，无需前置 login 网络请求。
  inited = true;
  return Promise.resolve();
}

function ensureInit() {
  if (inited) return Promise.resolve();
  if (!initPromise) {
    initPromise = doInit().then(
      (r) => r,
      (e) => {
        initPromise = null; // 允许失败后重试（setup 页的「重试」按钮）
        throw e;
      }
    );
  }
  return initPromise;
}

function call(name, action, payload) {
  return ensureInit()
    .then(() => wx.cloud.callFunction({ name: name, data: { action: action, payload: payload || {} } }))
    .then((res) => {
      const r = res.result;
      if (r && r.ok) return r.data;
      const error = new Error((r && r.error) || ('云函数 ' + name + '.' + action + ' 调用失败'));
      error.diagnostic = r && r.diagnostic;
      error.requestId = res.requestID || res.requestId || '';
      throw error;
    });
}

module.exports = {
  isMock: false,
  getGiftState: function () { return call('cycle', 'getGiftState'); },
  sendGift: function (payload) { return call('cycle', 'sendGift', payload); },
  acknowledgeGift: function (id) { return call('cycle', 'acknowledgeGift', Array.isArray(id) ? { ids: id } : { id: id }); },
  isEnvConfigured: isEnvConfigured,

  init: function () {
    return ensureInit();
  },

  getAppStatus: function () {
    return call('cycle', 'getCurrent');
  },
  getExchangePage: function (cycleId) {
    return call('cycle', 'getExchangePage', { cycleId: cycleId });
  },
  submitScore: function (p) {
    return call('cycle', 'submitScore', p);
  },
  requestExchange: function () {
    return call('cycle', 'requestExchange');
  },
  cancelExchangeRequest: function () {
    return call('cycle', 'cancelExchangeRequest');
  },
  agreeExchange: function () {
    return call('cycle', 'agreeExchange');
  },
  getCycleDetail: function (cycleId) {
    return call('cycle', 'getDetail', { cycleId: cycleId });
  },

  addNote: function (p) {
    return call('note', 'add', p);
  },
  deleteNote: function (id) {
    return call('note', 'remove', { id: id });
  },
  getMyNotes: function () {
    return call('note', 'listMine');
  },
  annotate: function (p) {
    return call('note', 'annotate', p);
  },
  deleteAnnotation: function (p) {
    return call('note', 'removeAnnotation', p);
  },
  getUnreadReplies: function () {
    return call('note', 'unreadReplies');
  },
  markRepliesRead: function (upTo) {
    return call('note', 'markRepliesRead', { upTo: upTo });
  },

  addEvent: function (p) {
    return call('track', 'addEvent', p);
  },
  deleteEvent: function (id) {
    return call('track', 'remove', { id: id });
  },
  getHistory: function (payload) {
    return call('track', 'history', payload);
  },
  getCycleEvents: function (payload) { return call('track', 'cycleEvents', payload); },

  updateCycleDays: function (days) {
    return call('pair', 'updateCycleDays', { days: days });
  },
  updateDiamondAllowance: function (amount) { return call('pair', 'updateDiamondAllowance', { amount: amount }); },
  pairCreate: function (days) {
    return call('pair', 'create', { days: days });
  },
  pairJoin: function (code) {
    return call('pair', 'join', { code: code });
  },
  pairPreview: function (code) {
    return call('pair', 'preview', { code: code });
  },
  pairGet: function () {
    return call('pair', 'get');
  },
  unbind: function () {
    return call('pair', 'unbind');
  },
  setNickname: function (nickname) {
    return call('pair', 'setNickname', { nickname: nickname });
  },
};
