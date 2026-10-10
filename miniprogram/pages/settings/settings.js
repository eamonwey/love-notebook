const api = require('../../services/api.js');
const tap = require('../../utils/tap.js');

Page({
  data: {
    isMock: true,
    me: '',
    myName: '',
    nickname: '',
    savingNickname: false,
    cycleDays: 7,
    customDays: '',
    pairedNames: '',
    diamondAllowance: 10,
    customDiamonds: '',
    savingDiamonds: false,
    canSetDiamonds: false,
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
      const s = api.isMock ? await api.getAppStatus() : await api.pairGet();
      this.setData({
        me: s.me,
        myName: s.users[s.me] ? s.users[s.me].name : '我',
        cycleDays: s.pair ? s.pair.cycleDays : 7,
        diamondAllowance: s.pair && Number.isInteger(s.pair.diamondAllowance) ? s.pair.diamondAllowance : 10,
        canSetDiamonds: !!(s.pair && (api.isMock || (s.pair.status !== 'archived' && s.pair.users && s.pair.users.length === 2))),
        pairedNames: s.pair ? Object.keys(s.users).map((k) => s.users[k].name).join(' & ') : '',
      });
    } catch (e) {
      /* 未配对/未配置等情况，由对应引导展示 */
    }
  },

  onNickname(e) {
    this.setData({ nickname: e.detail.value });
  },

  onCustomDiamonds(e) {
    this.setData({ customDiamonds: e.detail.value });
  },

  async saveDiamonds() {
    if (this.data.savingDiamonds || !this.data.canSetDiamonds) return;
    const raw = this.data.customDiamonds.trim();
    if (!/^\d{1,3}$/.test(raw) || Number(raw) > 100) {
      wx.showToast({ title: '请输入0–100的整数', icon: 'none' });
      return;
    }
    this.setData({ savingDiamonds: true });
    try {
      const r = await api.updateDiamondAllowance(Number(raw));
      this.setData({ diamondAllowance: r.diamondAllowance, customDiamonds: '' });
      wx.showToast({ title: '双方额度已更新，下期生效', icon: 'none' });
      await this.refresh();
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败，请重试', icon: 'none' });
    } finally {
      this.setData({ savingDiamonds: false });
    }
  },

  async saveNickname() {
    if (this.data.savingNickname) return;
    const nickname = this.data.nickname.trim();
    if (!nickname || nickname.length > 20) {
      wx.showToast({ title: '请输入1–20字的昵称', icon: 'none' });
      return;
    }
    this.setData({ savingNickname: true });
    try {
      await api.setNickname(nickname);
      this.setData({ myName: nickname, nickname: '' });
      wx.showToast({ title: '昵称已更新', icon: 'success' });
      await this.refresh();
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败，请重试', icon: 'none' });
    } finally {
      this.setData({ savingNickname: false });
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
          content: '解绑后记录封存，本期中断、不再交换。重新邀请同一伴侣可恢复共同历史并开启新一期，追踪图保留暂停断点；绑定其他人则建立全新记录。',
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
