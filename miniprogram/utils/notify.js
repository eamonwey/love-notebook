/**
 * 订阅消息授权助手。
 * 订阅消息是一次性的：用户点一次「允许」，才能收到一条提醒。
 * 必须在用户点击事件的同步上下文里调用（不要放在 await 之后）。
 */
const config = require('../config/index.js');

function ensureSubscribe() {
  const id = config.subscribeTemplateId;
  if (!id || !wx.requestSubscribeMessage) return;
  wx.requestSubscribeMessage({
    tmplIds: [id],
    complete: function () {
      /* 用户同意或拒绝都继续主流程 */
    },
  });
}

module.exports = { ensureSubscribe };
