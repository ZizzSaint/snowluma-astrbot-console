'use strict';
/**
 * 无界面自检脚本：直接驱动主进程模块，验证"检测 → 下载 → 安装 → 启动 → 状态 → 桥接"整条链路。
 * 用法：
 *   node tools/selftest.js --only=snowluma
 *   node tools/selftest.js --only=astrbot --with-deps
 *   node tools/selftest.js --only=env
 */
const os = require('os');
const path = require('path');
const { Store } = require('../app/main/settings');
const { SnowLumaService } = require('../app/main/snowluma');
const { AstrBotService } = require('../app/main/astrbot');
const { detectQQ, detectNode, detectPythons } = require('../app/main/env-scan');

const args = process.argv.slice(2);
const getArg = (name, def = '') => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const hasFlag = (name) => args.includes(`--${name}`);

const only = getArg('only', 'all');
const baseDir = getArg('base', path.join(process.env.APPDATA || os.homedir(), 'SnowLumaAstrBotConsole'));

const store = new Store(baseDir);
store.load();
store.data.dataRoot = getArg('root', store.data.dataRoot);

const log = (...a) => console.log(...a);
const progressPrinter = (label) => {
  let last = 0;
  return (p) => {
    if (Date.now() - last < 400 && p.phase !== 'done' && p.phase !== 'error') return;
    last = Date.now();
    const bits = [`[${label}]`, p.phase, p.percent != null ? `${p.percent}%` : '', p.message || ''].filter(Boolean);
    log(bits.join(' '));
  };
};

async function testEnv() {
  log('== 环境检测 ==');
  log('baseDir:', baseDir);
  log('dataRoot:', store.data.dataRoot);
  const qq = await detectQQ();
  log('QQ:', JSON.stringify(qq));
  const node = await detectNode();
  log('Node:', JSON.stringify(node));
  const pythons = await detectPythons();
  log('Python usable:', JSON.stringify(pythons.usable));
  await store.ensureLayout();
  log('layout:', JSON.stringify(store.layout(), null, 2));
}

async function testSnowluma() {
  const svc = new SnowLumaService({ store, emit: () => {} });
  log('\n== SnowLuma ==');
  const plan = await svc.plan({ flavor: store.data.install.snowlumaFlavor || 'auto' });
  log('plan:', plan.tag, plan.flavor, plan.asset && `${plan.asset.name} (${plan.asset.size} bytes)`);
  const result = await svc.install({ flavor: store.data.install.snowlumaFlavor || 'auto', onProgress: progressPrinter('snowluma') });
  log('installed:', JSON.stringify(result));
  const started = await svc.start({ onProgress: progressPrinter('snowluma-start') });
  log('started:', JSON.stringify(started));
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    const st = await svc.status();
    if (st.credentials) { log('credentials:', JSON.stringify(st.credentials)); break; }
  }
  const status = await svc.status();
  log('status:', JSON.stringify(status, null, 2));
  const bridge = await svc.writeBridge({ url: `ws://127.0.0.1:${store.data.ports.astrbotReverseWs}/ws`, token: '' });
  log('bridge:', JSON.stringify(bridge));
  if (!hasFlag('keep-running')) {
    await svc.stop();
    log('stopped');
  }
  log('--- SnowLuma 最近日志 ---');
  log(svc.logLines(40).map((l) => l.text).join('\n'));
}

async function testAstrbot() {
  const svc = new AstrBotService({ store, emit: () => {} });
  log('\n== AstrBot ==');
  if (!hasFlag('skip-install')) {
    const plan = await svc.plan({});
    log('plan:', plan.tag, plan.sourceUrls[0]);
    const result = await svc.install({ onProgress: progressPrinter('astrbot') });
    log('installed:', JSON.stringify(result));
  }
  const started = await svc.start({ onProgress: progressPrinter('astrbot-start') });
  log('started:', JSON.stringify(started));
  await new Promise((r) => setTimeout(r, 3000));
  const status = await svc.status();
  log('status:', JSON.stringify(status, null, 2));
  const bridge = await svc.writeBridgeConfig({ port: store.data.ports.astrbotReverseWs });
  log('bridge:', JSON.stringify(bridge));
  log('credentials:', JSON.stringify(svc.credentials));
  if (!hasFlag('keep-running')) {
    await svc.stop();
    log('stopped');
  }
  log('--- AstrBot 最近日志 ---');
  log(svc.logLines(40).map((l) => l.text).join('\n'));
}

(async () => {
  try {
    if (only === 'env' || only === 'all') await testEnv();
    if (only === 'snowluma' || only === 'all') await testSnowluma();
    if (only === 'astrbot' || only === 'all') await testAstrbot();
    log('\n自检完成');
    process.exit(0);
  } catch (error) {
    console.error('\n自检失败：', error && error.stack ? error.stack : error);
    process.exit(1);
  }
})();
