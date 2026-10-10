const { drawLineChart } = require('./chart');

async function loadAll(api, active = () => true) {
  const all = new Map();
  let beforeIndex;
  do {
    if (!active()) throw new Error('Cancelled');
    const h = await api.getHistory(Object.assign({ pageSize: 100 }, beforeIndex ? { beforeIndex } : {}));
    h.rows.forEach(r => all.set(r.cycleId, { index: r.index, myScore: r.myScore, partnerScore: r.partnerScore, gap: !!r.gap, eventCount: 0 }));
    if (!h.hasMore) {
      if (h.cyclesTruncated) throw new Error('History API requires pagination');
      break;
    }
    if (!h.nextBeforeIndex || beforeIndex && h.nextBeforeIndex >= beforeIndex) throw new Error('Invalid history cursor');
    beforeIndex = h.nextBeforeIndex;
  } while (true);
  return [...all.values()].sort((a,b) => a.index - b.index);
}

const IMAGE_WIDTH = 560;
const imageHeight = bands => 82 + bands * 224;
// 12 个点一行，相邻行/图重叠一个端点，所有线段都保留。
function bandsFor(rows) {
  const bands = [];
  for (let start = 0; start < rows.length; start += 11) {
    bands.push(rows.slice(start, start + 12));
    if (start + 12 >= rows.length) break;
  }
  return bands;
}

async function generateAll(page, rows, progress = () => {}, active = () => true) {
  const bands = bandsFor(rows);
  const images = [];
  for (let i = 0; i < bands.length; i += 6) {
    if (!active()) throw new Error('Cancelled');
    progress('正在生成 ' + (images.length + 1) + ' / ' + Math.ceil(bands.length / 6) + ' 张…');
    const part = bands.slice(i, i + 6);
    const path = await generate(page, part, images.length + 1, Math.ceil(bands.length / 6));
    images.push({ path, width: IMAGE_WIDTH, height: imageHeight(part.length), first: part[0][0].index, last: part[part.length - 1].slice(-1)[0].index });
  }
  return images;
}

async function generate(page, bands, number = 1, total = 1) {
  const canvas = await new Promise((resolve, reject) => {
    wx.createSelectorQuery().in(page).select('#export-chart').fields({ node: true }).exec((res) => {
      if (res && res[0] && res[0].node) resolve(res[0].node);
      else reject(new Error('Canvas unavailable'));
    });
  });
  const width = IMAGE_WIDTH, height = imageHeight(bands.length), dpr = 2;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  bands.forEach((rows, i) => {
    ctx.save(); ctx.translate(0, 64 + i * 224);
    drawLineChart(canvas, width, 220, dpr, rows, { me: '#FF6B81', partner: '#5B8DEF' }, {
      step: rows.length > 1 ? (width - 90) / (rows.length - 1) : 0,
      offset: rows.length === 1 ? (width - 68) / 2 : 10,
      fontSize: 14, labelColor: '#837980', skipResize: true,
    });
    ctx.restore();
  });
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = 'source-over';
  ctx.textAlign = 'left'; ctx.fillStyle = '#443b3e'; ctx.font = 'bold 22px sans-serif';
  ctx.fillText('我们的分数追踪', 34, 30);
  ctx.font = '16px sans-serif'; ctx.fillStyle = '#FF6B81'; ctx.fillText('● 我', width - 150, 30);
  ctx.fillStyle = '#5B8DEF'; ctx.fillText('● TA', width - 80, 30);
  ctx.fillStyle = '#7c7570'; ctx.font = '14px sans-serif';
  ctx.fillText('第 ' + bands[0][0].index + ' 期 — 第 ' + bands[bands.length - 1].slice(-1)[0].index + ' 期', 34, 54);
  if (total > 1) { ctx.textAlign = 'right'; ctx.fillText(number + ' / ' + total, width - 34, 54); }
  const result = await new Promise((resolve, reject) => wx.canvasToTempFilePath({
    canvas, fileType: 'png', destWidth: width * dpr, destHeight: height * dpr,
    success: resolve, fail: reject,
  }, page));
  return result.tempFilePath;
}

function share(path) {
  const preview = () => wx.previewImage({ urls: [path], current: path });
  if (!wx.showShareImageMenu) return preview();
  wx.showShareImageMenu({ path, fail: (e) => { if (!/cancel/i.test(e.errMsg || '')) preview(); } });
}

function save(path) {
  let saved = false;
  return new Promise((resolve) => wx.saveImageToPhotosAlbum({ filePath: path,
    success: () => { saved = true; },
    fail: (e) => {
      if (/cancel/i.test(e.errMsg || '')) return;
      if (/auth|deny|denied/i.test(e.errMsg || '')) {
        wx.showModal({ title: '需要相册权限', content: '请在设置中允许保存到相册后重试。', confirmText: '去设置', success: (r) => { if (r.confirm) wx.openSetting({}); } });
      } else wx.showToast({ title: '保存失败，请重试', icon: 'none' });
    }, complete: () => resolve(saved),
  }));
}
module.exports = { loadAll, bandsFor, generateAll, generate, share, save };
