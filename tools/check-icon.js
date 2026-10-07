'use strict';
/** 校验 build/icon.ico 的目录项与内嵌 PNG 尺寸是否一致。 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'build', 'icon.ico');
const buf = fs.readFileSync(file);
const count = buf.readUInt16LE(4);
console.log(`文件：${file}（${buf.length} 字节，${count} 个尺寸）`);
let ok = true;
for (let i = 0; i < count; i += 1) {
  const off = 6 + 16 * i;
  const w = buf.readUInt8(off) || 256;
  const h = buf.readUInt8(off + 1) || 256;
  const len = buf.readUInt32LE(off + 8);
  const dataOff = buf.readUInt32LE(off + 12);
  const isPng = buf.readUInt32BE(dataOff) === 0x89504e47;
  const pngW = isPng ? buf.readUInt32BE(dataOff + 16) : -1;
  const pngH = isPng ? buf.readUInt32BE(dataOff + 20) : -1;
  const match = isPng && pngW === w && pngH === h;
  if (!match) ok = false;
  console.log(`  ${String(w).padStart(3)}x${String(h).padEnd(3)} 声明尺寸/PNG实际 ${pngW}x${pngH} ${match ? '✔' : '✘'} (${len} 字节)`);
}
console.log(ok ? '✔ ICO 结构校验通过' : '✘ ICO 结构异常');
process.exit(ok ? 0 : 1);
