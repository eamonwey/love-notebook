const api = require('../../services/api.js');
const tap = require('../../utils/tap.js');

Page({
  data: {
    isMock: true,
    me: '',
    myName: '',
    cycleDays: 7,
    customDays: '',
    pairedNames: '',
  },

  onShow() {
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  async refresh() {
    this.setData({ isMock: api.isMock });
    try {
      const s = await api.getAppStatus();
      this.setData({ me: s.me, myName: s.users[s.me].name, cycleDays: s.pair.cycleDays });
    } catch (e) {
      /* 未配对/未配置等情况，由对应引导展示 */
    }
    if (!api.isMock) {
      try {
        const p = await api.pairGet();
        const names = p.pair
          ? Object.keys(p.users || {})
              .map((k) => p.users[k].name)
              .join(' & ')
          : '';
        this.setData({ pairedNames: names });
      } catch (e) {
        /* ignore */
      }
    }
  },

  async setMe(e) {
    try {
      await api.setMe(e.currentTarget.dataset.id);
      wx.showToast({ title: '已切换', icon: 'success' });
      this.refresh();
    } catch (err) {
      wx.showToast({ title: err.message, icon: 'none' });
    }
  },

  async pickDays(e) {
    await this.saveDays(e.currentTarget.dataset.days);
  },

  onCustomDays(e) {
    this.setData({ customDays: e.detail.value });
  },

  async saveCustomDays() {
    await this.saveDays(this.data.customDays);
  },

  saveDays(days) {
    tap.run('set-days', async () => {
      try {
        const r = await api.updateCycleDays(days);
        wx.showToast({ title: '已改为每' + r.cycleDays + '天，下一期生效', icon: 'none' });
        this.setData({ customDays: '' });
        this.refresh();
      } catch (e) {
        wx.showToast({ title: e.message, icon: 'none' });
      }
    });
  },

  resetData() {
    tap.run('set-reset', async () => {
      const confirmed = await new Promise((resolve) => {
        wx.showModal({
          title: '重置演示数据',
          content: '将清空本地模拟的全部打分、笔记与周期，重新开始。',
          success: (r) => resolve(!!r.confirm),
          fail: () => resolve(false),
        });
      });
      if (!confirmed) return;
      try {
        await api.resetMock();
        wx.showToast({ title: '已重置', icon: 'success' });
        this.refresh();
      } catch (e) {
        wx.showToast({ title: e.message, icon: 'none' });
      }
    }, 300);
  },

  goPair() {
    tap.run('nav-pair', () => wx.navigateTo({ url: '/pages/pair/pair' }), 600);
  },

  onUnbind() {
    tap.run('set-unbind', async () => {
      const confirmed = await new Promise((resolve) => {
        wx.showModal({
          title: '和TA解绑？',
          content: '解绑不需要对方同意。解绑后这本笔记本将封存（历史不再展示），双方都可以重新邀请绑定新的伴侣，从第 1 期重新开始。',
          confirmText: '解绑',
          confirmColor: '#D9534F',
          success: (r) => resolve(!!r.confirm),
          fail: () => resolve(false),
        });
      });
      if (!confirmed) return;
      try {
        await api.unbind();
        wx.showToast({ title: '已解绑', icon: 'success' });
        this.refresh();
      } catch (e) {
        wx.showToast({ title: e.message, icon: 'none' });
      }
    }, 300);
  },
});
