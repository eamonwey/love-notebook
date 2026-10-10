const crypto = require('crypto');
const PRICES = { flower: 1, letter: 5, car: 10 };
const allowance = (cycle) => Number.isInteger(cycle.diamondAllowance) ? cycle.diamondAllowance : 10;
const balance = (cycle, me) => allowance(cycle) - (cycle.giftLedger || []).filter((g) => g.from === me).reduce((n, g) => n + g.cost, 0);

module.exports = function ({ db, getUser, getPair, ensureCurrentCycle, maybeAutoExchange }) {
  async function step(stage, work) {
    try { return await work(); }
    catch (error) {
      const e = error instanceof Error ? error : Object.assign(new Error('礼物服务异常'), error);
      e.giftStage = e.giftStage || stage;
      throw e;
    }
  }
  async function context(openid) {
    const result = await step('gift.user', () => db.collection('users').where({ openid }).limit(1).get());
    const user = result.data[0];
    if (!user || !user.pairId) return null;
    const pair = await step('gift.pair', () => getPair(user.pairId));
    if (!pair || pair.status === 'archived' || pair.users.length !== 2 || !pair.users.includes(openid)) return null;
    let cycle = await step('gift.cycle', () => ensureCurrentCycle(pair));
    if (await step('gift.advance', () => maybeAutoExchange(pair, cycle, Date.now()))) {
      cycle = await step('gift.nextCycle', () => ensureCurrentCycle(pair));
    }
    return { user, pair, cycle };
  }
  return {
    async getGiftState(payload, openid) {
      const c = await context(openid);
      if (!c) return { available: false, inbox: [] };
      const result = await step('gift.inbox', () => db.collection('gifts').where({ pairId: c.pair._id, to: openid, seen: false })
        .orderBy('createdAt', 'asc').limit(20).get());
      return {
        available: true, walletKey: crypto.createHash('sha256').update(JSON.stringify([c.pair._id, openid])).digest('hex'),
        cycleId: c.cycle._id, cycleIndex: c.cycle.index, balance: balance(c.cycle, openid),
        allowance: allowance(c.cycle), nextAllowance: allowance(c.pair),
        inbox: result.data.map((g) => ({ id: g._id, type: g.type, quantity: g.quantity || 1, senderName: g.senderName, cycleIndex: g.cycleIndex,
          senderKey: crypto.createHash('sha256').update(JSON.stringify([g.pairId, g.from])).digest('hex') })),
      };
    },
    async sendGift(payload, openid) {
      const unitCost = typeof payload.type === 'string' && Object.prototype.hasOwnProperty.call(PRICES, payload.type) ? PRICES[payload.type] : 0;
      if (!unitCost) throw new Error('请选择有效的礼物');
      const quantity = payload.quantity === undefined ? 1 : payload.quantity;
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) throw new Error('礼物数量必须为1至10的整数');
      const cost = unitCost * quantity;
      if (typeof payload.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(payload.requestId)) throw new Error('送礼请求无效，请重新打开礼物栏');
      if (typeof payload.cycleId !== 'string' || !payload.cycleId) throw new Error('请先刷新本期余额');
      const c = await context(openid);
      if (!c) throw new Error('请先和TA完成配对');
      const id = 'gift_' + crypto.createHash('sha256').update(JSON.stringify([c.pair._id, payload.cycleId, openid, payload.requestId])).digest('hex');
      const result = await db.runTransaction(async (tx) => {
        const user = (await tx.collection('users').doc(c.user._id).get()).data;
        const pair = (await tx.collection('pairs').doc(c.pair._id).get()).data;
        const cycle = (await tx.collection('cycles').doc(payload.cycleId).get()).data;
        if (user.pairId !== pair._id || pair.status === 'archived' || pair.users.length !== 2 || !pair.users.includes(openid)) throw new Error('配对状态已变化，请刷新后重试');
        if (cycle.pairId !== pair._id) throw new Error('周期不属于当前配对');
        const ledger = cycle.giftLedger || [];
        const existing = ledger.find((g) => g.id === id);
        if (existing) {
          if (existing.type !== payload.type || (existing.quantity || 1) !== quantity) throw new Error('请勿重复使用送礼请求');
          return { id, balance: balance(cycle, openid) };
        }
        if ((cycle.status !== 'active' && !(cycle.status === 'exchanged' && cycle.nextOpenAt > Date.now())) || cycle._id !== c.cycle._id) throw new Error('已进入新周期，请刷新余额后再送礼');
        if (balance(cycle, openid) < cost) throw new Error('本期钻石不足，请等待下一期');
        const gift = { id, from: openid, type: payload.type, quantity, cost };
        const remaining = balance(cycle, openid) - cost;
        await tx.collection('cycles').doc(cycle._id).update({ data: { giftLedger: ledger.concat([gift]) } });
        await tx.collection('gifts').doc(id).set({ data: {
          pairId: pair._id, cycleId: cycle._id, cycleIndex: cycle.index,
          from: openid, to: pair.users.find((u) => u !== openid), senderName: c.user.nickname || 'TA',
          type: payload.type, quantity, cost, seen: false, createdAt: Date.now(),
        } });
        return { id, balance: remaining };
      });
      return result && result.result ? result.result : result;
    },
    async acknowledgeGift(payload, openid) {
      const ids = payload.ids === undefined ? [payload.id] : payload.ids;
      if (!Array.isArray(ids) || !ids.length || ids.length > 20 || ids.some((id) => typeof id !== 'string' || !/^gift_[a-f0-9]{64}$/.test(id))) throw new Error('礼物编号无效');
      const user = await getUser(openid);
      await db.collection('gifts').where({ _id: db.command.in([...new Set(ids)]), pairId: user.pairId, to: openid, seen: false })
        .update({ data: { seen: true, seenAt: Date.now() } });
      return { acknowledged: true };
    },
  };
};
