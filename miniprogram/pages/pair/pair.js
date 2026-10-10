const api = require('../../services/api.js');
const tap = require('../../utils/tap.js');

// 全角字符归一（中文输入法下容易打出全角字母/数字），统一大写并去空格
function normalizeCode(raw) {
  return String(raw || '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .toUpperCase()
    .trim();
}

// 分享路径里的邀请码先做一次安全解码：
// 非法转义序列（例如孤立的 %）会让 decodeURIComponent 直接抛错，导致页面 onLoad 挂掉
function safeDecode(raw) {
  try {
    return decodeURIComponent(raw);
  } catch (e) {
    return String(raw || '');
  }
}

Page({
  data: {
    mode: 'loading', // loading | pair | confirm | bound
    code: '',
    inviteParam: '',
    ownerName: '',
    joinError: '',
    joinInput: '',
    nickname: '',
    cycleDays: '',
    inviteCycleDays: '',
    pairNames: '',
    error: '',
  },

  onLoad(options) {
    // 通过微信分享卡片进入：携带邀请码，进入「接受邀请」流程
    if (options && options.invite) {
      this.loadInvite(safeDecode(options.invite));
    }
  },

  onShow() {
    if (!this.data.inviteParam) {
      this.refresh();
    }
  },

  async refresh() {
    if (!api.isMock && !api.isEnvConfigured()) {
      this.setData({ mode: 'pair', error: 'CLOUD_ENV_NOT_SET' });
      return;
    }
    try {
      const p = await api.pairGet();
      if (p.pair && p.pair.users && p.pair.users.length >= 2) {
        const names = Object.keys(p.users || {})
          .map((k) => p.users[k].name)
          .join(' & ');
        this.setData({ mode: 'bound', pairNames: names, error: '' });
      } else {
        // 未绑定：配对视图（自己的邀请码如已生成则带出）
        this.setData({ mode: 'pair', code: p.pair && p.pair.code ? p.pair.code : '', cycleDays: p.pair ? p.pair.cycleDays : this.data.cycleDays, error: '' });
      }
    } catch (e) {
      this.setData({ mode: 'pair', error: e.message || '' });
    }
  },

  /* ---- ① 昵称：只保存昵称，与绑定无关 ---- */
  onNickname(e) {
    this.setData({ nickname: e.detail.value });
  },

  async saveNickname() {
    tap.run('pair-nick', async () => {
      try {
        await api.setNickname(this.data.nickname);
        wx.showToast({ title: '已保存', icon: 'success' });
      } catch (e) {
        wx.showToast({ title: e.message, icon: 'none' });
      }
    });
  },

  /* ---- ② 邀请TA ---- */
  chooseCycleDays(e) {
    this.setData({ cycleDays: Number(e.currentTarget.dataset.days) });
  },

  onCycleDays(e) {
    this.setData({ cycleDays: e.detail.value === '' ? '' : Number(e.detail.value) });
  },

  createInvite() {
    const days = Number(this.data.cycleDays);
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      wx.showToast({ title: '请先选择1–90天的周期', icon: 'none' });
      return;
    }
    tap.run('pair-create', async () => {
      try {
        const r = await api.pairCreate(days);
        this.setData({ code: r.code, error: '' });
        wx.showToast({ title: '邀请已生成', icon: 'success' });
      } catch (e) {
        wx.showToast({ title: e.message, icon: 'none' });
      }
    });
  },

  copyCode() {
    if (!this.data.code) return;
    wx.setClipboardData({
      data: this.data.code,
      success: () => wx.showToast({ title: '已复制', icon: 'success' }),
    });
  },

  // 微信分享卡片：对方点开即可进入接受邀请流程
  onShareAppMessage() {
    const code = this.data.code;
    return {
      title: '来测测我们的恋恋温度吧',
      path: code ? '/pages/pair/pair?invite=' + code : '/pages/pair/pair',
    };
  },

  /* ---- ③ 输入对方的邀请码绑定 ---- */
  onJoinInput(e) {
    this.setData({ joinInput: e.detail.value });
  },

  async joinManual() {
    const code = normalizeCode(this.data.joinInput);
    if (!code) {
      wx.showToast({ title: '先输入对方的邀请码', icon: 'none' });
      return;
    }
    if (code === this.data.code) {
      wx.showToast({ title: '这是你自己的邀请码，把TA发给对方吧', icon: 'none' });
      return;
    }
    await this.loadInvite(code);
  },

  /* ---- 通过分享卡片接受邀请 ---- */
  async loadInvite(code) {
    try {
      const r = await api.pairPreview(normalizeCode(code));
      this.setData({ mode: 'confirm', inviteParam: normalizeCode(code), ownerName: r.ownerName, inviteCycleDays: r.cycleDays, restoresHistory: !!r.restoresHistory, joinError: '' });
    } catch (e) {
      this.setData({ mode: 'confirm', inviteParam: normalizeCode(code), joinError: e.message });
    }
  },

  async acceptInvite() {
    tap.run('pair-accept', async () => {
      try {
        const result = await api.pairJoin(this.data.inviteParam);
        wx.showToast({ title: result.restored ? '已恢复共同记录' : '绑定成功', icon: 'success' });
        setTimeout(() => wx.reLaunch({ url: '/pages/index/index' }), 600);
      } catch (e) {
        wx.showToast({ title: e.message, icon: 'none' });
      }
    });
  },

  goSetup() {
    wx.navigateTo({ url: '/pages/setup/setup' });
  },

  goHome() {
    wx.reLaunch({ url: '/pages/index/index' });
  },
});
