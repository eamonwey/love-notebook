/**
 * 按键防重锁：异步点击逻辑（保存/提交/跳转）加锁，防止快速连点导致重复提交。
 *
 * - 执行中（含网络往返）：同一 key 的再次点击直接忽略
 * - 执行完成后的冷却期内（默认 800ms）：再次点击忽略，防手抖连点
 *
 * 用法：把原 handler 逻辑包进 tap.run('key', () => { ...原逻辑... }, cooldownMs)
 * 注意：run 是同步调用传入函数的（函数体内的同步段仍在点击上下文里执行），
 *       点击逻辑的同步部分不会延迟到后续微任务。
 */
const running = {};
const lastDone = {};

function run(key, fn, cooldownMs) {
  if (running[key]) return false;
  const now = Date.now();
  if (now - (lastDone[key] || 0) < (cooldownMs || 800)) return false;
  running[key] = true;
  const settle = () => {
    running[key] = false;
    lastDone[key] = Date.now();
  };
  let p;
  try {
    p = fn();
  } catch (e) {
    settle();
    throw e;
  }
  Promise.resolve(p).then(settle, settle);
  return true;
}

module.exports = { run };
