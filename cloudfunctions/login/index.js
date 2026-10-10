const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async () => {
  try {
    const { OPENID } = cloud.getWXContext();
    // 集合由部署人员一次性初始化；登录不再执行数据库管理操作。
    return { ok: true, data: { openid: OPENID } };
  } catch (e) {
    console.error('[login] request failed:', e);
    return { ok: false, error: '服务暂时不可用，请稍后重试' };
  }
};
