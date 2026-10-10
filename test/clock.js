// 只供离线测试显式跨过业务时间边界，不等待真实的一天。
exports.advanceTo = (timestamp) => {
  if (!Number.isFinite(timestamp)) throw new Error('测试时间戳无效');
  Date.now = () => timestamp;
};
