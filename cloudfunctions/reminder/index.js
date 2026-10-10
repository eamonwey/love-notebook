/** 定时处理到期周期的自动交换；保留原函数/触发器名称以兼容部署。 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const { cycleEnd, normalizeActive } = require('./cycle-calendar');

exports.main = async () => {
  const now = Date.now();
  let checked = 0;
  let autoExchanged = 0;
  let failed = 0;
  try {
    // 游标分页（按 _id 升序）：处理全部活动周期，而不是只处理前 100 条
    let cursor = null;
    for (;;) {
      const whereCond = cursor
        ? { status: 'active', _id: _.gt(cursor) }
        : { status: 'active' };
      const res = await db.collection('cycles').where(whereCond).orderBy('_id', 'asc').limit(100).get();
      if (!res.data.length) break;

      for (let i = 0; i < res.data.length; i++) {
        let c = res.data[i];
        checked++;
        // 关键：游标必须在任何 continue 之前推进。原先写在 try 之后，
        // 若一页 100 条全被 continue 跳过，_id: _.gt(cursor) 条件不变，
        // 会在同一页上无限重复查询直到云函数超时。
        cursor = c._id;
        try {
          const pairRes = await db.collection('pairs').doc(c.pairId).get();
          const pair = pairRes.data;
          const users = (pair && pair.users) || [];
          // 只处理有效双人配对：解绑归档的配对、未绑定的邀请直接跳过
          if (!pair || pair.status === 'archived' || users.length !== 2) continue;
          c = await normalizeActive(db, c);
          if (!c || c.status !== 'active') continue;
          const allDone = users.every((oid) => c.scores && c.scores[oid]);

          // 周期到期且双方已打分：自动交换（兜底补上打分后未再打开小程序的情况）
          if (c.endDate && c.endDate <= now && allDone) {
            const upd = await db
              .collection('cycles')
              .where({ _id: c._id, status: 'active' })
              .update({ data: { status: 'exchanged', exchangedAt: now, exchangeRequest: _.remove() } });
            if (!upd.stats || upd.stats.updated === 0) continue;
            const index = c.index + 1;
            const days = (pair && pair.cycleDays) || 7;
            const latestScoredAt = Math.max.apply(null, users.map((oid) => Number(c.scores[oid].scoredAt || 0)));
            const nextStart = latestScoredAt > c.endDate ? latestScoredAt : c.endDate;
            await require('./cycle-store')(db, pair, {
              pairId: c.pairId,
              index: index,
              startDate: nextStart || now,
              endDate: cycleEnd(nextStart || now, days),
              diamondAllowance: Number.isInteger(pair.diamondAllowance) ? pair.diamondAllowance : 10,
              status: 'active',
              scores: {},
              exchangedAt: null,
              createdAt: now,
            });
            autoExchanged++;
            continue;
          }

        } catch (e) {
          failed++;
          console.error('[reminder] 处理周期失败:', c && c._id, e && (e.errCode || e.errMsg || e.message));
        }
      }
      if (res.data.length < 100) break;
    }
    return {
      ok: true,
      data: { checked: checked, autoExchanged: autoExchanged, failed: failed },
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};
