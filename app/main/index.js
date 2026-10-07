'use strict';
/**
 * 主进程：窗口、IPC 总线、服务编排。
 * 设计要点：
 *  1) 所有外部程序都通过 ManagedProcess 以隐藏窗口方式启动，绝不使用 shell，因此不会出现终端控制台。
 *  2) 程序目录（apps/）与数据目录（instances/）分离，更新程序不会动数据。
 *  3) 退出应用时一并停止子进程，避免留下后台残留。
 */
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { app, BrowserWindow, ipcMain, shell, dialog, Menu, nativeTheme, webContents } = require('electron');
const { Store } = require('./settings');
const { SnowLumaService } = require('./snowluma');
const { AstrBotService, venvPython } = require('./astrbot');
const u = require('./util');
const { detectQQ, detectNode, detectPythons } = require('./env-scan');
const qqfreeze = require('./qqfreeze');
const migrate = require('./migrate');

const APP_TITLE = 'SnowLuma × AstrBot 控制台';

/**
 * 启动器自身目录（settings.json + 控制台登录态 + Chromium 缓存）：
 *  1) 环境变量 SLA_BASE_DIR（自检/多实例用）；
 *  2) 便携模式：可执行文件同目录放 portable.txt —— 文件里写目录就用它，写空字符串则用 <exe目录>\profile；
 *  3) 默认 %APPDATA%\SnowLumaAstrBotConsole。
 * 注意：SnowLuma/AstrBot 的程序与数据不在这个目录里，由「设置 → 目录」的数据根目录决定。
 */
function resolveBaseDir() {
  if (process.env.SLA_BASE_DIR) return process.env.SLA_BASE_DIR;
  try {
    const exeDir = path.dirname(app.getPath('exe'));
    const marker = path.join(exeDir, 'portable.txt');
    if (fs.existsSync(marker)) {
      const custom = fs.readFileSync(marker, 'utf8').trim();
      return custom || path.join(exeDir, 'profile');
    }
  } catch { /* ignore */ }
  return app.getPath('userData');
}

const baseDir = resolveBaseDir();
try {
  if (baseDir !== app.getPath('userData')) {
    fs.mkdirSync(baseDir, { recursive: true });
    app.setPath('userData', baseDir);
  }
} catch { /* ignore */ }

const store = new Store(baseDir);
store.load();

let win = null;
let quitting = false;
const pending = { snowluma: null, astrbot: null, migrate: null };
const logFlush = { snowluma: [], astrbot: [] };
let logTimer = null;
let qqCache = { at: 0, value: null };

function send(channel, payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

const emit = (channel, payload) => send(channel, payload);

const snowluma = new SnowLumaService({ store, emit });
const astrbot = new AstrBotService({ store, emit });

function wireLogStreaming() {
  for (const [name, service] of [['snowluma', snowluma], ['astrbot', astrbot]]) {
    const proc = service.procInstance();
    proc.on('line', (entry) => {
      logFlush[name].push(entry);
      if (!logTimer) {
        logTimer = setTimeout(() => {
          logTimer = null;
          for (const key of Object.keys(logFlush)) {
            if (logFlush[key].length) {
              send('log:lines', { service: key, lines: logFlush[key] });
              logFlush[key] = [];
            }
          }
        }, 220);
      }
    });
    proc.on('exit', () => send('status:changed', { service: name }));
    proc.on('line', () => { /* 保持事件循环引用 */ });
  }
  // 状态变化时主动推送一次
  snowluma.procInstance().on('exit', () => send('status:changed', { service: 'snowluma' }));
  astrbot.procInstance().on('exit', () => send('status:changed', { service: 'astrbot' }));
}

async function snapshotEnv({ force = false } = {}) {
  if (force || !qqCache.value || Date.now() - qqCache.at > 60000) {
    const value = await detectQQ();
    qqCache = { at: Date.now(), value };
  }
  return { qq: qqCache.value, node: await detectNode() };
}

async function fullState({ withReleases = false } = {}) {
  const env = await snapshotEnv();
  const state = {
    app: {
      title: APP_TITLE,
      version: app.getVersion(),
      dataRoot: store.data.dataRoot,
      layout: store.layout(),
      baseDir,
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      node: process.versions.node,
    },
    settings: store.data,
    snowluma: await snowluma.status(),
    astrbot: await astrbot.status(),
    qq: env.qq,
    qqFreeze: qqfreeze.status(),
    systemNode: env.node,
    busy: { snowluma: Boolean(pending.snowluma), astrbot: Boolean(pending.astrbot) },
  };
  if (withReleases) {
    state.releases = {
      snowluma: await snowluma.releases().catch(() => []),
      astrbot: await astrbot.releases().catch(() => []),
    };
  }
  return state;
}

/** 同一服务同时只允许一个安装/更新任务。 */
function runExclusive(service, task) {
  if (pending[service]) {
    throw new Error('该服务已有任务正在进行，请稍候…');
  }
  const promise = (async () => {
    try {
      return await task();
    } catch (error) {
      send('progress', { service, phase: 'error', percent: 0, message: String((error && error.message) || error) });
      throw error;
    } finally {
      pending[service] = null;
      send('status:changed', { service });
    }
  })();
  pending[service] = promise;
  send('status:changed', { service });
  return promise;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    title: APP_TITLE,
    backgroundColor: '#0e1116',
    show: false,
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  installScreenshotHarness();
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  if (process.env.SLA_DEBUG === '1') {
    win.webContents.on('console-message', (...args) => {
      const ev = args[0];
      if (ev && typeof ev === 'object' && 'message' in ev) {
        console.log(`[renderer:${ev.level}] ${ev.message} (${ev.sourceId}:${ev.lineNumber})`);
      } else {
        console.log(`[renderer:${args[1]}] ${args[2]} (${args[4]}:${args[3]})`);
      }
    });
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  return win;
}

/**
 * 调试/自检用截图钩子（不影响正常使用）：
 *  - SLA_SCREENSHOT=<png>                  仅截一张主界面后退出
 *  - SLA_SCREENSHOT_PAGES=home,bridge,...  逐个页面截图（内嵌 WebUI 的 guest 页面单独截图）
 *  - SLA_BEFORE_JS=<js>                    截图前在渲染层执行一段脚本（可点击界面按钮做端到端验证）
 *  - SLA_BEFORE_WAIT_MS=毫秒               执行上面的脚本后额外等待
 *  - SLA_AUTOLOGIN=1                       截控制台页面前先执行一键登录
 */
function installScreenshotHarness() {
  const single = process.env.SLA_SCREENSHOT;
  const pages = process.env.SLA_SCREENSHOT_PAGES;
  if (!single && !pages) return;
  win.webContents.once('did-finish-load', async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // 截图依赖合成器出新帧：窗口被遮挡/后台节流时会拿到旧画面，这里关掉节流并临时置顶
    try {
      win.webContents.setBackgroundThrottling(false);
      win.setAlwaysOnTop(true, 'screen-saver');
      win.moveTop();
      win.focus();
    } catch { /* ignore */ }
    await wait(Number(process.env.SLA_SCREENSHOT_DELAY || 5000));
    try {
      if (single) {
        const image = await win.webContents.capturePage();
        await fsp.writeFile(single, image.toPNG());
        console.log(`[screenshot] ${single}`);
      }
      if (process.env.SLA_BEFORE_JS) {
        try {
          const result = await win.webContents.executeJavaScript(process.env.SLA_BEFORE_JS, true);
          console.log(`[ui-action] ${result === undefined ? 'ok' : String(result)}`);
        } catch (error) {
          console.log(`[ui-action] failed: ${error.message}`);
        }
        const extra = Number(process.env.SLA_BEFORE_WAIT_MS || 0);
        if (extra > 0) await wait(extra);
      }
      if (pages) {
        const list = pages.split(',').map((s) => s.trim()).filter(Boolean);
        const dir = process.env.SLA_SCREENSHOT_DIR || path.dirname(list[0]);
        let index = 0;
        for (const page of list) {
          win.webContents.send('ui:goto', { page });
          await wait(Number(process.env.SLA_SCREENSHOT_PAGE_DELAY || 4500));
          // 除了截图，再读一次真实 DOM 状态（截图可能因为窗口遮挡拿到旧帧）
          try {
            const dom = await win.webContents.executeJavaScript(
              `JSON.stringify({ active: (document.querySelector('.page.active') || {}).id || '',
                 title: (document.querySelector('#page-title') || {}).textContent || '',
                 snowluma: (document.querySelector('#badge-snowluma') || {}).textContent || '',
                 astrbot: (document.querySelector('#badge-astrbot') || {}).textContent || '',
                 dataRoot: (document.querySelector('#set-dataRoot') || {}).value || '' })`,
              true,
            );
            console.log(`[dom] ${page}: ${dom}`);
          } catch (error) {
            console.log(`[dom] ${page}: failed ${error.message}`);
          }
          if (process.env.SLA_AUTOLOGIN === '1' && (page === 'snowluma' || page === 'astrbot')) {
            try {
              const result = await win.webContents.executeJavaScript(`autoLogin(${JSON.stringify(page)})`, true);
              console.log(`[screenshot] autoLogin(${page}) → ${result === undefined ? 'ok' : String(result)}`);
            } catch (error) {
              console.log(`[screenshot] autoLogin failed: ${error.message}`);
            }
            await wait(6000);
          }
          const image = await win.webContents.capturePage();
          const file = path.join(dir, `${String(index).padStart(2, '0')}-${page}.png`);
          await fsp.writeFile(file, image.toPNG());
          console.log(`[screenshot] ${file}`);
          index += 1;
          if (page === 'snowluma' || page === 'astrbot') {
            const port = page === 'snowluma' ? '5099' : '6185';
            for (const contents of webContents.getAllWebContents()) {
              if (!contents.getURL().includes(`127.0.0.1:${port}`)) continue;
              try {
                const guestShot = await contents.capturePage();
                const guestFile = path.join(dir, `${String(index).padStart(2, '0')}-${page}-webui.png`);
                await fsp.writeFile(guestFile, guestShot.toPNG());
                console.log(`[screenshot] ${guestFile}`);
              } catch (error) {
                console.log(`[screenshot] guest capture failed: ${error.message}`);
              }
            }
          }
        }
      }
    } catch (error) {
      console.error(`[screenshot] failed: ${error.message}`);
    }
    if (process.env.SLA_SCREENSHOT_KEEP !== '1') app.exit(0);
  });
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '打开数据目录', click: () => shell.openPath(store.data.dataRoot) },
        { label: '打开日志目录', click: () => shell.openPath(store.layout().logs) },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [{ role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载界面' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: 'SnowLuma 文档', click: () => shell.openExternal('https://snowluma.github.io/zh/docs') },
        { label: 'AstrBot 文档', click: () => shell.openExternal('https://docs.astrbot.app') },
        { label: '桥接教程（应用内）', click: () => send('ui:goto', { page: 'bridge' }) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc() {
  ipcMain.handle('state:all', async (_e, options) => fullState(options || {}));

  ipcMain.handle('settings:patch', async (_e, patch) => {
    const next = await store.patch(patch || {});
    if (patch && patch.dataRoot && patch.dataRoot !== store.data.dataRoot) {
      await store.ensureLayout();
    }
    await store.ensureLayout();
    send('status:changed', {});
    return next;
  });

  ipcMain.handle('env:qq', async () => (await snapshotEnv({ force: true })).qq);
  ipcMain.handle('env:node', async () => detectNode());
  ipcMain.handle('env:pythons', async () => detectPythons());

  // ---- SnowLuma ----
  ipcMain.handle('snowluma:releases', async (_e, { force } = {}) => snowluma.releases({ force: Boolean(force) }));
  ipcMain.handle('snowluma:plan', async (_e, options) => snowluma.plan(options || {}));
  ipcMain.handle('snowluma:install', async (_e, options) => runExclusive('snowluma', () => snowluma.install({
    tag: (options && options.tag) || '',
    flavor: (options && options.flavor) || store.data.install.snowlumaFlavor,
    onProgress: (p) => send('progress', p),
  })));
  ipcMain.handle('snowluma:update', async () => runExclusive('snowluma', () => snowluma.update({
    onProgress: (p) => send('progress', p),
  })));
  ipcMain.handle('snowluma:start', async () => snowluma.start({ onProgress: (p) => send('progress', p) })
    .finally(() => send('status:changed', { service: 'snowluma' })));
  ipcMain.handle('snowluma:stop', async () => snowluma.stop().finally(() => send('status:changed', { service: 'snowluma' })));
  ipcMain.handle('snowluma:restart', async () => snowluma.restart({ onProgress: (p) => send('progress', p) })
    .finally(() => send('status:changed', { service: 'snowluma' })));
  ipcMain.handle('snowluma:bridge', async (_e, options) => {
    const result = await snowluma.writeBridge(options || {});
    if (result.ok && (options && options.restart) && snowluma.isRunning()) {
      await snowluma.restart({ onProgress: (p) => send('progress', p) });
    }
    return result;
  });
  ipcMain.handle('snowluma:logs', async (_e, { lines } = {}) => snowluma.logLines(lines || 500));
  ipcMain.handle('snowluma:clearLogs', async () => { snowluma.clearLogs(); return { ok: true }; });
  ipcMain.handle('snowluma:onebot', async (_e, { action, params } = {}) => snowluma.onebotAction(action || 'get_status', params || {}));

  // ---- AstrBot ----
  ipcMain.handle('astrbot:releases', async (_e, { force } = {}) => astrbot.releases({ force: Boolean(force) }));
  ipcMain.handle('astrbot:plan', async (_e, options) => astrbot.plan(options || {}));
  ipcMain.handle('astrbot:install', async (_e, options) => runExclusive('astrbot', () => astrbot.install({
    tag: (options && options.tag) || '',
    onProgress: (p) => send('progress', p),
  })));
  ipcMain.handle('astrbot:update', async () => runExclusive('astrbot', () => astrbot.update({
    onProgress: (p) => send('progress', p),
  })));
  ipcMain.handle('astrbot:repairDeps', async () => runExclusive('astrbot', () => astrbot.pipInstall({
    onProgress: (p) => send('progress', p),
  })));
  ipcMain.handle('astrbot:dashboard', async () => runExclusive('astrbot', () => astrbot.ensureDashboard({
    force: true,
    onProgress: (p) => send('progress', p),
  })));
  ipcMain.handle('astrbot:start', async () => astrbot.start({ onProgress: (p) => send('progress', p) })
    .finally(() => send('status:changed', { service: 'astrbot' })));
  ipcMain.handle('astrbot:stop', async () => astrbot.stop().finally(() => send('status:changed', { service: 'astrbot' })));
  ipcMain.handle('astrbot:restart', async () => astrbot.restart({ onProgress: (p) => send('progress', p) })
    .finally(() => send('status:changed', { service: 'astrbot' })));
  ipcMain.handle('astrbot:bridge', async (_e, options) => {
    const result = await astrbot.writeBridgeConfig(options || {});
    if (result.ok && (options && options.restart) && astrbot.isRunning()) {
      await astrbot.restart({ onProgress: (p) => send('progress', p) });
    }
    return result;
  });
  ipcMain.handle('astrbot:resetPassword', async () => runExclusive('astrbot', () => astrbot.resetPasswordFlow({
    onProgress: (p) => send('progress', p),
  })));
  ipcMain.handle('astrbot:logs', async (_e, { lines } = {}) => astrbot.logLines(lines || 500));
  ipcMain.handle('astrbot:login', async (_e, options) => astrbot.login(options || {}));
  ipcMain.handle('astrbot:clearLogs', async () => { astrbot.clearLogs(); return { ok: true }; });

  // ---- 通用 ----
  ipcMain.handle('shell:openPath', async (_e, { target } = {}) => shell.openPath(target));
  ipcMain.handle('shell:openExternal', async (_e, { url } = {}) => shell.openExternal(url));
  ipcMain.handle('logs:export', async (_e, { service } = {}) => {
    try {
      const name = service === 'astrbot' ? 'astrbot' : 'snowluma';
      const lines = name === 'astrbot' ? astrbot.logLines(20000) : snowluma.logLines(20000);
      const file = path.join(store.layout().logs, `export-${name}-${u.nowStamp()}.log`);
      await fsp.writeFile(file, lines.map((l) => `[${new Date(l.ts).toISOString()}] [${l.stream}] ${l.text}`).join('\n'), 'utf8');
      shell.showItemInFolder(file);
      return { ok: true, file };
    } catch (error) {
      return { ok: false, error: String(error.message) };
    }
  });
  ipcMain.handle('dialog:pickDir', async (_e, { title } = {}) => {
    const result = await dialog.showOpenDialog(win, {
      title: title || '选择目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? '' : result.filePaths[0];
  });
  ipcMain.handle('app:quit', async () => { app.quit(); return { ok: true }; });

  // ---- 数据目录迁移 ----
  ipcMain.handle('migrate:defaultTarget', async () => {
    const drives = [];
    for (const letter of ['F', 'D', 'E', 'G']) {
      if (u.exists(`${letter}:\\`)) drives.push(letter);
    }
    const currentRoot = path.parse(store.data.dataRoot).root.toLowerCase();
    const preferred = drives.find((d) => `${d.toLowerCase()}:\\` !== currentRoot);
    return preferred ? `${preferred}:\\SnowLumaAstrBotConsole` : '';
  });

  ipcMain.handle('migrate:plan', async (_e, { targetRoot } = {}) => {
    try {
      const plan = await migrate.plan({ sourceRoot: store.data.dataRoot, targetRoot });
      return { ok: true, plan };
    } catch (error) {
      return { ok: false, error: String(error.message) };
    }
  });

  ipcMain.handle('migrate:run', async (_e, { targetRoot } = {}) => {
    if (pending.migrate) return { ok: false, error: '已有迁移任务在进行中' };
    const promise = (async () => {
      const result = await migrate.run({
        sourceRoot: store.data.dataRoot,
        targetRoot,
        onProgress: (p) => send('progress', { service: 'migrate', ...p }),
        stopServices: async () => {
          await Promise.allSettled([snowluma.stop(), astrbot.stop()]);
          await u.sleep(800);
        },
        startServices: async () => {},
      });
      if (result.ok) {
        await store.patch({ dataRoot: result.targetRoot });
        await store.ensureLayout();
        send('migrate:done', result);
      }
      send('status:changed', {});
      return result;
    })();
    pending.migrate = promise;
    try {
      return await promise;
    } finally {
      pending.migrate = null;
    }
  });

  /** 冻结 QQ 自动更新（应用内功能：状态可读、一键冻结/解除，提权只弹 UAC，不弹终端）。 */
  ipcMain.handle('qq:freezeStatus', async () => qqfreeze.status());
  ipcMain.handle('qq:freeze', async () => {
    const result = await qqfreeze.freeze();
    send('status:changed', {});
    return result;
  });
  ipcMain.handle('qq:unfreeze', async () => {
    const result = await qqfreeze.unfreeze();
    send('status:changed', {});
    return result;
  });
  ipcMain.handle('qq:openHosts', async () => {
    const result = await shell.openPath(qqfreeze.HOSTS_PATH);
    return result ? { ok: false, error: result } : { ok: true };
  });
}

async function bootstrapServices() {
  await store.ensureLayout();
  wireLogStreaming();
  if (!store.data.runtime.autostartOnLaunch) return;
  // 已安装的服务在应用启动时自动拉起（失败只记录日志，不打断界面）
  const slInfo = await snowluma.installedInfo().catch(() => null);
  if (slInfo && slInfo.installed && !snowluma.isRunning()) {
    snowluma.start({ onProgress: (p) => send('progress', p) }).catch((error) => {
      snowluma.procInstance().pushLocal(`自动启动失败：${error.message}`);
      send('progress', { service: 'snowluma', phase: 'error', message: error.message });
    });
  }
  const abInfo = await astrbot.installedInfo().catch(() => null);
  if (abInfo && abInfo.installed && abInfo.hasVenv && !astrbot.isRunning()) {
    astrbot.start({ onProgress: (p) => send('progress', p) }).catch((error) => {
      astrbot.procInstance().pushLocal(`自动启动失败：${error.message}`);
      send('progress', { service: 'astrbot', phase: 'error', message: error.message });
    });
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    nativeTheme.themeSource = 'dark';
    registerIpc();
    buildMenu();
    createWindow();
    await bootstrapServices();
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    Promise.allSettled([snowluma.stop(), astrbot.stop()]).then(() => app.exit(0));
  });
}

process.on('uncaughtException', (error) => {
  try { send('toast', { level: 'error', message: `主进程异常：${error.message}` }); } catch { /* ignore */ }
});
process.on('unhandledRejection', (reason) => {
  try { send('toast', { level: 'error', message: `主进程未处理的 Promise：${String(reason)}` }); } catch { /* ignore */ }
});
