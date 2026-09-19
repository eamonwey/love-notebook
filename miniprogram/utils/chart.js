/**
 * 轻量折线图（canvas 2d）：双人对期分数曲线 + 事件标记
 * 返回落点坐标数组，供页面做点击命中。
 */
function drawLineChart(canvas, width, height, dpr, rows, colors) {
  const ctx = canvas.getContext('2d');
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);

  const padL = 34;
  const padR = 20;
  const padT = 34;
  const padB = 34;
  const w = width - padL - padR;
  const h = height - padT - padB;

  ctx.clearRect(0, 0, width, height);
  ctx.font = '11px sans-serif';

  // 横向网格 + 纵轴刻度
  [0, 2, 4, 6, 8, 10].forEach((v) => {
    const y = padT + h - (v / 10) * h;
    ctx.strokeStyle = '#F3E7E3';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + w, y);
    ctx.stroke();
    ctx.fillStyle = '#B9B0AB';
    ctx.textAlign = 'right';
    ctx.fillText(String(v), padL - 6, y + 4);
  });

  const n = rows.length;
  const toY = (s) => padT + h - (s / 10) * h;
  const points = rows.map((r, i) => {
    const x = padL + (n === 1 ? w / 2 : (i / (n - 1)) * w);
    return {
      x,
      index: r.index,
      row: r,
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
      if (!p[key]) return;
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
  drawLine('ta', colors.partner);
  drawLine('my', colors.me);

  // 事件徽标 + 期数标签
  points.forEach((p) => {
    if (p.row.eventCount > 0) {
      ctx.fillStyle = '#FFB300';
      ctx.beginPath();
      ctx.arc(p.x, padT - 14, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.font = '10px sans-serif';
      ctx.fillText(String(p.row.eventCount), p.x, padT - 10);
      ctx.font = '11px sans-serif';
    }
    ctx.fillStyle = '#B9B0AB';
    ctx.textAlign = 'center';
    ctx.fillText('第' + p.index + '期', p.x, padT + h + 18);
  });

  return points;
}

module.exports = { drawLineChart };
