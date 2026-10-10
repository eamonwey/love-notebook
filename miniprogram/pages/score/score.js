const api = require('../../services/api.js');
const { scoreEmoji } = require('../../utils/date.js');
const tap = require('../../utils/tap.js');
const exchangeShare = require('../../utils/exchange-share.js');

Page({
  data: {
    cycleIndex: '',
    score: 5,
    emoji: '😐',
    comment: '',
    showEvent: false,
    prevScore: null,
    eventReason: '',
    saved: false,
    autoExchanged: false,
    editingCycleId: '',
    checkingEdit: false,
  },

  onLoad() {
    this.refresh();
  },

  async refresh() {
    try {
      const s = await api.getAppStatus();
      if (!s.cycle) {
        // 没有进行中的周期（尚未完成绑定 / 刚解绑）：明确提示，不要在这里读 null 崩溃
        wx.showToast({ title: '还没有进行中的周期', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 800);
        return;
      }
      const cur = s.myScore ? s.myScore.score : 5;
      this.setData({
        saved: s.cycle.status === 'exchanged',
        autoExchanged: s.cycle.status === 'exchanged',
        cycleIndex: s.cycle.index,
        editingCycleId: s.cycle.id,
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
    if (this.data.saved) return;
    tap.run('score-save', async () => {
      try {
        const res = await api.submitScore({ score: this.data.score, comment: this.data.comment, cycleId: this.data.editingCycleId });
        this.setData({ saved: true, autoExchanged: !!res.autoExchanged });
        wx.showToast({ title: res.autoExchanged ? '已保存，本期已自动交换' : '已保存', icon: 'none' });
        if (res.changed) {
          // 分数与上期相比发生了变化：引导记录原因（功能4）
          this.setData({ showEvent: true, prevScore: res.prevScore, cycleId: res.cycleId });
        }
      } catch (e) {
        wx.showToast({ title: (e && e.message) || '保存失败', icon: 'none' });
      }
    });
  },

  onEventReason(e) {
    this.setData({ eventReason: e.detail.value });
  },

  async onEditScore() {
    if (!this.data.saved || this.data.autoExchanged || this.data.checkingEdit) return;
    this.setData({ checkingEdit: true });
    try {
      const s = await api.getAppStatus();
      if (!s.cycle || s.cycle.id !== this.data.editingCycleId || s.cycle.status !== 'active') {
        wx.showToast({ title: '原周期已结束或配对已变化，请前往交换中心', icon: 'none' });
        return;
      }
      const score = s.myScore ? s.myScore.score : this.data.score;
      this.setData({ saved: false, showEvent: false, score, emoji: scoreEmoji(score),
        comment: s.myScore ? s.myScore.comment : this.data.comment });
    } catch (e) {
      wx.showToast({ title: e.message || '暂时无法确认周期状态，请重试', icon: 'none' });
    } finally {
      this.setData({ checkingEdit: false });
    }
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
        this.setData({ showEvent: false });
      } catch (e) {
        wx.showToast({ title: (e && e.message) || '记录失败', icon: 'none' });
      }
    });
  },

  onSkipEvent() {
    this.setData({ showEvent: false });
  },

  onShareAppMessage() {
    return exchangeShare(this.data.cycleIndex, this.data.saved && !this.data.autoExchanged);
  },

  goExchange() {
    wx.navigateTo({ url: '/pages/exchange/exchange' });
  },
});
