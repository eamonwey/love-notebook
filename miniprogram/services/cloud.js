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
  return wx.cloud
    .callFunction({ name: 'login', data: { action: 'me', payload: {} } })
    .then((res) => {
      if (!res.result || !res.result.ok) {
        throw new Error((res.result && res.result.error) || '登录失败');
      }
      inited = true;
      return res.result.data;
    });
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
      throw new Error((r && r.error) || ('云函数 ' + name + '.' + action + ' 调用失败'));
    });
}

module.exports = {
  isMock: false,
  isEnvConfigured: isEnvConfigured,

  init: function () {
    return ensureInit();
  },

  getAppStatus: function () {
    return call('cycle', 'getCurrent');
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
  setExchangePlan: function (p) {
    return call('cycle', 'setExchangePlan', p);
  },
  clearExchangePlan: function () {
    return call('cycle', 'clearExchangePlan');
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

  addEvent: function (p) {
    return call('track', 'addEvent', p);
  },
  deleteEvent: function (id) {
    return call('track', 'remove', { id: id });
  },
  getHistory: function () {
    return call('track', 'history');
  },

  updateCycleDays: function (days) {
    return call('pair', 'updateCycleDays', { days: days });
  },
  pairCreate: function () {
    return call('pair', 'create');
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
