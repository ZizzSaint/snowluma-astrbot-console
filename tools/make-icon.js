'use strict';
/**
 * 生成应用图标 build/icon.ico（多尺寸 PNG 打包进 ICO，Vista+ 支持）。
 * 用 Electron 自己渲染 SVG，保证图标风格与应用内品牌一致（渐变圆角方块 + SL 字母）。
 *
 * 用法：npx electron tools/make-icon.js
 */
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const OUT = path.join(__dirname, '..', 'build');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function html(size) {
  const radius = Math.round(size * 0.22);
  const fontSize = Math.round(size * 0.52);
  const shadow = Math.max(1, Math.round(size * 0.02));
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;width:${size}px;height:${size}px;overflow:hidden}
    .icon{
      width:${size}px;height:${size}px;border-radius:${radius}px;
      background:linear-gradient(135deg,#5aa2ff 0%,#4c8dff 38%,#7b5cff 100%);
      display:grid;place-items:center;position:relative;
      box-shadow: inset 0 ${-shadow}px ${shadow * 2}px rgba(0,0,0,.18);
    }
    .glow{position:absolute;left:8%;top:6%;width:46%;height:34%;border-radius:999px;
      background:radial-gradient(closest-side,rgba(255,255,255,.55),rgba(255,255,255,0));}
    .sl{
      position:relative;color:#fff;font-family:"Segoe UI Semibold","Microsoft YaHei UI",sans-serif;
      font-weight:800;font-size:${fontSize}px;letter-spacing:${-fontSize * 0.06}px;line-height:1;
      text-shadow:0 ${shadow}px ${shadow * 2}px rgba(20,30,60,.35);
    }
    .flake{position:absolute;right:9%;top:9%;width:22%;height:22%;opacity:.9}
  </style></head><body>
    <div class="icon">
      <div class="glow"></div>
      <div class="sl">SL</div>
      <svg class="flake" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.2"
           stroke-linecap="round" opacity="0.95">
        <path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9"/>
      </svg>
    </div>
  </body></html>`;
}

function buildIco(pngs) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);   // reserved
  header.writeUInt16LE(1, 2);   // type = icon
  header.writeUInt16LE(count, 4);
  const entries = [];
  let offset = 6 + 16 * count;
  for (const { size, data } of pngs) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);      // palette
    entry.writeUInt8(0, 3);      // reserved
    entry.writeUInt16LE(1, 4);   // color planes
    entry.writeUInt16LE(32, 6);  // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    width: 300,
    height: 300,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: false },
  });
  const pngs = [];
  for (const size of SIZES) {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html(size))}`);
    win.setContentSize(size, size);
    await new Promise((r) => setTimeout(r, 260));
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
    // 显示器有缩放（如 150%）时 capturePage 会返回放大后的位图，这里强制回到目标尺寸
    const resized = image.getSize().width === size ? image : image.resize({ width: size, height: size, quality: 'best' });
    const data = resized.toPNG();
    fs.writeFileSync(path.join(OUT, `icon-${size}.png`), data);
    pngs.push({ size, data });
    console.log(`rendered ${size}x${size} (${data.length} bytes)`);
  }
  const ico = buildIco(pngs);
  fs.writeFileSync(path.join(OUT, 'icon.ico'), ico);
  console.log(`wrote ${path.join(OUT, 'icon.ico')} (${ico.length} bytes, ${SIZES.length} sizes)`);
  app.exit(0);
});
