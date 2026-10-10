// 固定封面避免微信默认截图泄露尚未交换的分数、留言和笔记。
module.exports = function (cycleIndex, ready) {
  const index = Number(cycleIndex);
  return {
    title: ready && Number.isInteger(index) && index > 0
      ? '第' + index + '期，我已打完分，来交换这一期的心意吧'
      : '来恋恋温度计，一起记录彼此的感受',
    path: '/pages/exchange/exchange?from=exchange-share',
    imageUrl: '/images/exchange-share.png',
  };
};
