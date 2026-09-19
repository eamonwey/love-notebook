const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const COLLECTIONS = ['users', 'pairs', 'cycles', 'notes', 'events'];

// 首次调用时自动建集合，省去控制台手动创建
async function ensureCollections() {
  for (let i = 0; i < COLLECTIONS.length; i++) {
    try {
      await db.createCollection(COLLECTIONS[i]);
    } catch (e) {
      // 集合已存在等情况直接忽略
    }
  }
}

exports.main = async () => {
  try {
    const { OPENID } = cloud.getWXContext();
    await ensureCollections();
    return { ok: true, data: { openid: OPENID } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};
