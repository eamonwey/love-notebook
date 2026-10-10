const api = require('../../services/api.js');
const tap = require('../../utils/tap.js');

const DRAFT_KEY = 'LOVE_NOTE_DRAFT';
const DRAFT_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

Page({
  data: {
    type: 'happy',
    content: '',
  },

  onLoad(options) {
    // URL 上的类型（首页「记开心事 / 记小不满」快捷入口）优先级最高
    const urlType = options && (options.type === 'unhappy' || options.type === 'happy') ? options.type : '';
    if (urlType) this.setData({ type: urlType });
    // 恢复未保存成功的草稿（例如内容被安全检测拦下后离开页面）
    const draft = wx.getStorageSync(DRAFT_KEY);
    const savedAt = draft && draft.savedAt ? Number(draft.savedAt) : Date.now();
    const draftFresh = draft && savedAt > Date.now() - DRAFT_MAX_AGE;
    if (draft && !draftFresh) wx.removeStorageSync(DRAFT_KEY);
    if (draftFresh && draft.content) {
      if (!draft.savedAt) wx.setStorageSync(DRAFT_KEY, Object.assign({}, draft, { savedAt: savedAt }));
      // 草稿只负责恢复内容，类型以本次入口为准，
      // 否则从「记小不满」进来会被上次的草稿悄悄改成开心
      this.setData({ type: urlType || draft.type || this.data.type, content: draft.content });
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
    wx.setStorageSync(DRAFT_KEY, { type: this.data.type, content: this.data.content, savedAt: Date.now() });
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
