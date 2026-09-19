const api = require('../../services/api.js');
const tap = require('../../utils/tap.js');

const DRAFT_KEY = 'LOVE_NOTE_DRAFT';

Page({
  data: {
    type: 'happy',
    content: '',
  },

  onLoad(options) {
    if (options && (options.type === 'unhappy' || options.type === 'happy')) {
      this.setData({ type: options.type });
    }
    // 恢复未保存成功的草稿（例如内容被安全检测拦下后离开页面）
    const draft = wx.getStorageSync(DRAFT_KEY);
    if (draft && draft.content) {
      this.setData({ type: draft.type || this.data.type, content: draft.content });
    }
  },

  setType(e) {
    this.setData({ type: e.currentTarget.dataset.type });
    this.saveDraft();
  },

  onInput(e) {
    this.setData({ content: e.detail.value });
    this.saveDraft();
  },

  saveDraft() {
    wx.setStorageSync(DRAFT_KEY, { type: this.data.type, content: this.data.content });
  },

  onSave() {
    tap.run('note-save', async () => {
      try {
        await api.addNote({ type: this.data.type, content: this.data.content });
        wx.removeStorageSync(DRAFT_KEY);
        wx.showToast({ title: '已保存', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 600);
      } catch (e) {
        // 保存失败（含内容检测未通过）：草稿已在本地，文本框内容保留，可直接修改重试
        wx.showToast({ title: (e && e.message) || '保存失败', icon: 'none' });
      }
    });
  },
});
