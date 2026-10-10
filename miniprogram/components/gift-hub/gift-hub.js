const api = require('../../services/api.js');
const CATALOG = [
  { type: 'flower', name: '小红花', cost: 1, icon: '🌺', words: '谢谢你，把小事也放在心上' },
  { type: 'letter', name: '情书', cost: 5, icon: '💌', words: '今天也想认真地说：有你真好' },
  { type: 'car', name: '跑车', cost: 10, icon: '🏎️', words: '下一站，和你一起出发' },
];

Component({
  properties: { shop: { type: Boolean, value: false } },
  data: { catalog: CATALOG, state: null, loading: true, error: '', sending: false, receiving: false, effect: null,
    petals: [0, 1, 2, 3, 4, 5], sparks: [0, 1, 2, 3, 4, 5, 6, 7] },
  lifetimes: {
    ready() { this.resume(); },
    detached() { this.pause(); },
  },
  pageLifetimes: {
    show() { this.resume(); },
    hide() { this.pause(); },
  },
  methods: {
    resume() {
      this._visible = true;
      this.refreshGifts();
      clearInterval(this._poll);
      this._poll = setInterval(() => this.refreshGifts(), 25000);
    },
    pause() {
      this._visible = false;
      clearInterval(this._poll);
      this._poll = null;
      this.setData({ effect: null });
      this.triggerEvent('effectchange', { active: false });
    },
    async refreshGifts() {
      if (!this._visible || this._loading || this.data.sending || this.data.receiving) return;
      if (!api.isMock && !api.isEnvConfigured()) {
        this.setData({ loading: false, error: '礼物服务尚未就绪，请稍后重试' });
        return;
      }
      this._loading = true;
      const receiptRevision = this._receiptRevision || 0;
      this.setData({ loading: true });
      try {
        const state = await api.getGiftState();
        if (!this._visible || this.data.receiving || receiptRevision !== (this._receiptRevision || 0)) return;
        this.setData({ state: Object.assign({ allowance: 10, nextAllowance: 10 }, state), error: '' });
        if (!state.available || (this._wallet && state.walletKey !== this._wallet)) {
          this.setData({ effect: null });
          this.triggerEvent('effectchange', { active: false });
        }
        this._wallet = state.walletKey;
        this.showNext();
      } catch (e) {
        console.error('[gift-hub] getGiftState failed:', e);
        console.error('[gift-hub] diagnostic:', JSON.stringify({
          diagnostic: e.diagnostic || { version: '旧版云函数或请求未到达云端' }, requestId: e.requestId || '',
        }));
        if (this._visible) this.setData({ error: '礼物暂时加载失败，点此重试' });
      } finally {
        this._loading = false;
        if (this._visible) this.setData({ loading: false });
      }
    },
    showNext() {
      if (!this._visible || this.data.effect || !this.data.state || !this.data.state.available) return;
      const gift = this.data.state.inbox[0];
      if (!gift) return;
      const item = CATALOG.find((g) => g.type === gift.type);
      if (!item) return;
      // 固定本次展示的礼物编号，后到的礼物不能被这次收下操作吞掉。
      const group = this.data.state.inbox.filter((g) => g.type === gift.type &&
        (gift.senderKey ? g.senderKey === gift.senderKey : g.senderName === gift.senderName));
      const ids = [...new Set(group.map((g) => g.id))];
      const periods = [...new Set(group.map((g) => g.cycleIndex))];
      this.triggerEvent('effectchange', { active: true });
      const count = ids.reduce((sum, id) => sum + (group.find((g) => g.id === id).quantity || 1), 0);
      this.setData({ effect: Object.assign({}, gift, item, { ids, count,
        periodText: periods.length === 1 ? '来自第 ' + periods[0] + ' 期的心意' : '来自多个周期的心意' }) });
    },
    async receiveGift() {
      if (!this.data.effect || this.data.receiving) return;
      const gift = this.data.effect;
      this.setData({ receiving: true });
      try {
        await api.acknowledgeGift(gift.ids);
        this._receiptRevision = (this._receiptRevision || 0) + 1;
        const state = Object.assign({}, this.data.state, { inbox: this.data.state.inbox.filter((g) => !gift.ids.includes(g.id)) });
        this.setData({ state, effect: null });
        this.triggerEvent('effectchange', { active: false });
        wx.nextTick(() => this.showNext());
      } catch (e) {
        wx.showToast({ title: '未能保存已读状态，请重试', icon: 'none' });
      } finally {
        this.setData({ receiving: false });
        if (!this.data.effect) this.refreshGifts();
      }
    },
    async sendGift(e) {
      if (this.data.sending || !this.data.state || !this.data.state.available) return;
      const gift = CATALOG.find((g) => g.type === e.currentTarget.dataset.type);
      if (!gift) return;
      const state = this.data.state;
      const key = 'LOVE_GIFT_PENDING_' + state.walletKey;
      let pending = wx.getStorageSync(key);
      if (pending && pending.type !== gift.type) {
        wx.showToast({ title: '上次送礼结果待确认，请先重试原礼物', icon: 'none' });
        return;
      }
      // 兼容数量版已经保存的待确认请求，新赠送仍为一份。
      const quantity = pending ? (pending.quantity || 1) : 1;
      if (!pending && state.balance < gift.cost * quantity) {
        wx.showToast({ title: '本期钻石不足，请等待下一期', icon: 'none' });
        return;
      }
      this.setData({ sending: true });
      try {
        const confirmed = await new Promise((resolve) => wx.showModal({
          title: pending ? '确认上次送礼结果' : '送给TA一份心意',
          content: pending ? '将安全重试上次的' + gift.name + (quantity > 1 ? ' ×' + quantity : '') + '，不会重复扣钻石。' : gift.name + '会消耗' + gift.cost + '颗钻石，确定送出吗？',
          confirmText: pending ? '重试' : '送给TA', success: (r) => resolve(r.confirm), fail: () => resolve(false),
        }));
        if (!confirmed || !this._visible) return;
        if (!pending) {
          pending = { type: gift.type, cycleId: state.cycleId, requestId: 'g_' + Date.now() + '_' + Math.random().toString(36).slice(2, 14) };
          wx.setStorageSync(key, pending);
        }
        await api.sendGift(pending);
        wx.removeStorageSync(key);
        wx.showToast({ title: '已送出' + gift.name + (quantity > 1 ? ' ×' + quantity : ''), icon: 'success' });
      } catch (err) {
        const message = err.message || '';
        if (/钻石不足|新周期|配对|有效的礼物|周期不属于/.test(message)) wx.removeStorageSync(key);
        wx.showToast({ title: message || '结果待确认，请点原礼物重试', icon: 'none' });
      } finally {
        this.setData({ sending: false });
        this.refreshGifts();
      }
    },
    stopTouch() {},
  },
});
