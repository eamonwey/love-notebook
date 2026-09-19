const config = require('../../config/index.js');
const api = require('../../services/api.js');

Page({
  data: {
    error: '',
  },

  onLoad(options) {
    this.setData({ error: decodeURIComponent((options && options.error) || '') });
  },

  async retry() {
    try {
      if (!config.useMock) {
        await api.init();
      }
      wx.reLaunch({ url: '/pages/index/index' });
    } catch (e) {
      this.setData({ error: e.message });
    }
  },
});
