/**
 * reminder 云函数：定时触发器每小时整点扫描一次，
 * 把「约定交换时间」已到点但还没提醒过的周期，给双方各发一条订阅消息。
 * 使用前：在 mp 后台申请订阅消息模板，把模板 ID 填到 TEMPLATE_ID；
 * 体验版测试时把 NOTIFY_STATE 改为 'trial'。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const DAY = 24 * 60 * 60 * 1000;

const TEMPLATE_ID = 'yR-5gQYj_SzXZv_0bLu_ohFcOOyaX3lYrz9fNrvkZuM';
const NOTIFY_STATE = 'formal';
const FIELDS = { thing: 'thing1', time: 'time2', note: 'thing3' };

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':00';
}

function cut(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

async function sendSubscribe(touser, thing, timeText, note) {
  if (!TEMPLATE_ID) return;
  try {
    await cloud.openapi.subscribeMessage.send({
      touser: touser,
      templateId: TEMPLATE_ID,
      page: 'pages/exchange/exchange',
      miniprogramState: NOTIFY_STATE,
      data: {
        [FIELDS.thing]: { value: cut(thing, 20) },
        [FIELDS.time]: { value: timeText },
        [FIELDS.note]: { value: cut(note, 20) },
      },
    });
  } catch (e) {
    // 用户未订阅等情况：静默忽略
  }
}

exports.main = async () => {
  const now = Date.now();
  let checked = 0;
  let autoExchanged = 0;
  let planNotified = 0;
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
        const c = res.data[i];
        checked++;
        try {
          const pairRes = await db.collection('pairs').doc(c.pairId).get();
          const pair = pairRes.data;
          const users = (pair && pair.users) || [];
          // 只处理有效双人配对：解绑归档的配对、未绑定的邀请直接跳过
          if (!pair || pair.status === 'archived' || users.length !== 2) continue;
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
            try {
              await db.collection('cycles').add({
                data: Object.assign(
                  { _id: 'cyc_' + c.pairId + '_' + index },
                  {
                    pairId: c.pairId,
                    index: index,
                    startDate: now,
                    endDate: now + days * DAY,
                    status: 'active',
                    scores: {},
                    exchangedAt: null,
                    createdAt: now,
                  }
                ),
              });
            } catch (e) { /* 并发已创建 */ }
            for (let j = 0; j < users.length; j++) {
              await sendSubscribe(users[j], '已自动交换', fmtTime(now), '本期已自动交换，快去看看TA的感受吧');
            }
            autoExchanged++;
            continue;
          }

          // 约定交换时间到点：提醒双方（只提醒，不代替交换）
          const plan = c.exchangePlan;
          if (plan && !plan.notified && plan.time && plan.time <= now) {
            for (let j = 0; j < users.length; j++) {
              await sendSubscribe(users[j], '交换时间到啦', fmtTime(plan.time), '约定的交换时间到了，快去打分交换吧');
            }
            try {
              await db.collection('cycles').doc(c._id).update({ data: { 'exchangePlan.notified': true } });
            } catch (e) { /* ignore */ }
            planNotified++;
          }
        } catch (e) {
          failed++;
          console.error('[reminder] 处理周期失败:', c && c._id, e && (e.errCode || e.errMsg || e.message));
        }
        cursor = c._id;
      }
      if (res.data.length < 100) break;
    }
    return {
      ok: true,
      data: { checked: checked, autoExchanged: autoExchanged, planNotified: planNotified, failed: failed },
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};
