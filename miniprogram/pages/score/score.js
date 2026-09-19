const api = require('../../services/api.js');
const { scoreEmoji } = require('../../utils/date.js');
const { ensureSubscribe } = require('../../utils/notify.js');
const tap = require('../../utils/tap.js');

Page({
  data: {
    cycleIndex: '',
    score: 5,
    emoji: '😐',
    comment: '',
    showEvent: false,
    prevScore: null,
    eventReason: '',
  },

  onLoad() {
    this.refresh();
  },

  async refresh() {
    try {
      const s = await api.getAppStatus();
      const cur = s.myScore ? s.myScore.score : 5;
      this.setData({
        cycleIndex: s.cycle.index,
        score: cur,
        emoji: scoreEmoji(cur),
        comment: s.myScore ? s.myScore.comment : '',
      });
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '加载失败', icon: 'none' });
    }
  },

  onSlidingPreview(e) {
    this.setData({ score: e.detail.value, emoji: scoreEmoji(e.detail.value) });
  },

  onSlideCommit(e) {
    this.setData({ score: e.detail.value, emoji: scoreEmoji(e.detail.value) });
  },

  onComment(e) {
    this.setData({ comment: e.detail.value });
  },

  onSave() {
    tap.run('score-save', async () => {
      // 顺势请求订阅消息授权（用户点一次「允许」，之后可收到一条交换/提醒通知）
      ensureSubscribe();
      try {
        const res = await api.submitScore({ score: this.data.score, comment: this.data.comment });
        wx.showToast({ title: res.autoExchanged ? '已保存，本期已自动交换' : '已保存', icon: 'none' });
        if (res.changed) {
          // 分数与上期相比发生了变化：引导记录原因（功能4）
          this.setData({ showEvent: true, prevScore: res.prevScore, cycleId: res.cycleId });
        } else {
          setTimeout(() => wx.navigateBack(), 600);
        }
      } catch (e) {
        wx.showToast({ title: (e && e.message) || '保存失败', icon: 'none' });
      }
    });
  },

  onEventReason(e) {
    this.setData({ eventReason: e.detail.value });
  },

  onSaveEvent() {
    tap.run('score-event', async () => {
      try {
        await api.addEvent({
          cycleId: this.data.cycleId,
          prevScore: this.data.prevScore,
          newScore: this.data.score,
          reason: this.data.eventReason,
        });
        wx.showToast({ title: '已记录', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 600);
      } catch (e) {
        wx.showToast({ title: (e && e.message) || '记录失败', icon: 'none' });
      }
    });
  },

  onSkipEvent() {
    wx.navigateBack();
  },
});
