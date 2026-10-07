'use strict';
/**
 * AstrBot 服务：源码安装（venv + requirements）、启动停止、状态、更新（保留 data 数据）、
 * 面板 dist 预置、桥接配置写入。
 *
 * 目录约定（AstrBot 支持 ASTRBOT_ROOT 环境变量，因此程序与数据可以彻底分离）：
 *   <root>/apps/AstrBot        ← 程序源码（更新时整体替换）
 *   <root>/instances/AstrBot   ← ASTRBOT_ROOT（data/ 配置、插件、数据库、面板 dist）
 *   <root>/instances/AstrBot/venv ← Python 虚拟环境
 */
const fs = require('fs');
const path = require('path');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { ManagedProcess } = require('./proc');
const netlib = require('./net');
const { extractZip, detectSingleRoot } = require('./unzip');
const u = require('./util');
const { detectPythons } = require('./env-scan');

const REPO = 'AstrBotDevs/AstrBot';
const REGISTRY_DASHBOARD = (tag) => `https://astrbot-registry.soulter.top/download/astrbot-dashboard/${tag}/dist.zip`;

function venvPython(venvDir) {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

/** 生成符合 AstrBot 复杂度要求（大写+小写+数字，≥8 位）的面板密码。 */
function generateDashboardPassword(length = 16) {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const all = upper + lower + digits;
  const pick = (set) => set[crypto.randomInt(0, set.length)];
  const chars = [pick(upper), pick(lower), pick(digits)];
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** 与 AstrBot astrbot/core/utils/auth_password.py 完全一致的 PBKDF2-SHA256 存储格式。 */
function hashDashboardPassword(raw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto
    .pbkdf2Sync(Buffer.from(raw, 'utf8'), Buffer.from(salt, 'hex'), 600000, 32, 'sha256')
    .toString('hex');
  return `pbkdf2_sha256$600000$${salt}$${digest}`;
}

function md5Hex(raw) {
  return crypto.createHash('md5').update(raw, 'utf8').digest('hex');
}

class AstrBotService {
  constructor({ store, emit }) {
    this.store = store;
    this.emit = emit || (() => {});
    this.proc = null;
    this.wired = false;
    this.credentials = null;
    this.lastPhase = null;
  }

  get paths() {
    const l = this.store.layout();
    const venv = path.join(l.instance.astrbot, 'venv');
    return {
      app: l.app.astrbot,
      instance: l.instance.astrbot,
      venv,
      venvPython: venvPython(venv),
      data: path.join(l.instance.astrbot, 'data'),
      downloads: l.downloads,
      logs: l.logs,
      meta: l.meta.astrbot,
    };
  }

  procInstance() {
    if (!this.proc) this.proc = new ManagedProcess({ name: 'astrbot', logDir: this.paths.logs });
    if (!this.wired) {
      this.wired = true;
      this.proc.on('line', (entry) => this.onLine(entry));
    }
    return this.proc;
  }

  onLine(entry) {
    const text = entry.text || '';
    const pwd = /Initial password:\s*(\S+)/i.exec(text);
    const user = /Initial username:\s*(\S+)/i.exec(text);
    if (pwd) {
      this.credentials = {
        user: user ? user[1] : 'astrbot',
        password: pwd[1],
        at: Date.now(),
      };
      this.store.data.secrets.astrbotPassword = pwd[1];
      this.store.save().catch(() => {});
      this.emit('astrbot:credentials', this.credentials);
    }
    if (/Uvicorn running|Application startup complete/i.test(text)) {
      this.emit('astrbot:ready', { text });
    }
  }

  /**
   * 预置面板账号密码：在首次启动前把 data/cmd_config.json 的 dashboard 段写好，
   * 这样密码由启动器决定（可显示、可复制、可一键登录），而不是 AstrBot 随机生成后只打印一次。
   * AstrBot 载入配置时会把缺失的键用默认值补齐，所以这里写局部配置是安全的。
   */
  async ensureCredentials({ onProgress = () => {} } = {}) {
    const file = path.join(this.paths.data, 'cmd_config.json');
    const existing = u.readJson(file, null);
    const dash = existing && typeof existing.dashboard === 'object' ? existing.dashboard : null;
    if (dash && (dash.pbkdf2_password || dash.password)) {
      return { ok: true, existing: true, password: this.store.data.secrets.astrbotPassword || '' };
    }
    let password = this.store.data.secrets.astrbotPassword;
    if (!password || password.length < 8) {
      password = generateDashboardPassword();
    }
    const cfg = existing && typeof existing === 'object' ? existing : {};
    cfg.dashboard = {
      ...(cfg.dashboard || {}),
      username: (cfg.dashboard && cfg.dashboard.username) || 'astrbot',
      password: md5Hex(password),
      pbkdf2_password: hashDashboardPassword(password),
      password_storage_upgraded: true,
      password_change_required: false,
      host: '127.0.0.1',
      port: Number(this.store.data.ports.astrbotWebui) || 6185,
    };
    const bom = u.exists(file) ? u.hasBom(file) : true;
    await u.writeJsonAtomic(file, cfg, { bom });
    this.store.data.secrets.astrbotPassword = password;
    await this.store.save();
    this.credentials = { user: 'astrbot', password, at: Date.now() };
    onProgress({ service: 'astrbot', phase: 'credentials', percent: 100, message: '已预置 AstrBot 面板账号密码' });
    return { ok: true, password };
  }

  // ---------------------------------------------------------------- 检测
  async installedInfo() {
    const { app, instance, venv, meta } = this.paths;
    const installed = u.exists(path.join(app, 'main.py')) && u.exists(path.join(app, 'astrbot'));
    const version = installed ? this.readVersion(app) : '';
    const metaInfo = u.readJson(meta, null) || {};
    const python = venvPython(venv);
    const hasVenv = u.exists(python);
    return {
      installed,
      version,
      tag: metaInfo.tag || (version ? `v${version}` : ''),
      installedAt: metaInfo.installedAt || 0,
      appDir: app,
      instanceDir: instance,
      venvDir: venv,
      venvPython: python,
      hasVenv,
      hasData: u.exists(path.join(instance, 'data', 'cmd_config.json')),
      hasDashboard: u.exists(path.join(instance, 'data', 'dist', 'index.html')),
      python: this.store.data.python,
      credentials: this.credentials || (this.store.data.secrets.astrbotPassword
        ? { user: 'astrbot', password: this.store.data.secrets.astrbotPassword, at: 0 }
        : null),
      lastPhase: this.lastPhase,
    };
  }

  readVersion(appDir) {
    try {
      const init = fs.readFileSync(path.join(appDir, 'astrbot', '__init__.py'), 'utf8');
      const match = /__version__\s*=\s*["']([^"']+)["']/.exec(init);
      if (match) return match[1];
    } catch { /* ignore */ }
    try {
      const pyproject = fs.readFileSync(path.join(appDir, 'pyproject.toml'), 'utf8');
      const match = /^\s*version\s*=\s*["']([^"']+)["']/m.exec(pyproject);
      if (match) return match[1];
    } catch { /* ignore */ }
    return '';
  }

  async releases({ force = false } = {}) {
    const list = await netlib.listReleases(REPO, { mirrors: this.store.mirrorPrefixes(), limit: 30, force });
    return list.map((r) => ({
      tag: r.tag_name,
      name: r.name || r.tag_name,
      publishedAt: r.published_at,
      prerelease: netlib.isPrereleaseTag(r.tag_name),
      notes: String(r.body || '').slice(0, 4000),
      dashboardAsset: (r.assets || []).find((a) => /dashboard\.zip$/i.test(a.name))
        ? {
          name: (r.assets || []).find((a) => /dashboard\.zip$/i.test(a.name)).name,
          size: (r.assets || []).find((a) => /dashboard\.zip$/i.test(a.name)).size,
          url: (r.assets || []).find((a) => /dashboard\.zip$/i.test(a.name)).browser_download_url,
        }
        : null,
    }));
  }

  async plan({ tag = '', channel = '' } = {}) {
    const releases = await this.releases();
    const chan = channel || this.store.data.install.astrbotChannel || 'stable';
    const release = netlib.pickRelease(
      releases.map((r) => ({ ...r, tag_name: r.tag })),
      { channel: chan, tag },
    );
    if (!release) throw new Error(tag ? `未找到版本 ${tag}` : '没有可用的 AstrBot 发行版');
    const full = releases.find((r) => r.tag === release.tag_name);
    return {
      tag: release.tag_name,
      name: release.name,
      publishedAt: release.publishedAt,
      prerelease: release.prerelease,
      notes: release.notes,
      dashboardAsset: full ? full.dashboardAsset : null,
      sourceUrls: [
        `https://codeload.github.com/${REPO}/zip/refs/tags/${release.tag_name}`,
        `https://github.com/${REPO}/archive/refs/tags/${release.tag_name}.zip`,
      ],
      channel: chan,
    };
  }

  // ---------------------------------------------------------------- 安装 / 更新
  async downloadSource(plan, onProgress) {
    const dest = path.join(this.paths.downloads, `AstrBot-${plan.tag}.zip`);
    onProgress({
      service: 'astrbot',
      phase: 'download',
      percent: 0,
      message: `下载 AstrBot ${plan.tag} 源码包（缓存到 ${this.paths.downloads}）`,
      detail: dest,
      target: this.paths.app,
    });
    await netlib.downloadFile({
      urls: plan.sourceUrls,
      dest,
      mirrors: this.store.mirrorPrefixes(),
      onProgress: (p) => onProgress({ service: 'astrbot', phase: 'download', ...p, indeterminate: !p.total }),
    });
    return dest;
  }

  async extractSource(zipPath, onProgress) {
    const tmp = path.join(this.paths.downloads, `extract-astrbot-${Date.now()}`);
    await u.rmrf(tmp);
    await u.ensureDir(tmp);
    onProgress({ service: 'astrbot', phase: 'extract', percent: 0, message: '解压源码包…', detail: tmp });
    await extractZip(zipPath, tmp, { onProgress: (p) => onProgress({ service: 'astrbot', phase: 'extract', ...p }) });
    const root = await detectSingleRoot(tmp);
    if (!u.exists(path.join(root, 'main.py'))) throw new Error('源码包结构异常：未找到 main.py');
    return { tmp, root };
  }

  async swapCode(root) {
    const appDir = this.paths.app;
    const backup = `${appDir}.bak`;
    await u.rmrf(backup);
    if (u.exists(appDir)) await fsp.rename(appDir, backup);
    await u.ensureDir(path.dirname(appDir));
    await fsp.rename(root, appDir);
    await u.rmrf(backup);
  }

  async ensurePython() {
    const configured = this.store.data.python.launcher;
    if (configured && u.exists(configured.split(' ')[0])) return configured;
    const { usable, all } = await detectPythons();
    if (!usable.length) {
      const found = all.map((p) => `${p.exe} (${p.version})`).join('、') || '无';
      throw new Error(`AstrBot 需要 Python 3.12 及以上版本，当前未检测到可用解释器。已发现：${found}`);
    }
    const chosen = usable[0];
    this.store.data.python = { launcher: chosen.exe, version: chosen.version };
    await this.store.save();
    return chosen.exe;
  }

  /** 创建虚拟环境（已存在则跳过）。 */
  async ensureVenv({ onProgress = () => {} } = {}) {
    const { venv, venvPython: py } = this.paths;
    if (u.exists(py)) return py;
    const python = await this.ensurePython();
    onProgress({ service: 'astrbot', phase: 'venv', percent: 0, message: `创建虚拟环境：${venv}`, detail: `Python：${python}` });
    await u.ensureDir(this.paths.instance);
    const args = ['-m', 'venv', venv];
    const res = await u.runStreaming(python, args, {
      env: { PYTHONUTF8: '1' },
      onLine: (stream, line) => onProgress({ service: 'astrbot', phase: 'venv', percent: 20, message: line }),
      timeoutMs: 600000,
    });
    if (res.code !== 0 || !u.exists(py)) {
      const detail = (res.tail || []).slice(-4).join(' / ') || (res.error && res.error.message) || `退出码 ${res.code}`;
      throw new Error(`创建虚拟环境失败（${python}）：${detail}`);
    }
    onProgress({ service: 'astrbot', phase: 'venv', percent: 100, message: '虚拟环境创建完成' });
    return py;
  }

  /** 安装 requirements.txt（多镜像自动回退）。 */
  async pipInstall({ onProgress = () => {}, upgrade = false } = {}) {
    const py = await this.ensureVenv({ onProgress });
    const requirements = path.join(this.paths.app, 'requirements.txt');
    if (!u.exists(requirements)) throw new Error('未找到 requirements.txt，请先安装 AstrBot 源码。');
    const indexes = [this.store.data.pip.index, ...(this.store.data.pip.indexes || [])].filter(Boolean);
    const unique = [...new Set(indexes)];
    let lastError = '';

    for (const index of unique) {
      onProgress({ service: 'astrbot', phase: 'pip', percent: 5, message: `安装 Python 依赖（源：${index}）…`, indeterminate: true });
      const collected = { collected: 0, downloaded: 0, installed: 0 };
      const res = await u.runStreaming(py, [
        '-m', 'pip', 'install', '--disable-pip-version-check', '--progress-bar', 'off',
        ...(upgrade ? ['--upgrade'] : []),
        '-r', requirements,
        '-i', index,
      ], {
        cwd: this.paths.instance,
        env: { PIP_DISABLE_PIP_VERSION_CHECK: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
        onLine: (stream, line) => {
          if (/^Collecting\s/i.test(line)) collected.collected += 1;
          else if (/^Downloading\s/i.test(line)) collected.downloaded += 1;
          else if (/^Installing collected packages/i.test(line)) collected.installed = 1;
          const clean = line.replace(/^[A-Za-z ]*:\s*/, '').slice(0, 160);
          onProgress({
            service: 'astrbot',
            phase: 'pip',
            percent: Math.min(95, 5 + collected.downloaded * 1.2),
            message: clean || '安装依赖中…',
            detail: `已处理 ${collected.collected} 个包`,
            indeterminate: true,
          });
        },
        timeoutMs: 0,
      });
      if (res.code === 0) {
        // 确保依赖写回配置文件里也记录当前可用源
        this.store.data.pip.index = index;
        await this.store.save();
        onProgress({ service: 'astrbot', phase: 'pip', percent: 100, message: '依赖安装完成' });
        return { ok: true, index };
      }
      lastError = (res.tail || []).slice(-6).join('\n');
      onProgress({ service: 'astrbot', phase: 'pip', percent: 0, message: `该源安装失败，尝试下一个源…`, detail: lastError.slice(0, 300) });
    }
    throw new Error(`依赖安装失败：\n${lastError}`);
  }

  /** 预置/更新面板静态资源到 <data>/dist（官方 registry 常不可用，这里优先用 GitHub release 资产）。 */
  async ensureDashboard({ tag = '', onProgress = () => {}, force = false } = {}) {
    const distIndex = path.join(this.paths.data, 'dist', 'index.html');
    if (u.exists(distIndex) && !force) return { ok: true, skipped: true, dist: path.join(this.paths.data, 'dist') };
    let asset = null;
    const effectiveTag = tag || (await this.installedInfo()).tag;
    if (effectiveTag) {
      try {
        const releases = await this.releases();
        const found = releases.find((r) => r.tag === effectiveTag);
        if (found && found.dashboardAsset) asset = found.dashboardAsset;
      } catch { /* 忽略：稍后走 registry */ }
    }
    const urls = [];
    if (asset) urls.push(asset.url);
    if (effectiveTag) urls.push(REGISTRY_DASHBOARD(effectiveTag));
    if (!urls.length) return { ok: false, error: '无法确定面板资源地址' };
    const dest = path.join(this.paths.downloads, `AstrBot-dashboard-${effectiveTag}.zip`);
    try {
      onProgress({ service: 'astrbot', phase: 'dashboard', percent: 10, message: '下载 WebUI 面板资源…', indeterminate: true });
      await netlib.downloadFile({
        urls,
        dest,
        mirrors: this.store.mirrorPrefixes(),
        expectedSize: asset ? asset.size : 0,
        onProgress: (p) => onProgress({ service: 'astrbot', phase: 'dashboard', ...p, indeterminate: true }),
      });
      const tmp = path.join(this.paths.downloads, `extract-dashboard-${Date.now()}`);
      await u.rmrf(tmp);
      await u.ensureDir(tmp);
      await extractZip(dest, tmp, { onProgress: () => {} });
      // 兼容两种结构：zip 内含 dist/，或直接就是静态文件
      const hasDist = u.exists(path.join(tmp, 'dist', 'index.html'));
      const source = hasDist ? path.join(tmp, 'dist') : (await detectSingleRoot(tmp));
      const target = path.join(this.paths.data, 'dist');
      await u.rmrf(target);
      await fsp.rename(source, target);
      await u.rmrf(tmp);
      onProgress({ service: 'astrbot', phase: 'dashboard', percent: 100, message: '面板资源就绪' });
      return { ok: true, dist: target };
    } catch (error) {
      onProgress({ service: 'astrbot', phase: 'dashboard', percent: 0, message: `面板资源下载失败：${error.message}`, detail: 'AstrBot 启动时会再尝试自动下载' });
      return { ok: false, error: error.message };
    }
  }

  async install({ tag = '', onProgress = () => {}, withDeps = true } = {}) {
    const plan = await this.plan({ tag });
    const zipPath = await this.downloadSource(plan, onProgress);
    const { tmp, root } = await this.extractSource(zipPath, onProgress);
    onProgress({ service: 'astrbot', phase: 'install', percent: 96, message: `写入程序目录：${this.paths.app}` });
    await this.swapCode(root);
    await u.rmrf(tmp);
    const version = this.readVersion(this.paths.app);
    await u.writeJsonAtomic(this.paths.meta, { tag: plan.tag, version, installedAt: Date.now() });
    await u.ensureDir(this.paths.instance);
    await u.ensureDir(path.join(this.paths.data));
    if (withDeps) await this.pipInstall({ onProgress });
    await this.ensureDashboard({ tag: plan.tag, onProgress });
    await this.ensureCredentials({ onProgress });
    onProgress({
      service: 'astrbot',
      phase: 'done',
      percent: 100,
      message: `AstrBot ${version || plan.tag} 安装完成 → ${this.paths.app}`,
      detail: `数据目录：${this.paths.data}`,
    });
    return { ok: true, tag: plan.tag, version, appDir: this.paths.app };
  }

  async update({ onProgress = () => {} } = {}) {
    const info = await this.installedInfo();
    if (!info.installed) return this.install({ onProgress });
    const wasRunning = this.isRunning();
    const plan = await this.plan({ tag: this.store.data.install.astrbotTag || '' });
    if (info.version && plan.tag === `v${info.version}`) {
      onProgress({ service: 'astrbot', phase: 'done', percent: 100, message: `已是最新版本 ${plan.tag}` });
      return { ok: true, upToDate: true, version: info.version, tag: plan.tag };
    }
    if (wasRunning) await this.stop();
    const zipPath = await this.downloadSource(plan, onProgress);
    const { tmp, root } = await this.extractSource(zipPath, onProgress);
    await this.swapCode(root);
    await u.rmrf(tmp);
    const version = this.readVersion(this.paths.app);
    await u.writeJsonAtomic(this.paths.meta, { tag: plan.tag, version, installedAt: Date.now(), updatedFrom: info.version });
    onProgress({ service: 'astrbot', phase: 'pip', percent: 5, message: '同步依赖（requirements 可能变化）…', indeterminate: true });
    await this.pipInstall({ onProgress });
    await this.ensureDashboard({ tag: plan.tag, onProgress, force: false });
    if (wasRunning && this.store.data.runtime.restartOnUpdate) {
      onProgress({ service: 'astrbot', phase: 'restart', percent: 100, message: '重启 AstrBot…' });
      await this.start();
    }
    onProgress({ service: 'astrbot', phase: 'done', percent: 100, message: `已更新到 ${plan.tag}（数据完整保留）` });
    return { ok: true, tag: plan.tag, version, from: info.version };
  }

  // ---------------------------------------------------------------- 运行
  isRunning() {
    return Boolean(this.proc && this.proc.running);
  }

  effectiveWebuiPort() {
    const cfg = u.readJson(path.join(this.paths.data, 'cmd_config.json'), null);
    const port = cfg && cfg.dashboard && Number(cfg.dashboard.port);
    return Number.isFinite(port) && port > 0 ? port : Number(this.store.data.ports.astrbotWebui) || 6185;
  }

  async start({ onProgress = () => {}, resetPassword = false } = {}) {
    const info = await this.installedInfo();
    if (!info.installed) throw new Error('尚未安装 AstrBot，请先点击"下载安装"。');
    if (!info.hasVenv) {
      throw new Error('尚未创建 Python 虚拟环境（可能依赖未安装完成）。请重新执行安装或点击"修复依赖"。');
    }
    if (this.isRunning()) return { ok: true, already: true };
    if (!resetPassword) await this.ensureCredentials({ onProgress }).catch(() => {});
    const port = this.effectiveWebuiPort();
    const existing = await u.httpProbe(`http://127.0.0.1:${port}/`);
    if (existing.ok) {
      onProgress({ service: 'astrbot', phase: 'done', percent: 100, message: `检测到已有 AstrBot 实例在 127.0.0.1:${port} 运行，直接接管显示` });
      return { ok: true, external: true, port, url: `http://127.0.0.1:${port}/` };
    }
    const env = {
      ASTRBOT_ROOT: this.paths.instance,
      DASHBOARD_PORT: String(port),
      DASHBOARD_HOST: '127.0.0.1',
      PYTHONUNBUFFERED: '1',
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    };
    const args = [path.join(this.paths.app, 'main.py')];
    if (resetPassword) args.push('--reset-password');
    const proc = this.procInstance();
    await proc.start({ exe: info.venvPython, args, cwd: this.paths.instance, env, label: 'AstrBot' });

    onProgress({ service: 'astrbot', phase: 'ready-wait', percent: 60, message: `等待 AstrBot 面板（127.0.0.1:${port}）就绪…`, indeterminate: true });
    const probe = await u.waitForHttp(`http://127.0.0.1:${port}/`, { timeoutMs: 180000 });
    if (!proc.running && !probe.ok) {
      const tail = proc.recent(30).map((l) => l.text).join('\n');
      throw new Error(`AstrBot 启动失败。最近日志：\n${tail}`);
    }
    if (probe.ok) onProgress({ service: 'astrbot', phase: 'done', percent: 100, message: 'AstrBot 已就绪' });
    return { ok: true, port, ready: probe.ok };
  }

  async stop() {
    if (!this.proc) return { ok: true, already: true };
    return this.proc.stop({ timeoutMs: 6000 });
  }

  async restart(options = {}) {
    await this.stop();
    await u.sleep(800);
    return this.start(options);
  }

  async resetPasswordFlow({ onProgress = () => {} } = {}) {
    const wasRunning = this.isRunning();
    if (wasRunning) await this.stop();
    this.credentials = null;
    await this.start({ onProgress, resetPassword: true });
    // 等日志里出现新密码
    for (let i = 0; i < 40 && !this.credentials; i += 1) await u.sleep(500);
    return { ok: Boolean(this.credentials), credentials: this.credentials };
  }

  async status() {
    const info = await this.installedInfo();
    const port = this.effectiveWebuiPort();
    const probe = await u.httpProbe(`http://127.0.0.1:${port}/`);
    return {
      installed: info.installed,
      version: info.version,
      tag: info.tag,
      running: this.isRunning(),
      external: !this.isRunning() && probe.ok,
      pid: this.proc ? this.proc.pid : 0,
      port,
      url: `http://127.0.0.1:${port}/`,
      webuiReady: probe.ok,
      hasVenv: info.hasVenv,
      hasData: info.hasData,
      hasDashboard: info.hasDashboard,
      appDir: info.appDir,
      instanceDir: info.instanceDir,
      venvDir: info.venvDir,
      python: this.store.data.python,
      credentials: this.credentials || (this.store.data.secrets.astrbotPassword
        ? { user: 'astrbot', password: this.store.data.secrets.astrbotPassword, at: 0 }
        : null),
    };
  }

  /** 写入 OneBot v11（aiocqhttp）反向 WS 平台配置。 */
  async writeBridgeConfig({ port, host = '127.0.0.1', token = '' } = {}) {
    const file = path.join(this.paths.data, 'cmd_config.json');
    if (!u.exists(file)) {
      return { ok: false, needsFirstRun: true, error: 'AstrBot 还未首次启动，配置文件尚未生成。请先启动一次 AstrBot。' };
    }
    const cfg = u.readJson(file, null);
    if (!cfg || typeof cfg !== 'object') return { ok: false, error: '无法解析 data/cmd_config.json（文件可能正在被写入，稍后重试）' };
    const bom = u.hasBom(file);
    const effectivePort = Number(port) || Number(this.store.data.ports.astrbotReverseWs) || 6199;
    const entry = {
      id: 'default',
      type: 'aiocqhttp',
      enable: true,
      ws_reverse_host: host,
      ws_reverse_port: effectivePort,
      ws_reverse_token: token || '',
    };
    if (!Array.isArray(cfg.platform)) cfg.platform = [];
    const index = cfg.platform.findIndex((p) => p && p.type === 'aiocqhttp');
    if (index >= 0) cfg.platform[index] = { ...cfg.platform[index], ...entry };
    else cfg.platform.push(entry);
    // 顺带把面板端口/主机固定成本机可用的值
    if (!cfg.dashboard || typeof cfg.dashboard !== 'object') cfg.dashboard = {};
    if (!cfg.dashboard.port) cfg.dashboard.port = Number(this.store.data.ports.astrbotWebui) || 6185;
    cfg.dashboard.host = '127.0.0.1';
    await u.writeJsonAtomic(file, cfg, { bom });
    return { ok: true, file, entry, restartRequired: true };
  }

  /** 通过面板 API 登录，拿到 JWT 供一键登录使用。 */
  async login({ password = '', username = 'astrbot' } = {}) {
    const pwd = password || this.store.data.secrets.astrbotPassword;
    if (!pwd) return { ok: false, error: '尚未记录 AstrBot 面板密码，请先重置密码' };
    const port = this.effectiveWebuiPort();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: pwd }),
        signal: controller.signal,
      });
      const json = await res.json().catch(() => null);
      if (json && json.status === 'ok' && json.data && json.data.token) {
        return {
          ok: true,
          token: json.data.token,
          username: json.data.username || username,
          changePwdHint: Boolean(json.data.change_pwd_hint),
        };
      }
      return { ok: false, error: (json && json.message) || `HTTP ${res.status}` };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    } finally {
      clearTimeout(timer);
    }
  }

  logLines(n = 400) {
    return this.proc ? this.proc.recent(n) : [];
  }

  clearLogs() {
    if (this.proc) this.proc.clear();
  }
}

module.exports = { AstrBotService, REPO, venvPython };
