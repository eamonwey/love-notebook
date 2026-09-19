// 对 miniprogram / cloudfunctions / test 下所有 .js 文件做 node --check 语法检查
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let total = 0;
let failed = 0;

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '_template_backup') continue;
      walk(p);
    } else if (name.endsWith('.js')) {
      total++;
      const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
      if (r.status !== 0) {
        failed++;
        console.error('SYNTAX FAIL:', p);
        if (r.stderr) console.error(r.stderr);
      }
    }
  }
}

walk(path.join(__dirname, '..'));
console.log(`语法检查完成：${total} 个文件，${failed} 个失败`);
process.exit(failed ? 1 : 0);
