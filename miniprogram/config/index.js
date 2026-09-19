/**
 * 全局配置
 * 默认使用微信云开发（真实双人、两台手机）：
 *   1. 开发者工具「云开发」开通并创建环境
 *   2. 把环境 ID 填到 cloudEnvId
 *   3. 上传部署 cloudfunctions/ 下的 5 个云函数（见 README）
 * useMock 仅供本地调试 UI 使用（同一台手机模拟双账号），默认关闭。
 *
 * subscribeTemplateId：订阅消息模板 ID。
 * 到 mp 后台「功能 → 订阅消息 → 公共模板库」选一个字段为「事项 / 时间 / 备注」的提醒类模板，
 * 把模板 ID 填到这里，并同步填到 cloudfunctions/cycle/index.js 和 reminder/index.js 的 TEMPLATE_ID。
 * 留空 = 不请求授权也不发提醒，不影响其他功能。
 */
module.exports = {
  useMock: false,
  cloudEnvId: 'cloud1-d0gkdulwdeda935c9',
  subscribeTemplateId: 'yR-5gQYj_SzXZv_0bLu_ohFcOOyaX3lYrz9fNrvkZuM',
};
