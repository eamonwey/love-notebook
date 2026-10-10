/**
 * 全局配置
 * 默认使用微信云开发（真实双人、两台手机）：
 *   1. 开发者工具「云开发」开通并创建环境
 *   2. 把环境 ID 填到 cloudEnvId
 *   3. 上传部署 cloudfunctions/ 下的 6 个云函数（login/pair/cycle/note/track/reminder，见 README）
 * useMock 仅供本地调试 UI 使用（同一台手机模拟双账号），默认关闭。
 */
module.exports = {
  useMock: false,
  cloudEnvId: 'cloud1-d0gkdulwdeda935c9',
};
