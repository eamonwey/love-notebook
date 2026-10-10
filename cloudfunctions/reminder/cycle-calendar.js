// 各云函数独立部署，副本需与 miniprogram/utils/cycle-calendar.js 保持一致。
const DAY = 86400000;
const OFFSET = 8 * 3600000;

function cycleEnd(start, days) {
  return (Math.floor((start + OFFSET) / DAY) + days) * DAY - OFFSET;
}

// 旧周期按整段24小时创建；从自身起止时间还原原定天数，避免套用下一期设置。
function legacyEnd(cycle) {
  if (!cycle || cycle.status !== 'active' || !Number.isFinite(cycle.startDate) || !Number.isFinite(cycle.endDate)) return cycle && cycle.endDate;
  const days = (cycle.endDate - cycle.startDate) / DAY;
  if (!Number.isInteger(days) || days < 1 || days > 90) return cycle.endDate;
  return cycleEnd(cycle.startDate, days);
}

async function normalizeActive(db, cycle) {
  const endDate = legacyEnd(cycle);
  if (!cycle || endDate === cycle.endDate) return cycle;
  const result = await db.collection('cycles').where({
    _id: cycle._id, status: 'active', endDate: cycle.endDate,
  }).update({ data: { endDate } });
  if (result.stats && result.stats.updated) return Object.assign({}, cycle, { endDate });
  return (await db.collection('cycles').doc(cycle._id).get()).data;
}

module.exports = { cycleEnd, legacyEnd, normalizeActive };
