'use strict';
/**
 * 更新链路验证：安装旧版本 → 更新到最新 → 断言"程序被替换、数据被保留"。
 * 用法：node tools/test-update.js [snowluma|astrbot]
 */
const fs = require('fs');
const path = require('path');
const { Store } = require('../app/main/settings');
const { SnowLumaService } = require('../app/main/snowluma');
const { AstrBotService } = require('../app/main/astrbot');

const baseDir = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'SnowLumaAstrBotConsole')
  : path.join(process.cwd(), '.state');
const only = (process.argv[2] || 'all').toLowerCase();

const store = new Store(baseDir);
store.load();
const log = (...a) => console.log(...a);
const onProgress = (p) => {
  if (p.phase === 'done' || p.phase === 'error' || p.percent === 100) log(`  [${p.service}] ${p.phase} ${p.message || ''}`);
};

function snapshotFiles(dir, limit = 6) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 2 || out.length >= limit) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (out.length >= limit) return;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else out.push({ file: path.relative(dir, full), size: fs.statSync(full).size });
    }
  };
  if (fs.existsSync(dir)) walk(dir, 0);
  return out;
}

async function testSnowluma() {
  log('\n=== SnowLuma 更新测试 ===');
  const svc = new SnowLumaService({ store, emit: () => {} });
  const releases = await svc.releases();
  const previous = releases.find((r) => r.tag !== releases[0].tag);
  log('目标：先装', previous.tag, '再更新到', releases[0].tag);
  const installResult = await svc.install({ tag: previous.tag, flavor: 'lite', onProgress });
  log('已安装旧版：', installResult.version);
  // 制造一份"用户数据"，验证更新后仍在
  const marker = path.join(svc.paths.instance, 'config', 'user-marker.json');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ hello: 'keep me', at: Date.now() }), 'utf8');
  const before = snapshotFiles(svc.paths.instance);
  const updateResult = await svc.update({ onProgress });
  log('更新结果：', JSON.stringify(updateResult));
  const after = snapshotFiles(svc.paths.instance);
  const markerKept = fs.existsSync(marker);
  log('用户数据标记保留：', markerKept);
  log('更新前数据文件：', JSON.stringify(before));
  log('更新后数据文件：', JSON.stringify(after));
  const info = await svc.installedInfo();
  const pass = info.version === releases[0].tag.replace(/^v/, '') && markerKept;
  log(pass ? '✔ SnowLuma 更新测试通过（程序已更新、数据保留）' : '✘ SnowLuma 更新测试失败');
  return pass;
}

async function testAstrbot() {
  log('\n=== AstrBot 更新测试 ===');
  const svc = new AstrBotService({ store, emit: () => {} });
  const releases = await svc.releases();
  // 与应用一致：稳定通道 = 跳过 beta/alpha/rc
  const target = releases.find((r) => !r.prerelease) || releases[0];
  const previous = releases.find((r) => !r.prerelease && r.tag !== target.tag);
  log('目标：先装', previous.tag, '（跳过依赖）再更新到', target.tag);
  const installResult = await svc.install({ tag: previous.tag, onProgress, withDeps: false });
  log('已安装旧版：', installResult.version);
  const dataMarker = path.join(svc.paths.data, 'update-test-marker.json');
  fs.mkdirSync(svc.paths.data, { recursive: true });
  fs.writeFileSync(dataMarker, JSON.stringify({ hello: 'keep me' }), 'utf8');
  const updateResult = await svc.update({ onProgress });
  log('更新结果：', JSON.stringify(updateResult));
  const markerKept = fs.existsSync(dataMarker);
  const info = await svc.installedInfo();
  log('用户数据（data/）保留：', markerKept, '| 当前版本：', info.version);
  const pass = info.version === target.tag.replace(/^v/, '') && markerKept;
  log(pass ? '✔ AstrBot 更新测试通过（程序已更新、data 保留）' : '✘ AstrBot 更新测试失败');
  return pass;
}

(async () => {
  let pass = true;
  if (only === 'all' || only === 'snowluma') pass = (await testSnowluma()) && pass;
  if (only === 'all' || only === 'astrbot') pass = (await testAstrbot()) && pass;
  log(pass ? '\n全部更新测试通过' : '\n存在失败的更新测试');
  process.exit(pass ? 0 : 1);
})().catch((error) => {
  console.error('测试异常：', error && error.stack ? error.stack : error);
  process.exit(1);
});
