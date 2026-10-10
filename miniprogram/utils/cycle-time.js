function openingText(timestamp) {
  if (!timestamp) return '';
  return new Date(timestamp + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') + '（北京时间）';
}
module.exports = { openingText };
