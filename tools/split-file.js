'use strict';
/**
 * 把大文件切成若干分片，并输出每片的 SHA256 —— 用于在慢速/易断网络下把安装包分片上传到 GitHub Release。
 * 同时生成一个纯 ASCII 的合并脚本（cmd.exe 按 OEM 代码页读批处理，绝不能写中文）。
 *
 * 用法：node tools/split-file.js <文件> [每片 MB，默认 20] [输出目录]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const file = path.resolve(process.argv[2] || '');
const partMb = Number(process.argv[3] || 20);
const outDir = path.resolve(process.argv[4] || path.dirname(file));

if (!file || !fs.existsSync(file)) {
  console.error('用法：node tools/split-file.js <文件> [每片 MB=20] [输出目录]');
  process.exit(1);
}

const stat = fs.statSync(file);
const base = path.basename(file);
const partSize = Math.max(1, Math.floor(partMb)) * 1024 * 1024;
const total = Math.ceil(stat.size / partSize);
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

fs.mkdirSync(outDir, { recursive: true });
const fd = fs.openSync(file, 'r');
const parts = [];
try {
  for (let i = 0; i < total; i += 1) {
    const start = i * partSize;
    const length = Math.min(partSize, stat.size - start);
    const name = `${base}.part${String(i + 1).padStart(2, '0')}`;
    const dest = path.join(outDir, name);
    const buf = Buffer.allocUnsafe(length);
    fs.readSync(fd, buf, 0, length, start);
    fs.writeFileSync(dest, buf);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    parts.push({ name, size: length, sha256: hash });
    console.log(`  ${name}  ${(length / 1048576).toFixed(1)} MB  sha256=${hash.slice(0, 16)}…`);
  }
} finally {
  fs.closeSync(fd);
}

const manifest = [
  `# ${base}`,
  `# 原始文件大小: ${stat.size} 字节 (${(stat.size / 1048576).toFixed(2)} MB)`,
  `# 原始文件 SHA256: ${sha256(file)}`,
  '# 分片顺序即文件名顺序',
  ...parts.map((p) => `${p.sha256}  ${p.name}`),
  '',
].join('\n');
fs.writeFileSync(path.join(outDir, `${base}.parts.txt`), manifest, 'utf8');

const joinScript = `@echo off
rem ============================================================
rem  Join the split parts of ${base} back into one file.
rem  Put this script next to the .part01/.part02/... files and
rem  double-click it. SHA256 is printed for verification.
rem  (ASCII only on purpose: cmd.exe reads .cmd in the OEM
rem   codepage, non-ASCII text would break the script.)
rem ============================================================
setlocal
set TARGET=${base}
cd /d "%~dp0"

if exist "%TARGET%" del /f /q "%TARGET%"

set FOUND=0
for %%F in ("%TARGET%.part*") do (
  set FOUND=1
  echo Joining %%F ...
  if exist "%TARGET%" (
    copy /b "%TARGET%"+"%%F" "%TARGET%.joining" >nul
    move /y "%TARGET%.joining" "%TARGET%" >nul
  ) else (
    copy /b "%%F" "%TARGET%" >nul
  )
)

if "%FOUND%"=="0" (
  echo No part files found. Make sure this script sits next to %TARGET%.part01 ...
  pause
  exit /b 1
)

echo.
echo Joined: %TARGET%
echo.
echo SHA256 of the result:
certutil -hashfile "%TARGET%" SHA256
echo.
echo Expected SHA256 is listed in SHA256SUMS.txt / %TARGET%.parts.txt
pause
`;
fs.writeFileSync(path.join(outDir, '合并安装包_join.cmd'), joinScript, 'ascii');
fs.writeFileSync(path.join(outDir, 'join-installer.cmd'), joinScript, 'ascii');

console.log(`\n共 ${parts.length} 片，输出目录：${outDir}`);
console.log(`清单：${base}.parts.txt`);
console.log('合并脚本：join-installer.cmd（同名中文副本 合并安装包_join.cmd）');
