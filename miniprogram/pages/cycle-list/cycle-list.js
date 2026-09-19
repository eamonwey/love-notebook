const api = require('../../services/api.js');
const { fmtDate } = require('../../utils/date.js');

Page({
  data: {
    rows: [],
  },

  onShow() {
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  async refresh() {
    try {
      const h = await api.getHistory();
      const rows = h.rows
        .slice()
        .reverse()
        .map((r) => {
          // 提前交换的周期，截止日期显示实际交换日
          const early = !!(r.exchangedAt && r.exchangedAt < r.endDate);
          const endTs = early ? r.exchangedAt : r.endDate;
          return {
            cycleId: r.cycleId,
            index: r.index,
            dateText: fmtDate(r.startDate) + ' — ' + fmtDate(endTs) + (early ? '（提前交换）' : ''),
            myScore: r.myScore,
            partnerScore: r.partnerScore,
          };
        });
      this.setData({ rows: rows });
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '加载失败', icon: 'none' });
    }
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/exchange/exchange?cycleId=' + e.currentTarget.dataset.id });
  },
});
