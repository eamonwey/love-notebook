/**
 * 轻量折线图（canvas 2d）：双人对期分数曲线 + 事件标记
 * 返回落点坐标数组，供页面做点击命中。
 */
function drawLineChart(canvas, width, height, dpr, rows, colors, layout) {
  const ctx = canvas.getContext('2d');
  // skipResize：调用方已初始化过画布（虚拟滚动的高频重绘），复用上下文，
  // 避免每次重绘都重置画布（重新分配缓冲区 + 清空状态）造成滚动掉帧。
  if (!layout || !layout.skipResize) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
  }
  ctx.clearRect(0, 0, width, height);
  const fontSize = layout && layout.fontSize || 11;
  const labelColor = layout && layout.labelColor || '#B9B0AB';
  ctx.font = fontSize + 'px sans-serif';

  const padL = 34;
  const padR = 20;
  const padT = 34;
  const padB = 34;
  const w = width - padL - padR;
  const h = height - padT - padB;

  // 横向网格 + 纵轴刻度
  [0, 2, 4, 6, 8, 10].forEach((v) => {
    const y = padT + h - (v / 10) * h;
    ctx.strokeStyle = '#F3E7E3';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + w, y);
    ctx.stroke();
    ctx.fillStyle = labelColor;
    ctx.textAlign = 'right';
    ctx.fillText(String(v), padL - 6, y + 4);
  });

  const n = rows.length;
  const toY = (s) => padT + h - (s / 10) * h;
  const points = rows.map((r, i) => {
    const x = padL + (layout ? layout.offset + i * layout.step : (n === 1 ? w / 2 : (i / (n - 1)) * w));
    return {
      x,
      index: r.index,
      row: r,
      event: r.eventCount > 0 ? { x, y: padT - 14 } : null,
      my: r.myScore == null ? null : { x, y: toY(r.myScore) },
      ta: r.partnerScore == null ? null : { x, y: toY(r.partnerScore) },
    };
  });

  const drawLine = (key, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    let started = false;
    points.forEach((p) => {
      if (!p[key] || p.row.gap) { started = false; return; }
      if (!started) {
        ctx.moveTo(p[key].x, p[key].y);
        started = true;
      } else {
        ctx.lineTo(p[key].x, p[key].y);
      }
    });
    ctx.stroke();
    points.forEach((p) => {
      if (!p[key]) return;
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.arc(p[key].x, p[key].y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    });
  };

  // 先画 TA 再画我，我的线在上层
  ctx.save();
  ctx.beginPath();
  // 圆点半径 4.5px + 描边半宽 1.25px，裁剪留白必须覆盖完整外轮廓。
  ctx.rect(padL - 8, 0, w + 16, height);
  ctx.clip();
  drawLine('ta', colors.partner);
  drawLine('my', colors.me);
  ctx.restore();

  // 事件徽标 + 期数标签
  points.forEach((p) => {
    // 原生滚动/布局可能保留亚像素误差，不让边界上的期数和事件突然消失。
    if (p.x < padL - 1 || p.x > padL + w + 1) { p.event = null; return; }
    if (p.row.eventCount > 0) {
      ctx.fillStyle = '#FFB300';
      ctx.beginPath();
      ctx.arc(p.x, padT - 14, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.font = '10px sans-serif';
      ctx.fillText(String(p.row.eventCount), p.x, padT - 10);
      ctx.font = fontSize + 'px sans-serif';
    }
    ctx.fillStyle = labelColor;
    ctx.textAlign = 'center';
    ctx.fillText(p.row.gap ? '暂停' : '第' + p.index + '期', p.x, padT + h + 18);
  });

  return points;
}

module.exports = { drawLineChart };
