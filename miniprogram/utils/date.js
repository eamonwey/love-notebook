const DAY = 24 * 60 * 60 * 1000;

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.getMonth() + 1 + '月' + d.getDate() + '日';
}

function fmtDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.getMonth() + 1 + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function daysLeft(endTs, now) {
  now = now == null ? Date.now() : now;
  return Math.max(0, Math.ceil((endTs - now) / DAY));
}

function progress(startTs, endTs, now) {
  now = now == null ? Date.now() : now;
  if (endTs <= startTs) return 100;
  const pct = Math.floor(((now - startTs) / (endTs - startTs)) * 100);
  return Math.min(100, Math.max(0, pct));
}

function remainText(endTs, now) {
  const left = daysLeft(endTs, now);
  if (left <= 0) return '到点啦，快交换';
  return '还剩 ' + left + ' 天';
}

function scoreEmoji(score) {
  if (score == null) return '';
  if (score <= 3) return '😞';
  if (score <= 6) return '😐';
  if (score <= 8) return '😊';
  return '🥰';
}

module.exports = { DAY, fmtDate, fmtDateTime, daysLeft, progress, remainText, scoreEmoji };
