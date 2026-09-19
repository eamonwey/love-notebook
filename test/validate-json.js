// 校验项目中所有 .json 文件均可被解析（app.json / 页面 json / 云函数 package.json 等）
const fs = require('fs');
const path = require('path');

let total = 0;
let failed = 0;

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '_template_backup') continue;
      walk(p);
    } else if (name.endsWith('.json')) {
      total++;
      try {
        JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (e) {
        failed++;
        console.error('JSON 无效:', p, '-', e.message);
      }
    }
  }
}

walk(path.join(__dirname, '..'));
console.log(`JSON 检查完成：${total} 个文件，${failed} 个失败`);
process.exit(failed ? 1 : 0);
