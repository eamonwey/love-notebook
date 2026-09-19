const api = require('../../services/api.js');
const { fmtDateTime } = require('../../utils/date.js');
const tap = require('../../utils/tap.js');

Page({
  data: {
    cycle: null,
    notes: [],
  },

  onShow() {
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  async refresh() {
    try {
      const r = await api.getMyNotes();
      this.setData({
        cycle: r.cycle,
        notes: r.notes.map((n) => ({
          id: n.id,
          type: n.type,
          content: n.content,
          timeText: fmtDateTime(n.createdAt),
          annCount: (n.annotations || []).length,
        })),
      });
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '加载失败', icon: 'none' });
    }
  },

  goAdd() {
    tap.run('nav-noteedit', () => wx.navigateTo({ url: '/pages/note-edit/note-edit' }), 600);
  },

  onDelete(e) {
    const id = e.currentTarget.dataset.id;
    tap.run('notes-del', async () => {
      const confirmed = await new Promise((resolve) => {
        wx.showModal({
          title: '删除这条记录？',
          content: '交换之后将无法删除',
          success: (r) => resolve(!!r.confirm),
          fail: () => resolve(false),
        });
      });
      if (!confirmed) return;
      try {
        await api.deleteNote(id);
        this.refresh();
      } catch (err) {
        wx.showToast({ title: err.message, icon: 'none' });
      }
    }, 300);
  },
});
