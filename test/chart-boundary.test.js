const assert = require('assert');
const { drawLineChart } = require('../miniprogram/utils/chart');

function render(offset) {
  const calls = { labels: [], circles: [], clip: null };
  const ctx = new Proxy({}, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      if (key === 'rect') calls.clip = args;
      if (key === 'arc') calls.circles.push({ x: args[0], radius: args[2] });
      if (key === 'fillText') calls.labels.push(args[0]);
    };
  } });
  calls.points = drawLineChart({ getContext: () => ctx }, 330, 220, 2,
    [{ index: 1, myScore: 8, partnerScore: 6, eventCount: 1 }, { index: 2, myScore: 9, partnerScore: 8, eventCount: 0 }],
    { me: '#ff6b81', partner: '#5b8def' }, { offset, step: 44 });
  return calls;
}

const edge = render(0);
const dot = edge.circles.find(c => c.radius === 4.5);
assert.ok(dot.x - dot.radius - 2.5 / 2 >= edge.clip[0], '滚到起点后，第1期圆点的外描边必须完整位于裁剪框内');
const fractional = render(-0.4);
assert.ok(fractional.labels.includes('第1期'), '小于1px的原生滚动舍入误差不能让第1期标签消失');
assert.ok(fractional.points[0].event, '第1期黄色事件标记在滚动起点不能消失');
console.log('✓ 起点圆点外描边完整、亚像素滚动误差不吞标签和事件');

const createPage = require('../miniprogram/utils/history-page');
for (const fullscreen of [false, true]) {
  const page = createPage(fullscreen);
  page.data.chartContentWidth = 900;
  page.data.chartViewport = 330;
  let queryCallback;
  let painted = 0;
  global.wx = { createSelectorQuery: () => ({
    in() { return this; }, select(id) { assert.strictEqual(id, '#chart-scroll'); return this; },
    fields(options) { assert.strictEqual(options.scrollOffset, true); return this; },
    exec(cb) { queryCallback = cb; },
  }) };
  page.draw = () => { painted++; };
  page._scrollLeft = 12;
  page.syncChartScroll();
  queryCallback([{ scrollLeft: 0.4 }]);
  assert.strictEqual(page._scrollLeft, 0, '停靠时使用实际位置，纠正旧偏移');
  assert.strictEqual(painted, 1);
  assert.strictEqual(page.normaliseScroll(570.2), 570);
  assert.strictEqual(page.normaliseScroll(16), 16, '正常拖动不能提前吸附起点');
  page.syncChartScroll();
  page._scrollVersion = 2;
  page._scrollLeft = 90;
  queryCallback([{ scrollLeft: 0 }]);
  assert.strictEqual(page._scrollLeft, 90, '旧查询不能覆盖新的滚动位置');
  page.syncChartScroll();
  page._hidden = true;
  queryCallback([{ scrollLeft: 0 }]);
  assert.strictEqual(page._scrollLeft, 90, '离开页面后不重画');
}
console.log('✓ 普通/全屏滚动位置纠偏、非边界不吸附、过期查询和隐藏页面不覆盖');

const fs = require('fs');
const path = require('path');
for (const file of ['pages/history/history.wxml', 'pages/history-fullscreen/history-fullscreen.wxml', 'utils/chart-export.js']) {
  const source = fs.readFileSync(path.join(__dirname, '../miniprogram', file), 'utf8');
  assert.ok(!/左旧|右新|左边是过去|右边是最近|从左到右，再续下一行/.test(source));
}
console.log('✓ 页面方向说明和导出图底部解释已移除');
