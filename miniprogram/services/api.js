/**
 * 统一数据服务入口。
 * 两个后端（mock / cloud）实现完全相同的接口，页面只依赖本模块。
 */
const config = require('../config/index.js');

module.exports = config.useMock ? require('./mock.js') : require('./cloud.js');
