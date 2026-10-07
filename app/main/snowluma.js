'use strict';
/**
 * SnowLuma 服务：检测 / 下载安装 / 更新 / 启动停止 / 状态 / 桥接配置写入。
 *
 * 目录约定（刻意把"程序"和"数据"分开，更新程序不会碰数据）：
 *   <root>/apps/SnowLuma      ← 程序（index.mjs、native/、client/...），更新时整体替换
 *   <root>/instances/SnowLuma ← 数据（config/、data/），作为进程工作目录
 * SnowLuma 用相对路径读写 config/ 与 data/，所以工作目录即数据目录。
 */
const fs = require('fs');
const path = require('path');
const fsp = require('fs/promises');
const { ManagedProcess } = require('./proc');
const netlib = require('./net');
const { extractZip, detectSingleRoot } = require('./unzip');
const u = require('./util');
const { detectNode, findBundledNode, readPackageVersion, snowlumaNodeSupported } = require('./env-scan');

const REPO = 'SnowLuma/SnowLuma';

class SnowLumaService {
  constructor({ store, emit }) {
    this.store = store;
    this.emit = emit || (() => {});
    this.proc = null;
    this.wired = false;
    this.credentials = null;
    this.lastError = '';
  }

  get paths() {
    const l = this.store.layout();
    return { app: l.app.snowluma, instance: l.instance.snowluma, downloads: l.downloads, logs: l.logs, meta: l.meta.snowluma };
  }

  procInstance() {
    if (!this.proc) {
      this.proc = new ManagedProcess({ name: 'snowluma', logDir: this.paths.logs });
    }
    if (!this.wired) {
      this.wired = true;
      this.proc.on('line', (entry) => this.onLine(entry));
    }
    return this.proc;
  }

  onLine(entry) {
    const text = entry.text || '';
    const match = /initial credentials:\s*user=(\S+)\s+password=(\S+)/i.exec(text);
    if (match) {
      this.credentials = { user: match[1], password: match[2], at: Date.now() };
      this.store.data.secrets.snowlumaPassword = match[2];
      this.store.save().catch(() => {});
      this.procInstance().pushLocal('已捕获 SnowLuma 初始登录凭据，可在总览页复制。');
      this.emit('snowluma:credentials', this.credentials);
    } else if (/临时密码|initial credential/i.test(text)) {
      this.emit('snowluma:log-hint', { text });
    }
  }

  // ---------------------------------------------------------------- 检测
  async installedInfo() {
    const { app, instance, meta } = this.paths;
    const entry = path.join(app, 'index.mjs');
    const installed = u.exists(entry);
    const version = installed ? readPackageVersion(app) : '';
    const metaInfo = u.readJson(meta, null) || {};
    const bundledNode = installed ? findBundledNode(app) : null;
    let node = bundledNode ? { exe: bundledNode, version: '', source: 'SnowLuma 内置' } : await detectNode();
    if (bundledNode) {
      const res = await u.runHidden(bundledNode, ['-v'], { timeoutMs: 10000 });
      node.version = (res.stdout || '').trim();
    }
    return {
      installed,
      version,
      flavor: metaInfo.flavor || (bundledNode ? 'full' : 'lite'),
      tag: metaInfo.tag || (version ? `v${version}` : ''),
      installedAt: metaInfo.installedAt || 0,
      appDir: app,
      instanceDir: instance,
      node,
      nodeOk: Boolean(node && snowlumaNodeSupported(node.version)),
      hasData: u.exists(path.join(instance, 'config')) || u.exists(path.join(instance, 'data')),
      credentials: this.credentials || (this.store.data.secrets.snowlumaPassword
        ? { user: 'admin', password: this.store.data.secrets.snowlumaPassword, at: 0 }
        : null),
    };
  }

  platformKey() {
    const p = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'osx' : 'linux';
    const a = process.arch === 'arm64' ? 'arm64' : 'x64';
    return { p, a };
  }

  async releases({ force = false } = {}) {
    const list = await netlib.listReleases(REPO, { mirrors: this.store.mirrorPrefixes(), limit: 30, force });
    return list.map((r) => ({
      tag: r.tag_name,
      name: r.name || r.tag_name,
      publishedAt: r.published_at,
      prerelease: netlib.isPrereleaseTag(r.tag_name),
      notes: String(r.body || '').slice(0, 4000),
      assets: (r.assets || []).map((a) => ({
        name: a.name,
        size: a.size,
        url: a.browser_download_url,
        digest: a.digest || '',
      })),
    }));
  }

  /** 依据本机平台/架构 + 版本口味，从 release 里挑出最合适的资产。 */
  pickAsset(release, flavor = 'auto') {
    const { p, a } = this.platformKey();
    const ext = p === 'win' ? 'zip' : 'tar.gz';
    const assets = (release && release.assets) || [];
    const match = (name, wantLite) => {
      if (!name.includes(`-${p}-${a}`)) return false;
      if (!name.endsWith(`.${ext}`)) return false;
      const isLite = /-lite\./.test(name);
      return wantLite ? isLite : !isLite;
    };
    const full = assets.find((x) => match(x.name, false));
    const lite = assets.find((x) => match(x.name, true));
    if (flavor === 'full') return full || null;
    if (flavor === 'lite') return lite || null;
    // auto：本机 Node 满足要求就用精简版（下载体积小得多），否则用内置 Node 的完整版
    return lite && this.nodeCache && this.nodeCache.ok ? lite : (full || lite || null);  }

  /** 推荐方案（给 UI 用）：返回候选列表 + 每个的体积/是否推荐。 */
  async plan({ flavor = 'auto', tag = '' } = {}) {
    const releases = await this.releases();
    const release = netlib.pickRelease(
      releases.map((r) => ({ ...r, tag_name: r.tag, body: r.notes, assets: r.assets.map((x) => ({ ...x, browser_download_url: x.url })) })),
      { channel: 'stable', tag },
    );
    if (!release) throw new Error(tag ? `未找到版本 ${tag}` : '没有可用的 SnowLuma 发行版');
    const { p, a } = this.platformKey();
    const ext = p === 'win' ? 'zip' : 'tar.gz';
    const usable = releases.find((r) => r.tag === release.tag_name) || { assets: [] };
    const full = usable.assets.find((x) => x.name.includes(`-${p}-${a}`) && x.name.endsWith(`.${ext}`) && !/-lite\./.test(x.name));
    const lite = usable.assets.find((x) => x.name.includes(`-${p}-${a}`) && x.name.endsWith(`.${ext}`) && /-lite\./.test(x.name));
    const node = await detectNode();
    this.nodeCache = { ok: Boolean(node && snowlumaNodeSupported(node.version)), node };
    const recommended = flavor === 'full' ? 'full' : flavor === 'lite' ? 'lite' : (lite && this.nodeCache.ok ? 'lite' : (full ? 'full' : 'lite'));
    const chosen = recommended === 'lite' ? lite : full;
    return {
      tag: release.tag_name,
      name: release.name,
      publishedAt: release.publishedAt,
      notes: release.notes,
      flavor: recommended,
      asset: chosen ? { name: chosen.name, size: chosen.size, url: chosen.url, digest: chosen.digest, flavor: /-lite\./.test(chosen.name) ? 'lite' : 'full' } : null,
      options: [
        lite ? { flavor: 'lite', name: lite.name, size: lite.size, digest: lite.digest, url: lite.url, note: '精简版：需本机 Node.js ≥ 22.13（23 系需 ≥ 23.4）' } : null,
        full ? { flavor: 'full', name: full.name, size: full.size, digest: full.digest, url: full.url, note: '完整版：内置 Node.js 运行时，体积较大但开箱即用' } : null,
      ].filter(Boolean),
      platform: `${p}-${a}`,
      node: { ...node, supported: Boolean(node && snowlumaNodeSupported(node.version)) },
    };
  }

  // ---------------------------------------------------------------- 安装 / 更新
  async install({ tag = '', flavor = 'auto', onProgress = () => {} } = {}) {
    const plan = await this.plan({ tag, flavor });
    if (!plan.asset) throw new Error('当前平台没有可用的 SnowLuma 安装包');
    const asset = plan.asset;
    const dest = path.join(this.paths.downloads, asset.name);
    onProgress({
      service: 'snowluma',
      phase: 'download',
      percent: 0,
      message: `下载 ${asset.name}（缓存到 ${this.paths.downloads}）`,
      detail: asset.name,
      target: this.paths.app,
    });

    await netlib.downloadFile({
      urls: [asset.url],
      dest,
      mirrors: this.store.mirrorPrefixes(),
      expectedSize: asset.size,
      sha256: netlib.parseDigest(asset.digest),
      onProgress: (p) => onProgress({ service: 'snowluma', phase: 'download', ...p }),
    });

    onProgress({ service: 'snowluma', phase: 'extract', percent: 0, message: `解压安装包…`, detail: tmp });
    const tmp = path.join(this.paths.downloads, `extract-snowluma-${Date.now()}`);
    await u.rmrf(tmp);
    await u.ensureDir(tmp);
    if (asset.name.endsWith('.zip')) {
      await extractZip(dest, tmp, { onProgress: (p) => onProgress({ service: 'snowluma', phase: 'extract', ...p }) });
    } else {
      const res = await u.runHidden('tar', ['-xzf', dest, '-C', tmp], { timeoutMs: 600000 });
      if (res.code !== 0) throw new Error(`解压失败：${res.stderr || res.stdout}`);
    }
    const root = await detectSingleRoot(tmp);
    if (!u.exists(path.join(root, 'index.mjs'))) {
      throw new Error('安装包结构异常：未找到 index.mjs');
    }

    onProgress({ service: 'snowluma', phase: 'install', percent: 95, message: `写入程序目录：${appDir}` });
    const appDir = this.paths.app;
    const backup = `${appDir}.bak`;
    await u.rmrf(backup);
    if (u.exists(appDir)) await fsp.rename(appDir, backup);
    await u.ensureDir(path.dirname(appDir));
    await fsp.rename(root, appDir);
    await u.rmrf(tmp);
    await u.rmrf(backup);

    const version = readPackageVersion(appDir);
    await u.writeJsonAtomic(this.paths.meta, {
      tag: plan.tag,
      version,
      flavor: asset.flavor,
      asset: asset.name,
      installedAt: Date.now(),
    });
    await u.ensureDir(this.paths.instance);
    await this.ensureRuntimeConfig({ forceHost: true });
    onProgress({
      service: 'snowluma',
      phase: 'done',
      percent: 100,
      message: `SnowLuma ${version || plan.tag} 安装完成 → ${appDir}`,
      detail: `数据目录：${this.paths.instance}`,
    });

    return { ok: true, tag: plan.tag, version, flavor: asset.flavor, asset: asset.name, appDir };
  }

  async update({ onProgress = () => {} } = {}) {
    const info = await this.installedInfo();
    if (!info.installed) return this.install({ onProgress });
    const wasRunning = this.isRunning();
    const plan = await this.plan({ flavor: this.store.data.install.snowlumaFlavor || 'auto', tag: this.store.data.install.snowlumaTag || '' });
    if (info.version && plan.tag && `v${info.version}` === plan.tag) {
      onProgress({ service: 'snowluma', phase: 'done', percent: 100, message: `已是最新版本 ${plan.tag}` });
      return { ok: true, upToDate: true, version: info.version, tag: plan.tag };
    }
    if (wasRunning) await this.stop();
    const result = await this.install({ tag: plan.tag, flavor: plan.asset ? plan.asset.flavor : 'auto', onProgress });
    if (wasRunning && this.store.data.runtime.restartOnUpdate) {
      onProgress({ service: 'snowluma', phase: 'restart', percent: 100, message: '重启 SnowLuma…' });
      await this.start();
    }
    return result;
  }

  // ---------------------------------------------------------------- 运行
  isRunning() {
    return Boolean(this.proc && this.proc.running);
  }

  async effectiveWebuiPort() {
    const cfg = u.readJson(path.join(this.paths.instance, 'config', 'runtime.json'), null);
    const port = cfg && Number(cfg.webuiPort);
    return Number.isFinite(port) && port > 0 ? port : Number(this.store.data.ports.snowlumaWebui) || 5099;
  }

  async ensureRuntimeConfig({ forceHost = false } = {}) {
    const file = path.join(this.paths.instance, 'config', 'runtime.json');
    await u.ensureDir(path.dirname(file));
    const current = u.readJson(file, null) || {};
    const next = {
      webuiPort: Number(this.store.data.ports.snowlumaWebui) || 5099,
      hookAutoLoad: current.hookAutoLoad === undefined ? true : current.hookAutoLoad,
      webuiHost: forceHost ? '127.0.0.1' : (current.webuiHost || '127.0.0.1'),
      webuiTls: { enabled: current.webuiTls && current.webuiTls.enabled ? true : false },
      trustProxy: typeof current.trustProxy === 'string' ? current.trustProxy : '',
      logMaxTotalMb: Number(current.logMaxTotalMb) || 1024,
      logRetainDays: Number.isFinite(current.logRetainDays) ? current.logRetainDays : 7,
      logPerUin: Boolean(current.logPerUin),
    };
    await u.writeJsonAtomic(file, next);
    return next;
  }

  /** 首次启动前预置一个已知密码，避免用户去日志里找临时密码。 */
  async maybeBootstrapPassword() {
    const credFile = path.join(this.paths.instance, 'config', 'webui.json');
    if (u.exists(credFile)) return '';
    let password = this.store.data.secrets.snowlumaPassword;
    if (!password || password.length < 8) {
      password = require('crypto').randomBytes(8).toString('hex');
      this.store.data.secrets.snowlumaPassword = password;
      await this.store.save();
      this.credentials = { user: 'admin', password, at: Date.now() };
    }
    return password;
  }

  async start({ onProgress = () => {} } = {}) {
    const info = await this.installedInfo();
    if (!info.installed) throw new Error('尚未安装 SnowLuma，请先点击"下载安装"。');
    if (this.isRunning()) return { ok: true, already: true };
    const port = await this.effectiveWebuiPort();
    const existing = await u.httpProbe(`http://127.0.0.1:${port}/`);
    if (existing.ok) {
      onProgress({ service: 'snowluma', phase: 'done', percent: 100, message: `检测到已有 SnowLuma 实例在 127.0.0.1:${port} 运行，直接接管显示` });
      return { ok: true, external: true, port, url: `http://127.0.0.1:${port}/` };
    }
    if (!info.nodeOk) {
      throw new Error(`Node.js 运行时不可用（${info.node ? info.node.version || '未知版本' : '未检测到'}）。请改用完整版 SnowLuma，或安装 Node.js ≥ 22.13。`);
    }
    const runtime = await this.ensureRuntimeConfig();
    const password = await this.maybeBootstrapPassword();
    const env = {
      SNOWLUMA_ACCEPT_EULA: '1',
      SNOWLUMA_ACCEPT_PRIVACY: '1',
      SNOWLUMA_WEBUI_HOST: runtime.webuiHost || '127.0.0.1',
      SNOWLUMA_WEBUI_PORT: String(port),
      SNOWLUMA_ONEBOT_HTTP_PORT: String(this.store.data.ports.snowlumaHttp || 3000),
      SNOWLUMA_ONEBOT_WS_PORT: String(this.store.data.ports.snowlumaWs || 3001),
    };
    if (password) env.SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD = password;

    const proc = this.procInstance();
    await proc.start({
      exe: info.node.exe,
      args: [path.join(this.paths.app, 'index.mjs')],
      cwd: this.paths.instance,
      env,
      label: 'SnowLuma',
    });

    onProgress({ service: 'snowluma', phase: 'ready-wait', percent: 60, message: `等待 SnowLuma WebUI（127.0.0.1:${port}）就绪…` });
    const probe = await u.waitForHttp(`http://127.0.0.1:${port}/`, {
      timeoutMs: 90000,
      onTick: () => {
        if (!proc.running) throw new Error('进程已退出');
      },
    }).catch(() => ({ ok: false }));

    if (!proc.running && !probe.ok) {
      const tail = proc.recent(30).map((l) => l.text).join('\n');
      throw new Error(`SnowLuma 启动失败。最近日志：\n${tail}`);
    }
    if (probe.ok) onProgress({ service: 'snowluma', phase: 'done', percent: 100, message: 'SnowLuma 已就绪' });
    return { ok: true, port, ready: probe.ok };
  }

  async stop() {
    if (!this.proc) return { ok: true, already: true };
    return this.proc.stop();
  }

  async restart(options = {}) {
    await this.stop();
    await u.sleep(600);
    return this.start(options);
  }

  // ---------------------------------------------------------------- 配置 / 状态
  readOnebotConfigFiles() {
    const dir = path.join(this.paths.instance, 'config');
    const globalFile = path.join(dir, 'onebot.json');
    const files = u.exists(dir) ? fs.readdirSync(dir).filter((f) => /^onebot_\d+\.json$/.test(f)) : [];
    return {
      dir,
      global: globalFile,
      perUin: files.map((f) => ({ name: f, uin: f.replace(/\D/g, ''), file: path.join(dir, f) })),
    };
  }

  /** OneBot HTTP 调用（用于读取登录状态）。 */
  async onebotAction(action, params = {}) {
    const { global: globalFile, perUin } = this.readOnebotConfigFiles();
    const cfg = u.readJson(globalFile, null);
    const token = (() => {
      const fromPerUin = perUin.map((p) => u.readJson(p.file, null)).find(Boolean);
      for (const source of [fromPerUin, cfg]) {
        if (!source || !source.networks) continue;
        const servers = source.networks.httpServers || [];
        const withToken = servers.find((s) => s && s.accessToken);
        if (withToken) return withToken.accessToken;
      }
      return '';
    })();
    const port = Number(this.store.data.ports.snowlumaHttp) || 3000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
      const json = await res.json().catch(() => null);
      return { ok: res.ok, json, tokenUsed: Boolean(token) };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    } finally {
      clearTimeout(timer);
    }
  }

  async status() {
    const info = await this.installedInfo();
    const port = await this.effectiveWebuiPort();
    const webui = await u.httpProbe(`http://127.0.0.1:${port}/`);
    const status = {
      installed: info.installed,
      version: info.version,
      tag: info.tag,
      flavor: info.flavor,
      running: this.isRunning(),
      external: !this.isRunning() && webui.ok,
      pid: this.proc ? this.proc.pid : 0,
      port,
      url: `http://127.0.0.1:${port}/`,
      webuiReady: webui.ok,
      login: null,
      node: info.node,
      nodeOk: info.nodeOk,
      appDir: info.appDir,
      instanceDir: info.instanceDir,
      credentials: info.credentials,
    };
    if (info.installed && webui.ok) {
      const login = await this.onebotAction('get_login_info');
      if (login.ok && login.json && login.json.status === 'ok' && login.json.data) {
        status.login = { uin: String(login.json.data.user_id || ''), nickname: login.json.data.nickname || '' };
      }
    }
    return status;
  }

  /** 生成 SnowLuma 出厂默认 OneBot 配置（http 3000 / ws 3001），token 与官方算法一致。 */
  defaultOnebotConfig() {
    const token = () => require('crypto').randomBytes(32).toString('base64url');
    return {
      networks: {
        httpServers: [{
          name: 'http-default',
          host: '127.0.0.1',
          port: Number(this.store.data.ports.snowlumaHttp) || 3000,
          path: '/',
          enableWebSocket: false,
          accessToken: token(),
          messageFormat: 'array',
          reportSelfMessage: false,
        }],
        httpClients: [],
        wsServers: [{
          name: 'ws-default',
          host: '127.0.0.1',
          port: Number(this.store.data.ports.snowlumaWs) || 3001,
          path: '/',
          role: 'Universal',
          accessToken: token(),
          messageFormat: 'array',
          reportSelfMessage: false,
        }],
        wsClients: [],
      },
      statusCommand: { enabled: true, swallow: false, cooldownSeconds: 5, trigger: '#sl' },
      historySync: { enabled: false },
      notifications: { channelIds: [] },
    };
  }

  /** 确保出厂监听器存在（OneBot HTTP 3000 / WS 3001）。缺失时补回默认值。 */
  ensureFactoryListeners(cfg) {
    const defaults = this.defaultOnebotConfig();
    if (!Array.isArray(cfg.networks.httpServers) || cfg.networks.httpServers.length === 0) {
      cfg.networks.httpServers = defaults.networks.httpServers;
    }
    if (!Array.isArray(cfg.networks.wsServers) || cfg.networks.wsServers.length === 0) {
      cfg.networks.wsServers = defaults.networks.wsServers;
    }
    return cfg;
  }

  /** 在已有配置里插入/更新反向 WS 客户端（保留其它适配器设置）。 */
  static patchOnebotConfig(cfg, entry) {
    const next = cfg && typeof cfg === 'object' ? cfg : {};
    const networks = next.networks && typeof next.networks === 'object' ? next.networks : {};
    for (const key of ['httpServers', 'httpClients', 'wsServers', 'wsClients']) {
      if (!Array.isArray(networks[key])) networks[key] = [];
    }
    const index = networks.wsClients.findIndex((c) => c && c.name === entry.name);
    if (index >= 0) networks.wsClients[index] = { ...networks.wsClients[index], ...entry };
    else networks.wsClients.push(entry);
    next.networks = networks;
    if (!next.statusCommand) next.statusCommand = { enabled: true, swallow: false, cooldownSeconds: 5, trigger: '#sl' };
    if (!next.historySync) next.historySync = { enabled: false };
    if (!next.notifications) next.notifications = { channelIds: [] };
    return next;
  }

  /**
   * 写入 OneBot 反向 WS 客户端配置（把 SnowLuma 连到 AstrBot）。
   * 注意 SnowLuma 的配置优先级：一旦某个 QQ 账号登录过，就会生成 onebot_<uin>.json（canonical snapshot），
   * 此时全局 onebot.json 会被忽略。所以这里两边都写：全局（给未来账号）+ 每个已存在的账号配置。
   */
  async writeBridge({ url, token = '', name = 'astrbot-bridge' } = {}) {
    const target = url || `ws://127.0.0.1:${this.store.data.ports.astrbotReverseWs || 6199}/ws`;
    const { global: globalFile, perUin } = this.readOnebotConfigFiles();
    await u.ensureDir(path.dirname(globalFile));
    const entry = {
      name,
      enabled: true,
      url: target,
      role: 'Universal',
      accessToken: token || '',
      messageFormat: 'array',
      reportSelfMessage: false,
      reconnectIntervalMs: 5000,
    };
    const files = [];

    const existingGlobal = u.readJson(globalFile, null);
    const nextGlobal = this.ensureFactoryListeners(
      SnowLumaService.patchOnebotConfig(existingGlobal || this.defaultOnebotConfig(), entry),
    );
    await u.writeJsonAtomic(globalFile, nextGlobal);
    files.push(globalFile);

    for (const item of perUin) {
      const cfg = u.readJson(item.file, null);
      if (!cfg || typeof cfg !== 'object') continue;
      const patched = SnowLumaService.patchOnebotConfig(cfg, entry);
      // 账号级 snapshot 会完全忽略全局配置，此时必须自带出厂监听器，否则 OneBot HTTP/WS 端口不存在
      if (patched.mode === 'snapshot') this.ensureFactoryListeners(patched);
      else if (!patched.mode) patched.mode = 'overlay';
      await u.writeJsonAtomic(item.file, patched);
      files.push(item.file);
    }

    return { ok: true, file: globalFile, files, url: target, entry, restartRequired: true, accounts: perUin.length };
  }

  logLines(n = 400) {
    return this.proc ? this.proc.recent(n) : [];
  }

  clearLogs() {
    if (this.proc) this.proc.clear();
  }
}

module.exports = { SnowLumaService, REPO };
