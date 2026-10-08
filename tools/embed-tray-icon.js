'use strict';
/**
 * 把 build/icon-32.png 内联成 app/main/tray-icon.js（base64）。
 * 为什么要内联：打包后 build/ 目录可能不在 asar 里，托盘图标必须自带。
 *
 * 用法：node tools/embed-tray-icon.js [png路径]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const src = path.resolve(process.argv[2] || path.join(ROOT, 'build', 'icon-32.png'));
const dest = path.join(ROOT, 'app', 'main', 'tray-icon.js');

if (!fs.existsSync(src)) {
  console.error(`找不到图标源文件：${src}（先执行 npm run icon）`);
  process.exit(1);
}

const png = fs.readFileSync(src);
const base64 = png.toString('base64');

const content = `'use strict';
/**
 * 托盘图标（内联 base64，避免打包后找不到图标文件）。
 * 由 tools/embed-tray-icon.js 从 build/icon-32.png 生成，请勿手工修改；
 * 换图标后重新执行：node tools/embed-tray-icon.js
 * 源文件：${path.relative(ROOT, src).replace(/\\/g, '/')}（${png.length} 字节）
 */
const TRAY_ICON_PNG_BASE64 = '${base64}';

module.exports = { TRAY_ICON_PNG_BASE64 };
`;

fs.writeFileSync(dest, content, 'utf8');
console.log(`已写入 ${path.relative(ROOT, dest)}（PNG ${png.length} 字节 → base64 ${base64.length} 字符）`);
