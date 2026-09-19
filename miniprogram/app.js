const api = require('./services/api.js');

App({
  globalData: {
    mode: 'mock',
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上基础库以使用云能力');
    }
    api
      .init()
      .then(() => {
        this.globalData.mode = api.isMock ? 'mock' : 'cloud';
      })
      .catch((e) => {
        // 启动失败由首页/配置引导页给出可视化提示，这里只记录日志
        console.error('初始化失败', e);
      });
  },
});
