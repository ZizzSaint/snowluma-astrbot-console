'use strict';
/**
 * 一次性状态修复脚本（开发/验证用）：
 *  1) 用新的 SnowLuma 桥接写入逻辑修复 config/onebot.json（补回 http-default:3000 / ws-default:3001）
 *  2) 记录 AstrBot 当前面板密码（首次启动时从日志抓到的），便于应用显示与一键登录
 * 用法：node tools/fix-state.js [astrbotPassword]
 */
const path = require('path');
const { Store } = require('../app/main/settings');
const { SnowLumaService } = require('../app/main/snowluma');

const baseDir = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'SnowLumaAstrBotConsole')
  : path.join(process.cwd(), '.state');

(async () => {
  const store = new Store(baseDir);
  store.load();
  const svc = new SnowLumaService({ store, emit: () => {} });
  const result = await svc.writeBridge({ url: `ws://127.0.0.1:${store.data.ports.astrbotReverseWs}/ws`, token: '' });
  console.log('snowluma bridge:', JSON.stringify(result, null, 2));

  const pwd = process.argv[2];
  if (pwd) {
    store.data.secrets.astrbotPassword = pwd;
    await store.save();
    console.log('astrbot password recorded:', pwd);
  }
  console.log('settings secrets:', JSON.stringify(store.data.secrets));
})();
