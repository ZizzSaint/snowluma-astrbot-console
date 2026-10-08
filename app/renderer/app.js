'use strict';
/* 渲染层逻辑：纯原生 JS，不依赖任何框架。状态全部来自主进程 IPC。 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  data: null,
  releases: { snowluma: null, astrbot: null },
  page: 'home',
  logs: { snowluma: [], astrbot: [] },
  logTab: 'snowluma',
  progress: { snowluma: null, astrbot: null },
  busy: { snowluma: false, astrbot: false },
};

const MAX_LOG_LINES = 4000;

/* ------------------------------------------------------------------ 工具 */
function toast(message, level = 'info', timeout = 5200) {
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, timeout);
}

function notify(level, message, title = '提示') {
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.innerHTML = `<b>${escapeHtml(title)}</b><br />${escapeHtml(String(message)).replace(/\n/g, '<br />')}`;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 8000);
}

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1048576) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1073741824) return `${(v / 1048576).toFixed(1)} MB`;
  return `${(v / 1073741824).toFixed(2)} GB`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function row(k, v) {
  return `<div class="row"><span class="k">${escapeHtml(k)}</span><span class="v">${v}</span></div>`;
}

function modal(title, html) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal').classList.remove('hidden');
}

let modalResolve = null;

function closeModal() {
  $('#modal').classList.add('hidden');
  if (modalResolve) {
    const resolve = modalResolve;
    modalResolve = null;
    resolve(false);
  }
}

/** 通用确认框（Promise<boolean>），关闭按钮/点遮罩都算取消。 */
function confirmDialog(title, html, okText = '继续') {
  return new Promise((resolve) => {
    modal(title, `${html}
      <div class="modal-actions">
        <button class="btn primary" id="modal-ok">${escapeHtml(okText)}</button>
        <button class="btn ghost" id="modal-cancel">取消</button>
      </div>`);
    const finish = (value) => {
      modalResolve = null;
      closeModal();
      resolve(value);
    };
    modalResolve = () => finish(false);
    $('#modal-ok').onclick = () => finish(true);
    $('#modal-cancel').onclick = () => finish(false);
  });
}

async function copyText(text, label = '已复制') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label, 'ok', 2000);
  } catch {
    modal('手动复制', `<p>无法访问剪贴板，请手动复制：</p><div class="cred">${escapeHtml(text)}</div>`);
  }
}

/* ------------------------------------------------------------------ 页面切换 */
function gotoPage(page) {
  state.page = page;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach((s) => s.classList.toggle('active', s.id === `page-${page}`));
  const titles = {
    home: '总览', snowluma: 'SnowLuma 控制台', astrbot: 'AstrBot 控制台',
    bridge: '桥接教程', logs: '运行日志', settings: '设置',
  };
  $('#page-title').textContent = titles[page] || page;
  if (page === 'snowluma' || page === 'astrbot') syncWebview(page);
  if (page === 'logs') renderLogs();
  if (page === 'settings') fillSettings();
  if (page === 'bridge') renderBridgePrecheck();
  try { window.launcher.settings.patch({ ui: { lastPage: page } }); } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ 状态刷新 */
async function refresh({ withReleases = false } = {}) {
  try {
    const data = await window.launcher.state({ withReleases });
    state.data = data;
    state.busy = data.busy || state.busy;
    render();
  } catch (error) {
    toast(`获取状态失败：${error.message}`, 'error');
  }
}

function renderQqFreeze(d) {
  const info = d.qqFreeze || {};
  const badge = info.frozen ? '<span class="badge ok">已冻结</span>' : '<span class="badge warn">未冻结</span>';
  const detail = !info.ok
    ? `<span style="color:var(--err)">${escapeHtml(info.error || '无法读取 hosts 文件')}</span>`
    : info.frozen
      ? (info.ours
        ? '已由本应用冻结：QQ 无法自动更新（hosts 中已加入标记块，可随时解除）。'
        : '<span style="color:var(--warn)">hosts 中已存在他人写入的冻结记录，本应用不会改动它。</span>')
      : 'QQ 升级到 SnowLuma hook 尚不支持的新版本时，注入可能失败。建议在 QQ 版本确认可用后冻结自动更新。';
  for (const [id, hintId] of [['qq-freeze-badge', 'qq-freeze-hint'], ['qq-freeze-badge2', 'qq-freeze-hint2']]) {
    const el = document.getElementById(id);
    if (el) el.outerHTML = badge.replace('class="badge', `id="${id}" class="badge`);
    const hint = document.getElementById(hintId);
    if (hint) {
      hint.innerHTML = `${detail}<br />hosts：<code>${escapeHtml(info.hostsPath || '')}</code>　目标域名：<code>${escapeHtml((info.domains || []).join('、'))}</code>`;
    }
  }
  for (const id of ['btn-freeze-qq', 'btn-freeze-qq2']) {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = Boolean(info.frozen);
  }
  for (const id of ['btn-unfreeze-qq', 'btn-unfreeze-qq2']) {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !info.ours;
  }
}

/** 安装位置提示：把"会装到哪里"直接摆在卡片上 */
function installPaths(name, d) {
  const root = d.app.dataRoot;
  if (name === 'snowluma') {
    return [
      { label: '程序目录', value: d.snowluma.appDir, note: 'index.mjs / native / client（更新时整体替换）' },
      { label: '数据目录', value: d.snowluma.instanceDir, note: 'config/、data/、日志（更新不会动）' },
      { label: '下载缓存', value: `${root}\\downloads`, note: '安装包与断点续传文件' },
    ];
  }
  return [
    { label: '程序目录', value: d.astrbot.appDir, note: 'AstrBot 源码（更新时整体替换）' },
    { label: '数据目录', value: d.astrbot.instanceDir, note: 'data/：配置、插件、数据库、面板 dist' },
    { label: '虚拟环境', value: d.astrbot.venvDir || `${d.astrbot.instanceDir}\\venv`, note: 'Python 依赖（约 0.5 GB）' },
    { label: '下载缓存', value: `${root}\\downloads`, note: '源码包与面板资源缓存' },
  ];
}

function renderPathBox(name, d) {
  const box = $(`#paths-${name}`);
  if (!box) return;
  const rows = installPaths(name, d).map((item) => `
    <div class="path-row">
      <span class="plabel">${escapeHtml(item.label)}</span>
      <span class="pvalue" title="${escapeHtml(item.value)}">${escapeHtml(item.value)}</span>
      <button class="btn ghost" data-open-path="${escapeHtml(item.value)}">打开</button>
      <button class="btn ghost" data-copy="${escapeHtml(item.value)}">复制</button>
    </div>`);
  box.innerHTML = `<div class="path-note">安装位置（数据与程序分开，更新只替换程序目录）：</div>${rows.join('')}
    <div class="path-note">根目录：<code>${escapeHtml(d.app.dataRoot)}</code> —— 可在「设置 → 目录」修改或整体迁移。</div>`;
}

/** 安装前先告诉用户会装到哪里，并让他确认 */
async function confirmInstall(name) {
  const d = state.data;
  const label = name === 'snowluma' ? 'SnowLuma' : 'AstrBot';
  const rows = installPaths(name, d)
    .map((item) => `<div class="path-item"><b>${escapeHtml(item.label)}</b><code>${escapeHtml(item.value)}</code>
      <div class="path-note" style="margin-top:4px">${escapeHtml(item.note)}</div></div>`)
    .join('');
  return confirmDialog(
    `确认 ${label} 的安装位置`,
    `<p>即将安装 <b>${escapeHtml(label)}</b>。程序与数据分开存放，之后更新只替换程序目录，数据不会丢：</p>
     <div class="path-list">${rows}</div>
     <div class="hint">如果不希望装在当前磁盘，先点「取消」，到「设置 → 目录」里改数据根目录（或做一次数据目录迁移）再安装。</div>`,
    '开始下载安装',
  );
}

function render() {
  const d = state.data;
  if (!d) return;
  renderHeader(d);
  renderEnv(d);
  renderQqFreeze(d);
  renderBridgeSummary(d);
  renderService('snowluma', d);
  renderService('astrbot', d);
  renderQuick();
  renderBridgePrecheck();
  fillSettings();
  syncWebview('snowluma');
  syncWebview('astrbot');
}

function renderHeader(d) {
  const qq = d.qq || {};
  $('#chip-qq').textContent = qq.installed ? `QQ ${qq.version || '已安装'} (${qq.arch || '?'})` : 'QQ：未检测到';
  $('#foot-summary').innerHTML = `SnowLuma ${d.snowluma.installed ? escapeHtml(d.snowluma.version || '已装') : '未安装'} ·
    AstrBot ${d.astrbot.installed ? escapeHtml(d.astrbot.version || '已装') : '未安装'}<br />数据目录：${escapeHtml(d.app.dataRoot)}`;
}

function renderEnv(d) {
  const qq = d.qq || {};
  const node = d.systemNode;
  const sl = d.snowluma;
  const rows = [
    row('QQ（NTQQ）', qq.installed
      ? `<b>${escapeHtml(qq.version || '未知版本')}</b> · ${escapeHtml(qq.arch || '')} · <code>${escapeHtml(qq.dir || '')}</code>`
      : '<span style="color:var(--warn)">未检测到桌面版 QQ</span>'),
    row('系统 Node.js', node ? `${escapeHtml(node.version)} · <code>${escapeHtml(node.exe)}</code>` : '<span style="color:var(--warn)">未检测到</span>'),
    row('SnowLuma 运行时', sl.node ? `${escapeHtml(sl.node.version || '')} · ${escapeHtml(sl.node.source || '')} ${sl.nodeOk ? '<span style="color:var(--ok)">可用</span>' : '<span style="color:var(--err)">不满足要求</span>'}` : '—'),
    row('Python', d.settings.python && d.settings.python.launcher ? `${escapeHtml(d.settings.python.version || '')} · <code>${escapeHtml(d.settings.python.launcher)}</code>` : '<span style="color:var(--text-faint)">安装 AstrBot 时自动选择</span>'),
    row('数据目录', `<code>${escapeHtml(d.app.dataRoot)}</code>`),
  ];
  $('#env-kv').innerHTML = rows.join('');
  const qqHint = !qq.installed
    ? '未检测到桌面版 QQ：SnowLuma 需要注入桌面版 QQ 才能登录，请先安装 QQ NT 版。'
    : `SnowLuma 的 hook 与本机 QQ 版本绑定（当前 ${escapeHtml(qq.version || '未知')}）。若注入失败：先在「设置」里冻结 QQ 自动更新，或在总览页切换到其它 SnowLuma 版本重试。`;
  $('#qq-hint').innerHTML = qqHint;
  $('#qq-kv').innerHTML = [
    row('QQ 版本', escapeHtml(qq.version || '未知')),
    row('架构', escapeHtml(qq.arch || '未知')),
    row('安装目录', `<code>${escapeHtml(qq.dir || '—')}</code>`),
    row('检测方式', escapeHtml(qq.source || '—')),
  ].join('');
}

function serviceBadge(s) {
  if (!s.installed) return '<span class="badge">未安装</span>';
  if (s.running && s.webuiReady) return '<span class="badge ok">运行中</span>';
  if (s.external) return '<span class="badge ok">运行中（外部实例）</span>';
  if (s.running) return '<span class="badge warn">启动中</span>';
  return `<span class="badge">已安装 ${escapeHtml(s.version || '')}</span>`;
}

function renderService(name, d) {
  const s = d[name];
  const other = name === 'snowluma' ? 'astrbot' : 'snowluma';
  $(`#badge-${name}`).outerHTML = serviceBadge(s).replace('class="badge', `id="badge-${name}" class="badge`);
  const dot = $(`#dot-${name}`);
  if (dot) {
    dot.className = `dot${s.running && s.webuiReady ? ' on' : ''}`;
  }

  const rows = [];
  rows.push(row('版本', s.installed ? `<b>${escapeHtml(s.version || '未知')}</b>${s.tag ? ` · ${escapeHtml(s.tag)}` : ''}` : '—'));
  rows.push(row('运行状态', !s.installed
    ? '<span style="color:var(--text-faint)">未安装</span>'
    : (s.running
      ? (s.webuiReady ? '<span style="color:var(--ok)">运行中（控制台可访问）</span>' : '<span style="color:var(--warn)">进程已启动，等待控制台就绪…</span>')
      : (s.external
        ? '<span style="color:var(--ok)">运行中（外部实例，非本应用启动，可直接使用）</span>'
        : '<span style="color:var(--text-faint)">已停止</span>'))));
  rows.push(row('控制台', `${escapeHtml(s.url || '')} <button class="link-btn" data-copy="${escapeHtml(s.url || '')}">复制</button>`));
  if (name === 'snowluma') {
    rows.push(row('登录状态', s.login ? `<span style="color:var(--ok)">已登录 ${escapeHtml(s.login.nickname || '')} (${escapeHtml(s.login.uin || '')})</span>` : (s.webuiReady ? '<span style="color:var(--warn)">等待 QQ 扫码登录</span>' : '—')));
    if (s.installed) rows.push(row('运行包类型', escapeHtml(s.flavor === 'full' ? '完整版（内置 Node）' : '精简版（使用系统 Node）')));
  } else if (s.installed) {
    rows.push(row('虚拟环境', s.hasVenv ? '<span style="color:var(--ok)">已就绪</span>' : '<span style="color:var(--warn)">未创建</span>'));
    rows.push(row('面板资源', s.hasDashboard ? '<span style="color:var(--ok)">已就绪</span>' : '<span style="color:var(--warn)">未就绪（启动时会自动下载）</span>'));
  }
  rows.push(row('程序目录', `<code>${escapeHtml(s.appDir || '')}</code>`));
  rows.push(row('数据目录', `<code>${escapeHtml(s.instanceDir || '')}</code>`));
  $(`#kv-${name}`).innerHTML = rows.join('');
  renderPathBox(name, d);

  renderInstallOptions(name, d);
  renderActions(name, d);
  renderProgress(name);
}

function renderInstallOptions(name, d) {
  const s = d[name];
  const box = $(`#opts-${name}`);
  const settings = d.settings;
  const releases = state.releases[name];
  const options = [];

  if (name === 'snowluma') {
    const flavor = settings.install.snowlumaFlavor || 'auto';
    options.push(`<label class="opt-note">版本包</label>
      <select id="sel-flavor">
        <option value="auto"${flavor === 'auto' ? ' selected' : ''}>自动（推荐）</option>
        <option value="lite"${flavor === 'lite' ? ' selected' : ''}>精简版（体积小）</option>
        <option value="full"${flavor === 'full' ? ' selected' : ''}>完整版（内置 Node）</option>
      </select>`);
  } else {
    const channel = settings.install.astrbotChannel || 'stable';
    options.push(`<label class="opt-note">更新通道</label>
      <select id="sel-channel">
        <option value="stable"${channel === 'stable' ? ' selected' : ''}>稳定版</option>
        <option value="prerelease"${channel === 'prerelease' ? ' selected' : ''}>含预发布版</option>
      </select>`);
  }

  if (releases && releases.length) {
    const current = name === 'snowluma' ? settings.install.snowlumaTag : settings.install.astrbotTag;
    options.push(`<label class="opt-note">指定版本</label>
      <select id="sel-tag">
        <option value="">最新版本</option>
        ${releases.slice(0, 15).map((r) => `<option value="${escapeHtml(r.tag)}"${current === r.tag ? ' selected' : ''}>${escapeHtml(r.tag)}${r.prerelease ? '（预发布）' : ''} · ${(r.publishedAt || '').slice(0, 10)}</option>`).join('')}
      </select>`);
  } else {
    options.push(`<button class="btn ghost small" data-load-releases="${name}">加载版本列表</button>`);
  }

  options.push(`<span class="opt-note" id="opt-note-${name}">${installNote(name, d)}</span>`);
  box.innerHTML = options.join('');

  const flavorSel = $('#sel-flavor');
  if (flavorSel) {
    flavorSel.addEventListener('change', () => {
      window.launcher.settings.patch({ install: { snowlumaFlavor: flavorSel.value } }).then(() => refresh());
    });
  }
  const channelSel = $('#sel-channel');
  if (channelSel) {
    channelSel.addEventListener('change', () => {
      window.launcher.settings.patch({ install: { astrbotChannel: channelSel.value } }).then(() => refresh());
    });
  }
  const tagSel = $('#sel-tag');
  if (tagSel) {
    tagSel.addEventListener('change', () => {
      const patch = name === 'snowluma' ? { install: { snowlumaTag: tagSel.value } } : { install: { astrbotTag: tagSel.value } };
      window.launcher.settings.patch(patch).then(() => refresh());
    });
  }
}

function installNote(name, d) {
  if (name === 'snowluma') {
    const node = d.snowluma.node;
    if (!d.snowluma.installed) {
      return node && d.snowluma.nodeOk
        ? `检测到系统 Node ${escapeHtml(node.version)}，可直接用精简版（下载体积小）。`
        : '未检测到满足要求的 Node.js，建议使用完整版（内置运行时）。';
    }
    return `已安装 ${escapeHtml(d.snowluma.version || '')}；更新不会影响 config/ 与 data/ 数据。`;
  }
  const pythons = d.settings.python;
  if (!d.astrbot.installed) {
    return pythons && pythons.launcher
      ? `将使用 Python ${escapeHtml(pythons.version || '')}（${escapeHtml(pythons.launcher)}）创建虚拟环境。`
      : '安装时会自动挑选 Python 3.12+ 解释器并创建虚拟环境（依赖较多，请耐心等待）。';
  }
  return `已安装 ${escapeHtml(d.astrbot.version || '')}；更新只替换程序代码，data/ 数据完整保留。`;
}

function renderActions(name, d) {
  const s = d[name];
  const box = $(`#actions-${name}`);
  const busy = state.busy[name];
  const btns = [];
  const dis = busy ? ' disabled' : '';

  if (!s.installed) {
    btns.push(`<button class="btn primary" data-act="install" data-svc="${name}"${dis}>⬇ 下载安装</button>`);
  } else {
    if (s.running) {
      btns.push(`<button class="btn" data-act="stop" data-svc="${name}"${dis}>⏹ 停止</button>`);
      btns.push(`<button class="btn ghost" data-act="restart" data-svc="${name}"${dis}>⟳ 重启</button>`);
    } else if (s.external) {
      btns.push(`<button class="btn" data-act="adopt" data-svc="${name}"${dis}>🔄 重新检测</button>`);
    } else {
      btns.push(`<button class="btn primary" data-act="start" data-svc="${name}"${dis}>▶ 启动</button>`);
    }
    btns.push(`<button class="btn" data-act="update" data-svc="${name}"${dis}>⬆ 更新到最新</button>`);
    if (name === 'astrbot') {
      btns.push(`<button class="btn ghost" data-act="repair" data-svc="${name}"${dis}>🧩 修复依赖</button>`);
    }
    btns.push(`<button class="btn ghost" data-act="reinstall" data-svc="${name}"${dis}>重装</button>`);
  }
  box.innerHTML = btns.join('');
}

function renderProgress(name) {
  const el = $(`#prog-${name}`);
  const p = state.progress[name];
  if (!p || p.done) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const fill = el.querySelector('.progress-fill');
  const text = el.querySelector('.progress-text');
  if (p.indeterminate) {
    fill.classList.add('indeterminate');
  } else {
    fill.classList.remove('indeterminate');
    fill.style.width = `${Math.max(2, Math.min(100, Number(p.percent) || 0))}%`;
  }
  const parts = [p.message || ''];
  if (p.total) parts.push(`${p.percent}% · ${fmtBytes(p.received)} / ${fmtBytes(p.total)}`);
  if (p.speed) parts.push(`${fmtBytes(p.speed)}/s`);
  if (p.detail) parts.push(`(${String(p.detail).slice(0, 120)})`);
  text.textContent = parts.filter(Boolean).join('  ');
}

function renderQuick() {
  const d = state.data;
  if (!d) return;
  const sl = d.snowluma;
  const ab = d.astrbot;
  const hints = [];
  if (!sl.installed) hints.push('SnowLuma 未安装');
  if (!ab.installed) hints.push('AstrBot 未安装');
  if (sl.installed && !sl.running && !sl.external) hints.push('SnowLuma 未运行');
  if (ab.installed && !ab.running && !ab.external) hints.push('AstrBot 未运行');
  if (sl.running && !sl.webuiReady) hints.push('SnowLuma 控制台启动中');
  if (ab.running && !ab.webuiReady) hints.push('AstrBot 控制台启动中');
  $('#quick-hint').textContent = hints.length ? `待处理：${hints.join('、')}` : '两个服务都在运行，可以开始使用了。';
}

function renderBridgeSummary(d) {
  const sl = d.snowluma;
  const ab = d.astrbot;
  const qq = d.qq || {};
  const rows = [
    row('QQ 桌面版', qq.installed ? `<span style="color:var(--ok)">${escapeHtml(qq.version || '已安装')}</span>` : '<span class="badge err">未安装</span>'),
    row('SnowLuma', sl.installed ? (sl.webuiReady ? '<span style="color:var(--ok)">运行中</span>' : '已安装未运行') : '<span class="badge">未安装</span>'),
    row('QQ 登录', sl.login ? `<span style="color:var(--ok)">${escapeHtml(sl.login.nickname || '')} (${escapeHtml(sl.login.uin || '')})</span>` : '<span style="color:var(--text-faint)">未登录 / 未知</span>'),
    row('AstrBot', ab.installed ? (ab.webuiReady ? '<span style="color:var(--ok)">运行中</span>' : '已安装未运行') : '<span class="badge">未安装</span>'),
    row('反向 WS 端口', `<code>${escapeHtml(d.settings.ports.astrbotReverseWs)}</code> → <code>ws://127.0.0.1:${escapeHtml(d.settings.ports.astrbotReverseWs)}/ws</code>`),
  ];
  $('#bridge-kv').innerHTML = rows.join('');
}

function renderBridgePrecheck() {
  const d = state.data;
  if (!d) return;
  const items = [
    [d.qq && d.qq.installed, '已安装桌面版 QQ（NTQQ）', '未检测到桌面版 QQ，请先安装并登录'],
    [d.snowluma.installed, 'SnowLuma 已安装', '请在总览页下载安装 SnowLuma'],
    [d.snowluma.running, 'SnowLuma 正在运行', '请先在总览页启动 SnowLuma'],
    [d.astrbot.installed, 'AstrBot 已安装', '请在总览页下载安装 AstrBot'],
    [d.astrbot.running, 'AstrBot 正在运行', '请先在总览页启动 AstrBot'],
    [d.astrbot.hasData, 'AstrBot 已生成配置（首次启动完成）', '请先启动一次 AstrBot，让它生成 data/cmd_config.json'],
  ];
  $('#bridge-precheck').innerHTML = items.map(([ok, yes, no]) =>
    `<li>${ok ? `<span class="ok">✔</span> ${escapeHtml(yes)}` : `<span class="bad">✘</span> ${escapeHtml(no)}`}</li>`,
  ).join('');
  const portInput = $('#bridge-port');
  if (portInput && !portInput.dataset.touched) portInput.value = d.settings.ports.astrbotReverseWs;
}

/* ------------------------------------------------------------------ 内嵌控制台 */
const webviewState = { snowluma: { loadedUrl: '', listeners: false }, astrbot: { loadedUrl: '', listeners: false } };

function syncWebview(name) {
  const d = state.data;
  if (!d) return;
  const s = d[name];
  const el = $(`#wv-${name}`);
  const ph = $(`#ph-${name}`);
  const ld = $(`#ld-${name}`);
  const urlChip = $(`#url-${name}`);
  if (urlChip) urlChip.textContent = s.url || '';
  if (!el) return;

  if (s.webuiReady) {
    ph.classList.add('hidden');
    el.classList.remove('hidden');
    if (webviewState[name].loadedUrl !== s.url) {
      webviewState[name].loadedUrl = s.url;
      ld.classList.remove('hidden');
      el.src = s.url;
    }
    if (!webviewState[name].listeners) {
      webviewState[name].listeners = true;
      el.addEventListener('did-stop-loading', () => ld.classList.add('hidden'));
      el.addEventListener('did-fail-load', (event) => {
        ld.classList.add('hidden');
        if (event.errorCode !== -3) toast(`${name} 控制台载入失败：${event.errorDescription}（${event.errorCode}）`, 'error');
      });
      el.addEventListener('did-start-loading', () => ld.classList.remove('hidden'));
    }
  } else {
    ph.classList.remove('hidden');
    el.classList.add('hidden');
    ld.classList.add('hidden');
    if (webviewState[name].loadedUrl) {
      webviewState[name].loadedUrl = '';
      try { el.src = 'about:blank'; } catch { /* ignore */ }
    }
  }
}

/* ------------------------------------------------------------------ 日志 */
function appendLogs(service, lines) {
  const arr = state.logs[service];
  for (const line of lines) arr.push(line);
  if (arr.length > MAX_LOG_LINES) arr.splice(0, arr.length - MAX_LOG_LINES);
  if (state.page === 'logs' && state.logTab === service) renderLogs();
}

function renderLogs() {
  const view = $('#log-view');
  const lines = state.logs[state.logTab];
  const autoScroll = $('#log-autoscroll').checked;
  view.innerHTML = lines.map((l) =>
    `<span class="l-${escapeHtml(l.stream)}"><span class="l-ts">${fmtTime(l.ts)}</span> ${escapeHtml(l.text)}</span>`,
  ).join('\n');
  if (autoScroll) view.scrollTop = view.scrollHeight;
}

/* ------------------------------------------------------------------ 设置 */
function renderTrayBadge(d) {
  const el = document.getElementById('tray-badge');
  if (!el) return;
  const tray = (d && d.tray) || {};
  const on = tray.enabled !== false;
  el.className = `badge ${tray.available ? (on ? 'ok' : 'warn') : 'err'}`;
  el.textContent = !tray.available
    ? '托盘不可用'
    : (on ? '关闭窗口 → 托盘' : '关闭窗口 → 直接退出');
}

/** 立即把窗口收进托盘（服务继续运行） */
async function hideToTray() {
  const res = await window.launcher.tray.hide();
  if (res && res.ok) toast('已最小化到托盘，服务继续在后台运行；点托盘图标可恢复窗口', 'ok', 5000);
}

function fillSettings() {
  const d = state.data;
  if (!d || state.page !== 'settings') return;
  const s = d.settings;
  if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
  $('#set-dataRoot').value = s.dataRoot || '';
  $('#set-port-sl').value = s.ports.snowlumaWebui;
  $('#set-port-slhttp').value = s.ports.snowlumaHttp;
  $('#set-port-slws').value = s.ports.snowlumaWs;
  $('#set-port-ab').value = s.ports.astrbotWebui;
  $('#set-port-abws').value = s.ports.astrbotReverseWs;
  $('#set-mirror-enabled').checked = Boolean(s.mirrors.enabled);
  $('#set-mirror-custom').value = s.mirrors.custom || '';
  $('#set-mirror-list').value = (s.mirrors.list || []).join('\n');
  const sel = $('#set-pip-index');
  sel.innerHTML = (s.pip.indexes || []).map((i) => `<option value="${escapeHtml(i)}"${i === s.pip.index ? ' selected' : ''}>${escapeHtml(i)}</option>`).join('');
  $('#set-autostart').checked = Boolean(s.runtime.autostartOnLaunch);
  $('#set-restart-on-update').checked = Boolean(s.runtime.restartOnUpdate);
  $('#set-close-to-tray').checked = s.ui.closeToTray !== false;
  renderTrayBadge(d);
  $('#set-python').value = s.python.launcher || '';
  $('#python-hint').textContent = s.python.version ? `当前记录：Python ${s.python.version}` : '尚未记录 Python，安装 AstrBot 时会自动检测。';
  $('#cred-kv').innerHTML = [
    row('SnowLuma 面板', `admin / <code>${escapeHtml(s.secrets.snowlumaPassword || '（尚未生成，首次启动时自动创建）')}</code>`),
    row('AstrBot 面板', d.astrbot.credentials
      ? `astrbot / <code>${escapeHtml(d.astrbot.credentials.password)}</code>`
      : '初始密码在首次启动时输出，可在工具栏「登录凭据」查看；丢失可点下方重置'),
  ].join('');
  $('#about-kv').innerHTML = [
    row('应用版本', escapeHtml(d.app.version)),
    row('Electron', escapeHtml(d.app.electron)),
    row('Node', escapeHtml(d.app.node)),
    row('平台', `${escapeHtml(d.app.platform)} / ${escapeHtml(d.app.arch)}`),
    row('配置目录', `<code>${escapeHtml(d.app.baseDir)}</code>`),
  ].join('');

  const summary = $('#paths-summary');
  if (summary) {
    const rows = [];
    for (const [name, label] of [['snowluma', 'SnowLuma'], ['astrbot', 'AstrBot']]) {
      for (const item of installPaths(name, d)) {
        rows.push(`<div class="path-row">
          <span class="plabel">${escapeHtml(`${label} ${item.label}`)}</span>
          <span class="pvalue" title="${escapeHtml(item.value)}">${escapeHtml(item.value)}</span>
          <button class="btn ghost" data-open-path="${escapeHtml(item.value)}">打开</button>
          <button class="btn ghost" data-copy="${escapeHtml(item.value)}">复制</button>
        </div>`);
      }
    }
    summary.innerHTML = rows.join('');
  }
}

/* ------------------------------------------------------------------ 动作 */
async function freezeQqUpdate() {
  const info = (state.data && state.data.qqFreeze) || {};
  const ok = confirm(
    '冻结 QQ 自动更新会修改系统 hosts 文件，把 qqpatch.gtimg.cn 解析到 0.0.0.0。\n\n'
    + `文件：${info.hostsPath || ''}\n`
    + '写入需要管理员权限，接下来会弹出 UAC 授权框（不会出现终端窗口）。\n\n继续？',
  );
  if (!ok) return;
  toast('等待管理员授权…', 'info', 4000);
  const res = await window.launcher.system.freezeQqUpdate();
  if (res.ok) {
    notify('ok', `已冻结 QQ 自动更新${res.elevated ? '（通过 UAC 提权写入）' : ''}。QQ 将不再自动升级，撤销请点「解除冻结」。`, 'QQ 自动更新');
  } else {
    notify('warn', `${res.error || '操作未完成'}${res.cancelled ? '\n（你可以改用「打开 hosts 文件」手动添加一行：0.0.0.0 qqpatch.gtimg.cn）' : ''}`, '冻结失败');
  }
  refresh();
}

async function unfreezeQqUpdate() {
  if (!confirm('解除冻结会移除本应用写入的 hosts 记录，之后 QQ 可以再次自动更新。继续？')) return;
  toast('等待管理员授权…', 'info', 4000);
  const res = await window.launcher.system.unfreezeQqUpdate();
  if (res.ok) notify('ok', res.already ? '当前没有需要移除的冻结记录' : '已解除冻结，QQ 可以恢复自动更新', 'QQ 自动更新');
  else notify('warn', res.error || '操作未完成', '解除冻结失败');
  refresh();
}

/* ------------------------------------------------------------------ 数据目录迁移 */
function fmtBytesPlain(n) { return fmtBytes(n); }

async function migrateData() {
  const d = state.data;
  const suggested = await window.launcher.migrate.defaultTarget();
  const target = await new Promise((resolve) => {
    modal('迁移数据目录', `
      <p>把 SnowLuma / AstrBot 的<b>程序、数据、日志、下载缓存</b>整体搬到另一个位置（例如 C 盘 → F 盘）。</p>
      <div class="path-item"><b>当前数据根目录</b><code>${escapeHtml(d.app.dataRoot)}</code></div>
      <div class="form-row" style="margin-top:14px">
        <label>目标数据根目录</label>
        <div class="input-group">
          <input type="text" id="migrate-target" value="${escapeHtml(suggested || '')}" placeholder="例如 F:\\SnowLumaAstrBotConsole" />
          <button class="btn small" id="migrate-pick">选择…</button>
          <button class="btn small ghost" id="migrate-suggest">推荐位置</button>
        </div>
      </div>
      <div class="hint">迁移流程：停止服务 → 复制（robocopy 多线程）→ <b>校验文件数与总体积</b> → 删除旧目录 → 自动切换到新目录。
      校验不通过会保留旧目录并中止，不会丢数据。</div>
      <div class="modal-actions">
        <button class="btn primary" id="modal-ok">检查目标目录</button>
        <button class="btn ghost" id="modal-cancel">取消</button>
      </div>`);
    const finish = (value) => { modalResolve = null; closeModal(); resolve(value); };
    modalResolve = () => finish('');
    $('#migrate-pick').onclick = async () => {
      const dir = await window.launcher.system.pickDir('选择目标数据根目录');
      if (dir) $('#migrate-target').value = dir;
    };
    $('#migrate-suggest').onclick = async () => {
      const again = await window.launcher.migrate.defaultTarget();
      if (again) $('#migrate-target').value = again;
    };
    $('#modal-ok').onclick = () => finish($('#migrate-target').value.trim());
    $('#modal-cancel').onclick = () => finish('');
  });
  if (!target) return;

  toast('正在检查目标目录…', 'info', 3000);
  const planRes = await window.launcher.migrate.plan(target);
  if (!planRes.ok) {
    modal('检查失败', `<p>${escapeHtml(planRes.error)}</p>`);
    return;
  }
  const plan = planRes.plan;
  const summary = `
    <div class="path-item"><b>从</b><code>${escapeHtml(plan.sourceRoot)}</code></div>
    <div class="path-item"><b>到</b><code>${escapeHtml(plan.targetRoot)}</code></div>
    <div class="kv" style="margin-top:12px">
      ${row('数据量', `${plan.files} 个文件 / ${fmtBytesPlain(plan.bytes)}`)}
      ${row('目标盘可用', plan.freeSpace >= 0 ? fmtBytesPlain(plan.freeSpace) : '未知')}
      ${row('跨磁盘', plan.crossDrive ? '是（复制后删除源目录）' : '否（同一磁盘内移动）')}
    </div>`;
  if (!plan.ok) {
    await confirmDialog('无法迁移', `${summary}<p style="color:var(--err);margin-top:12px">${plan.blockers.map(escapeHtml).join('<br />')}</p>`, '知道了');
    return;
  }
  const go = await confirmDialog(
    '确认迁移数据目录',
    `${summary}
     <div class="hint">迁移过程中两个服务会被停止；完成并校验通过后会自动切换到这个新目录（设置里的数据根目录也会改写）。</div>`,
    '开始迁移',
  );
  if (!go) return;

  const result = await window.launcher.migrate.run(target);
  if (result.ok) {
    notify('ok', `迁移完成：${result.targetRoot}\n已搬移 ${result.moved.files} 个文件 / ${fmtBytesPlain(result.moved.bytes)}\n旧目录已清理，两个服务照旧可用。`, '数据迁移');
  } else {
    notify('error', result.error || '迁移失败', '数据迁移');
  }
  refresh();
  if (state.page === 'settings') fillSettings();
}

async function withBusy(name, fn) {  state.busy[name] = true;
  render();
  try {
    return await fn();
  } catch (error) {
    notify('error', error.message, `${name} 操作失败`);
    throw error;
  } finally {
    state.busy[name] = false;
    refresh();
  }
}

async function serviceAction(name, action) {
  const api = window.launcher[name];
  if (action === 'install' || action === 'reinstall') {
    const flavor = $('#sel-flavor') ? $('#sel-flavor').value : undefined;
    const tag = $('#sel-tag') ? $('#sel-tag').value : '';
    const confirmed = await confirmInstall(name);
    if (!confirmed) return undefined;
    return withBusy(name, async () => {
      notify('info', name === 'snowluma'
        ? `开始下载安装 SnowLuma → ${state.data.snowluma.appDir}`
        : `开始下载安装 AstrBot → ${state.data.astrbot.appDir}（含 Python 依赖，耗时较长）`, '安装中');
      const result = await api.install({ tag, flavor });
      notify('ok', `${name} ${result.version || result.tag} 安装完成\n程序目录：${result.appDir || ''}`, '完成');
    });
  }
  if (action === 'update') {
    return withBusy(name, async () => {
      const result = await api.update();
      notify(result.upToDate ? 'info' : 'ok', result.upToDate ? `${name} 已是最新版本` : `${name} 已更新到 ${result.version || result.tag}（数据保留）`, '更新');
    });
  }
  if (action === 'start') {
    return withBusy(name, async () => {
      await api.start();
      notify('ok', `${name} 已启动`, '启动');
    });
  }
  if (action === 'stop') {
    return withBusy(name, async () => {
      await api.stop();
      notify('info', `${name} 已停止`, '停止');
    });
  }
  if (action === 'restart') {
    return withBusy(name, async () => {
      await api.restart();
      notify('ok', `${name} 已重启`, '重启');
    });
  }
  if (action === 'adopt') {
    return refresh({ withReleases: false });
  }
  if (action === 'repair') {
    return withBusy(name, async () => {
      await api.repairDeps();
      notify('ok', 'AstrBot 依赖已重新安装', '完成');
    });
  }
  return undefined;
}

async function loadReleases(name) {
  toast('正在获取版本列表…', 'info', 2500);
  const list = await window.launcher[name].releases({ force: true });
  state.releases[name] = list;
  render();
  if (!list.length) toast('没有获取到版本信息（可能是网络问题）', 'warn');
}

async function checkUpdates() {
  const d = state.data;
  if (!d) return;
  toast('正在检查更新…', 'info', 2500);
  const out = [];
  for (const name of ['snowluma', 'astrbot']) {
    if (!d[name].installed) { out.push(`${name}：未安装`); continue; }
    try {
      const plan = await window.launcher[name].plan({});
      const current = `v${d[name].version}`;
      out.push(`${name}：当前 ${current} → 最新 ${plan.tag}${current === plan.tag ? '（已最新）' : ''}`);
    } catch (error) {
      out.push(`${name}：检查失败（${error.message}）`);
    }
  }
  notify('info', out.join('\n'), '更新检查结果');
}

async function startAll() {
  const d = state.data;
  const tasks = [];
  if (d.snowluma.installed && !d.snowluma.running && !d.snowluma.external) tasks.push(serviceAction('snowluma', 'start'));
  if (d.astrbot.installed && !d.astrbot.running && !d.astrbot.external) tasks.push(serviceAction('astrbot', 'start'));
  if (!tasks.length) { toast('没有需要启动的服务', 'info'); return; }
  await Promise.all(tasks);
}

async function stopAll() {
  const tasks = [];
  if (state.data.snowluma.running) tasks.push(serviceAction('snowluma', 'stop'));
  if (state.data.astrbot.running) tasks.push(serviceAction('astrbot', 'stop'));
  if (!tasks.length) { toast('没有正在运行的服务', 'info'); return; }
  await Promise.all(tasks);
}

async function oneClickBridge({ silent = false } = {}) {
  const port = Number($('#bridge-port').value) || 6199;
  const token = $('#bridge-token').value || '';
  const resultBox = $('#bridge-result');
  const log = [];
  try {
    if (port !== Number(state.data.settings.ports.astrbotReverseWs)) {
      await window.launcher.settings.patch({ ports: { astrbotReverseWs: port } });
    }
    const abResult = await window.launcher.astrbot.bridge({ port, host: '127.0.0.1', token, restart: true });
    if (abResult.ok) {
      log.push(`✔ 已写入 AstrBot 平台配置：OneBot v11 反向 WS 127.0.0.1:${port}（${abResult.file}）`);
      if (abResult.restartRequired) log.push('  · AstrBot 已重启以加载新配置');
    } else {
      log.push(`✘ AstrBot 配置未写入：${abResult.error || '未知错误'}`);
    }
    const slResult = await window.launcher.snowluma.bridge({ url: `ws://127.0.0.1:${port}/ws`, token });
    if (slResult.ok) {
      log.push(`✔ 已写入 SnowLuma 反向 WS：${slResult.url}（${slResult.file}）`);
      log.push('  · 若 SnowLuma 正在运行，请在 SnowLuma 控制台里重载一次 OneBot 配置（或点重启）');
    } else {
      log.push(`✘ SnowLuma 配置未写入：${slResult.error || '未知错误'}`);
    }
    resultBox.innerHTML = log.map(escapeHtml).join('<br />');
    if (!silent) notify(log.some((l) => l.startsWith('✘')) ? 'warn' : 'ok', log.join('\n'), '一键桥接');
    refresh();
  } catch (error) {
    resultBox.textContent = `桥接失败：${error.message}`;
    if (!silent) notify('error', error.message, '一键桥接失败');
  }
}

/**
 * 一键登录：直接在嵌入的 WebUI 里填好账号密码并提交。
 * 不依赖对方前端的存储格式，失败也不影响手动登录，只是省一次复制粘贴。
 */
async function autoLogin(name) {
  const d = state.data;
  const view = document.getElementById(`wv-${name}`);
  if (!view || !d[name].webuiReady) {
    toast('控制台还没就绪，请先启动对应服务', 'warn');
    return;
  }
  // AstrBot：直接调面板 API 换 JWT，再写进 WebUI 的 localStorage（100% 可靠）
  if (name === 'astrbot') {
    try {
      const res = await window.launcher.astrbot.login({});
      if (res.ok) {
        await view.executeJavaScript(
          `localStorage.setItem('token', ${JSON.stringify(res.token)});`
          + `localStorage.setItem('user', ${JSON.stringify(res.username)});`
          + `location.href = '/';`,
          true,
        );
        toast('已自动登录 AstrBot 面板', 'ok', 4000);
        return;
      }
      toast(`自动登录失败：${res.error}（改用表单填写）`, 'warn', 6000);
    } catch (error) {
      toast(`自动登录失败：${error.message}`, 'warn');
    }
  }

  const cred = d[name].credentials || {};
  const password = name === 'snowluma'
    ? (cred.password || d.settings.secrets.snowlumaPassword || '')
    : (cred.password || '');
  if (!password) {
    toast('还没有记录到登录密码，请点「登录凭据」查看说明', 'warn', 7000);
    return;
  }
  const username = name === 'snowluma' ? 'admin' : (cred.user || 'astrbot');
  const script = `(function(){
    const pw = ${JSON.stringify(password)};
    const user = ${JSON.stringify(username)};
    const setValue = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const inputs = Array.from(document.querySelectorAll('input')).filter((el) => el.type !== 'hidden' && !el.disabled && el.offsetParent !== null);
    if (!inputs.length) return 'no-input';
    const pwInput = inputs.find((el) => el.type === 'password') || inputs[0];
    setValue(pwInput, pw);
    let userInput = inputs.find((el) => /user|账号|用户名|account/i.test(el.name + ' ' + el.id + ' ' + el.placeholder + ' ' + el.type));
    if (userInput && userInput !== pwInput) setValue(userInput, user);
    const buttons = Array.from(document.querySelectorAll('button, input[type=submit], [role=button]'));
    const submit = buttons.find((b) => /登录|进入控制台|登 录|login|sign in/i.test(b.textContent || b.value || '')) || buttons[0];
    if (!submit) return 'no-button';
    submit.click();
    return 'submitted';
  })()`;
  try {
    const result = await view.executeJavaScript(script, true);
    if (result === 'submitted') toast('已自动填入并提交登录信息', 'ok', 4000);
    else if (result === 'no-input') toast('当前页面没有登录表单（可能已经登录了）', 'info');
    else toast(`自动登录未完成（${result}），请手动输入：${password}`, 'warn', 9000);
  } catch (error) {
    toast(`自动登录失败：${error.message}`, 'error');
  }
}

function showCredentials(name) {
  const d = state.data;
  if (name === 'snowluma') {
    const cred = d.snowluma.credentials || {};
    const password = cred.password || d.settings.secrets.snowlumaPassword || '';
    modal('SnowLuma 面板登录凭据', `
      <p>SnowLuma WebUI 初始账号为 <code>admin</code>，密码只在<b>全新数据目录首次启动</b>时生成。启动器已为你预置并记录：</p>
      <div class="cred">用户名：admin　密码：${escapeHtml(password || '（尚未生成）')}</div>
      <p style="margin-top:14px">如果登录失败，可在 SnowLuma 控制台里用「忘记密码」流程，或删除 <code>${escapeHtml((d.app.layout.instance && d.app.layout.instance.snowluma) || '')}\\config\\webui.json</code> 后重启以重新生成。</p>
      <div class="actions"><button class="btn small" id="btn-copy-cred">复制密码</button></div>`);
    const btn = $('#btn-copy-cred');
    if (btn) btn.onclick = () => copyText(password, '密码已复制');
    return;
  }
  const cred = d.astrbot.credentials || {};
  modal('AstrBot 面板登录凭据', `
    <p>AstrBot 面板用户名固定为 <code>astrbot</code>，初始密码在首次启动时随机生成并打印在启动日志里，启动器已自动抓取：</p>
    <div class="cred">用户名：astrbot　密码：${escapeHtml(cred.password || '（本次会话未抓取到）')}</div>
    <p style="margin-top:14px">如果密码丢失，可在「设置 → 凭据与维护 → 重置 AstrBot 面板密码」重新生成（会重启 AstrBot）。</p>
    <div class="actions"><button class="btn small" id="btn-copy-cred">复制密码</button></div>`);
  const btn = $('#btn-copy-cred');
  if (btn) btn.onclick = () => copyText(cred.password || '', '密码已复制');
}

/* ------------------------------------------------------------------ 事件绑定 */
function bindEvents() {
  $$('.nav-item').forEach((b) => b.addEventListener('click', () => gotoPage(b.dataset.page)));
  document.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-goto]');
    if (target) { gotoPage(target.dataset.goto); return; }

    const copy = event.target.closest('[data-copy]');
    if (copy) { copyText(copy.dataset.copy, '已复制'); return; }

    const openPath = event.target.closest('[data-open-path]');
    if (openPath) {
      const target = openPath.dataset.openPath;
      const res = await window.launcher.system.openPath(target);
      if (res) toast(`打开失败：${res}（目录可能还没创建）`, 'warn');
      return;
    }

    const loadRel = event.target.closest('[data-load-releases]');
    if (loadRel) { loadReleases(loadRel.dataset.loadReleases).catch((e) => toast(e.message, 'error')); return; }

    const act = event.target.closest('[data-act][data-svc]');
    if (act) { serviceAction(act.dataset.svc, act.dataset.act); return; }

    const view = event.target.closest('[data-view][data-act]');
    if (view) {
      const name = view.dataset.view;
      const el = $(`#wv-${name}`);
      if (view.dataset.act === 'reload') {
        try { el.reload(); } catch { /* ignore */ }
      } else if (view.dataset.act === 'back') {
        try { if (el.canGoBack()) el.goBack(); } catch { /* ignore */ }
      } else if (view.dataset.act === 'forward') {
        try { if (el.canGoForward()) el.goForward(); } catch { /* ignore */ }
      } else if (view.dataset.act === 'external') {
        window.launcher.system.openExternal(state.data[name].url);
      }
    }
  });

  $('#btn-refresh-all').onclick = () => refresh({ withReleases: true });
  $('#btn-rescan').onclick = async () => { await window.launcher.env.qq(); await refresh(); toast('已重新检测本机环境', 'ok', 2000); };
  $('#btn-open-root').onclick = () => window.launcher.system.openPath(state.data.app.dataRoot);
  $('#btn-open-root2').onclick = () => window.launcher.system.openPath(state.data.app.dataRoot);
  $('#btn-migrate-data').onclick = () => migrateData();
  $('#btn-migrate-default').onclick = async () => {
    const suggested = await window.launcher.migrate.defaultTarget();
    if (!suggested) { toast('没有找到可用的其它磁盘', 'warn'); return; }
    $('#set-dataRoot').value = suggested;
    toast(`已填入推荐位置 ${suggested}；点「迁移数据目录…」可把现有数据搬过去`, 'info', 8000);
  };
  $('#btn-start-all').onclick = startAll;
  $('#btn-stop-all').onclick = stopAll;
  $('#btn-check-updates').onclick = checkUpdates;
  $('#btn-bridge-now').onclick = async () => { gotoPage('bridge'); await oneClickBridge(); };
  $('#btn-open-logs').onclick = () => gotoPage('logs');

  $('#btn-start-snowluma-top').onclick = () => serviceAction('snowluma', state.data.snowluma.running ? 'stop' : 'start');
  $('#btn-start-astrbot-top').onclick = () => serviceAction('astrbot', state.data.astrbot.running ? 'stop' : 'start');
  $('#btn-start-snowluma-ph').onclick = () => serviceAction('snowluma', 'start');
  $('#btn-start-astrbot-ph').onclick = () => serviceAction('astrbot', 'start');
  $('#btn-cred-snowluma').onclick = () => showCredentials('snowluma');
  $('#btn-cred-astrbot').onclick = () => showCredentials('astrbot');
  $('#btn-login-snowluma').onclick = () => autoLogin('snowluma');
  $('#btn-login-astrbot').onclick = () => autoLogin('astrbot');

  $('#btn-bridge-astrbot').onclick = async () => {
    const port = Number($('#bridge-port').value) || 6199;
    const token = $('#bridge-token').value || '';
    const res = await window.launcher.astrbot.bridge({ port, host: '127.0.0.1', token, restart: true });
    $('#bridge-result').innerHTML = res.ok
      ? `✔ AstrBot 平台配置已写入：<code>${escapeHtml(res.file)}</code><br />· 反向 WS：127.0.0.1:${port}`
      : `✘ ${escapeHtml(res.error || '写入失败')}`;
  };
  $('#btn-bridge-snowluma').onclick = async () => {
    const port = Number($('#bridge-port').value) || 6199;
    const token = $('#bridge-token').value || '';
    const res = await window.launcher.snowluma.bridge({ url: `ws://127.0.0.1:${port}/ws`, token });
    $('#bridge-result').innerHTML = res.ok
      ? `✔ SnowLuma 反向 WS 已写入：<code>${escapeHtml(res.file)}</code><br />· 目标：${escapeHtml(res.url)}`
      : `✘ ${escapeHtml(res.error || '写入失败')}`;
  };
  $('#btn-bridge-full').onclick = () => oneClickBridge();
  $('#bridge-port').addEventListener('input', (e) => { e.target.dataset.touched = '1'; });

  $('#log-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    state.logTab = tab.dataset.log;
    $$('#log-tabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
    renderLogs();
  });
  $('#btn-log-clear').onclick = async () => {
    await window.launcher[state.logTab].clearLogs();
    state.logs[state.logTab] = [];
    renderLogs();
  };
  $('#btn-log-export').onclick = async () => {
    const res = await window.launcher.system.exportLogs(state.logTab);
    if (res && res.ok) toast(`已导出：${res.file}`, 'ok'); else toast(`导出失败：${res && res.error}`, 'error');
  };

  $('#btn-pick-root').onclick = async () => {
    const dir = await window.launcher.system.pickDir('选择数据根目录');
    if (dir) $('#set-dataRoot').value = dir;
  };
  $('#btn-save-ports').onclick = async () => {
    await window.launcher.settings.patch({
      ports: {
        snowlumaWebui: Number($('#set-port-sl').value) || 5099,
        snowlumaHttp: Number($('#set-port-slhttp').value) || 3000,
        snowlumaWs: Number($('#set-port-slws').value) || 3001,
        astrbotWebui: Number($('#set-port-ab').value) || 6185,
        astrbotReverseWs: Number($('#set-port-abws').value) || 6199,
      },
    });
    toast('端口已保存（重启对应服务后生效）', 'ok');
    refresh();
  };
  $('#btn-save-mirrors').onclick = async () => {
    await window.launcher.settings.patch({
      mirrors: {
        enabled: $('#set-mirror-enabled').checked,
        custom: $('#set-mirror-custom').value.trim(),
        list: $('#set-mirror-list').value.split('\n').map((s) => s.trim()).filter(Boolean),
      },
      pip: { index: $('#set-pip-index').value },
    });
    toast('下载源设置已保存', 'ok');
    refresh();
  };
  $('#btn-save-runtime').onclick = async () => {
    await window.launcher.settings.patch({
      runtime: {
        autostartOnLaunch: $('#set-autostart').checked,
        restartOnUpdate: $('#set-restart-on-update').checked,
      },
      ui: { closeToTray: $('#set-close-to-tray').checked },
      python: { launcher: $('#set-python').value.trim() },
      dataRoot: $('#set-dataRoot').value.trim() || state.data.settings.dataRoot,
    });
    toast('运行时设置已保存', 'ok');
    refresh();
  };
  $('#set-close-to-tray').onchange = async () => {
    const enabled = $('#set-close-to-tray').checked;
    await window.launcher.tray.setEnabled(enabled);
    toast(enabled ? '已开启：关闭窗口将最小化到托盘，服务继续在后台运行' : '已关闭：关闭窗口将直接退出并停止服务', 'ok', 6000);
    refresh();
  };
  $('#btn-hide-to-tray').onclick = () => hideToTray();
  $('#btn-hide-tray-quick').onclick = () => hideToTray();
  $('#btn-detect-python').onclick = async () => {
    const res = await window.launcher.env.pythons();
    if (res.usable && res.usable.length) {
      const list = res.usable.map((p) => `${p.version} (${p.exe})`).join('\n');
      modal('检测到的 Python', `<p>满足 AstrBot 要求（≥3.12）的解释器：</p><pre>${escapeHtml(list)}</pre>
        <div class="actions"><button class="btn small" id="btn-use-python">使用第一个：${escapeHtml(res.usable[0].exe)}</button></div>`);
      $('#btn-use-python').onclick = async () => {
        await window.launcher.settings.patch({ python: { launcher: res.usable[0].exe, version: res.usable[0].version } });
        closeModal();
        toast('已设置 Python 解释器', 'ok');
        refresh();
      };
    } else {
      modal('未找到合适的 Python', `<p>未检测到 3.12 及以上版本。已发现：</p><pre>${escapeHtml((res.all || []).map((p) => `${p.version} (${p.exe})`).join('\n') || '无')}</pre>
        <p>AstrBot 要求 Python ≥ 3.12，请先安装后重试。</p>`);
    }
  };
  $('#btn-freeze-qq').onclick = () => freezeQqUpdate();
  $('#btn-freeze-qq2').onclick = () => freezeQqUpdate();
  $('#btn-unfreeze-qq').onclick = () => unfreezeQqUpdate();
  $('#btn-unfreeze-qq2').onclick = () => unfreezeQqUpdate();
  $('#btn-open-hosts').onclick = async () => {
    const res = await window.launcher.system.openHosts();
    if (!res.ok) toast(`打开 hosts 失败：${res.error || '未知错误'}`, 'error');
  };
  $('#btn-open-hosts2').onclick = $('#btn-open-hosts').onclick;
  $('#btn-copy-sl-pass').onclick = () => copyText(state.data.settings.secrets.snowlumaPassword || '', '已复制 SnowLuma 密码');
  $('#btn-reset-ab-pass').onclick = async () => {
    if (!confirm('将重启 AstrBot 并重新生成面板初始密码，确定继续？')) return;
    await withBusy('astrbot', async () => {
      const res = await window.launcher.astrbot.resetPassword();
      if (res.ok) modal('新的 AstrBot 面板密码', `<div class="cred">用户名：astrbot　密码：${escapeHtml(res.credentials.password)}</div>`);
      else toast('未能抓取到新密码，请查看 AstrBot 日志', 'warn');
    });
  };
  $('#btn-repair-ab-deps').onclick = () => serviceAction('astrbot', 'repair');
  $('#btn-refresh-ab-dashboard').onclick = async () => {
    await withBusy('astrbot', async () => {
      const res = await window.launcher.astrbot.dashboard();
      toast(res.ok ? '面板资源已重新下载' : `面板资源获取失败：${res.error || ''}`, res.ok ? 'ok' : 'warn');
    });
  };

  $('#modal-close').onclick = closeModal;
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
}

/* ------------------------------------------------------------------ 事件订阅 */
function bindIpcEvents() {
  window.launcher.on('progress', (p) => {
    if (!p || !p.service) return;
    if (p.phase === 'error') {
      state.progress[p.service] = { ...p, done: true };
      renderProgress(p.service);
      notify('error', p.message, `${p.service} 出错`);
      return;
    }
    if (p.phase === 'done' || p.phase === 'restart') {
      state.progress[p.service] = { ...p, done: true };
      renderProgress(p.service);
      return;
    }
    state.progress[p.service] = p;
    renderProgress(p.service);
  });
  window.launcher.on('log:lines', ({ service, lines }) => appendLogs(service, lines));
  window.launcher.on('status:changed', () => refresh());
  window.launcher.on('tray:state', ({ windowVisible } = {}) => {
    if (state.data && state.data.tray) state.data.tray.windowVisible = windowVisible;
    if (state.page === 'settings') renderTrayBadge(state.data);
  });
  window.launcher.on('snowluma:credentials', (cred) => {
    toast(`已捕获 SnowLuma 初始密码：${cred.password}（可在工具栏「登录凭据」查看）`, 'info', 9000);
  });
  window.launcher.on('astrbot:credentials', (cred) => {
    notify('info', `用户名：${cred.user}\n初始密码：${cred.password}`, 'AstrBot 面板初始凭据');
  });
  window.launcher.on('ui:goto', ({ page }) => gotoPage(page));
  window.launcher.on('toast', ({ level, message }) => notify(level, message, '提示'));
}

/* ------------------------------------------------------------------ 启动 */
async function init() {
  bindEvents();
  bindIpcEvents();
  await refresh({ withReleases: false });
  const last = state.data && state.data.settings.ui && state.data.settings.ui.lastPage;
  gotoPage(last && document.getElementById(`page-${last}`) ? last : 'home');
  // 预加载日志
  for (const name of ['snowluma', 'astrbot']) {
    try {
      const lines = await window.launcher[name].logs({ lines: 800 });
      state.logs[name] = lines;
    } catch { /* ignore */ }
  }
  setInterval(() => { if (state.page === 'home') refresh(); }, 5000);
}

window.addEventListener('DOMContentLoaded', init);
