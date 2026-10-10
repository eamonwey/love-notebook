// 周期创建与配对状态变更共用事务冲突点；副本保持一致以便独立部署。
module.exports = async function createCycleDocument(db, pair, data) {
  const id = 'cyc_' + pair._id + '_' + data.index;
  const result = await db.runTransaction(async (tx) => {
    const fresh = (await tx.collection('pairs').doc(pair._id).get()).data;
    if (!fresh || fresh.status === 'archived' || fresh.users.length !== 2 ||
        (fresh.pausedAt || 0) !== (pair.pausedAt || 0) ||
        (fresh.resumedAt || 0) !== (pair.resumedAt || 0)) throw new Error('配对状态已变化，请刷新后重试');
    let existing;
    try { existing = (await tx.collection('cycles').doc(id).get()).data; }
    catch (e) { if (!/not exist|not found/i.test(e.message || e.errMsg || '')) throw e; }
    if (existing) return false;
    await tx.collection('pairs').doc(pair._id).update({ data: { cycleRevision: (fresh.cycleRevision || 0) + 1 } });
    await tx.collection('cycles').doc(id).set({ data });
    return true;
  });
  return result && Object.prototype.hasOwnProperty.call(result, 'result') ? result.result : result;
};
