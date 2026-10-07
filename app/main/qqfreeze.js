'use strict';
/**
 * 应用内「冻结 QQ 自动更新」功能。
 *
 * 背景：SnowLuma 的 native hook 与 QQ 版本绑定，QQ 自动升级后可能注入失败；
 * 官方建议把 QQ 的补丁域名解析到 0.0.0.0（Linux 上是写 /etc/hosts）。
 * 这里把同样的做法做进应用：状态可读、可一键冻结/解除，改 hosts 需要管理员权限时
 * 由应用自行请求提权（只弹 UAC，不弹任何终端窗口）。
 *
 * 实现要点：
 *  - 所有 hosts 写入都在 Node 侧算好完整内容（Buffer 逐字节拼接，不破坏原有非 ASCII 行），
 *    提权脚本只做一次文件复制，避免 PowerShell 编码把 hosts 写坏。
 *  - 标记块用纯英文注释，避免任何编码/BOM 风险。
 */
const fs = require('fs');
const path = require('path');
const fsp = require('fs/promises');
const os = require('os');
const { spawn } = require('child_process');
const u = require('./util');

const HOSTS_PATH = process.platform === 'win32'
  ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
  : '/etc/hosts';

const BLOCK_HOSTS = ['qqpatch.gtimg.cn'];   // 官方推荐冻结的域名
const MARK_BEGIN = '# >>> SnowLuma x AstrBot Console - freeze QQ auto-update >>>';
const MARK_END = '# <<< SnowLuma x AstrBot Console - freeze QQ auto-update <<<';
const EOL = '\r\n';

function normalizeNewlines(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function readHostsBuffer() {
  try {
    return fs.readFileSync(HOSTS_PATH);
  } catch {
    return null;
  }
}

function stripBlock(text) {
  const lines = normalizeNewlines(text).split('\n');
  const out = [];
  let inside = false;
  let removed = 0;
  for (const line of lines) {
    if (line.trim() === MARK_BEGIN) { inside = true; removed += 1; continue; }
    if (line.trim() === MARK_END) { inside = false; removed += 1; continue; }
    if (inside) { removed += 1; continue; }
    out.push(line);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return { text: out.join('\n'), removed };
}

/** 是否存在"把目标域名解析到黑洞地址"的记录（不区分是本应用还是别人写的）。 */
function hasBlockedDomain(text) {
  return normalizeNewlines(text)
    .split('\n')
    .some((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return false;
      const parts = trimmed.split(/\s+/);
      return parts.length >= 2 && (parts[0] === '0.0.0.0' || parts[0] === '127.0.0.1')
        && BLOCK_HOSTS.includes(parts[1].toLowerCase());
    });
}

/** 当前冻结状态（纯读取，不需要管理员权限）。 */
function status() {
  const buf = readHostsBuffer();
  if (!buf) {
    return { ok: false, frozen: false, ours: false, foreign: false, hostsPath: HOSTS_PATH, error: '无法读取 hosts 文件' };
  }
  const text = buf.toString('utf8');
  const ours = text.includes(MARK_BEGIN);
  const blocked = hasBlockedDomain(text);
  return {
    ok: true,
    frozen: ours || blocked,
    ours,
    foreign: !ours && blocked,
    hostsPath: HOSTS_PATH,
    domains: BLOCK_HOSTS,
    writable: isWritable(),
  };
}

function isWritable() {
  // Windows 上 fs.access(W_OK) 不反映 ACL，这里用"真正打开一次可写句柄"来判断
  try {
    const fd = fs.openSync(HOSTS_PATH, 'r+');
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function buildFreezeBuffer(originalText) {
  const { text } = stripBlock(originalText);
  const block = [
    MARK_BEGIN,
    '# SnowLuma 的 native hook 与 QQ 版本绑定，冻结 QQ 自动更新可避免注入失效',
    ...BLOCK_HOSTS.map((h) => `0.0.0.0 ${h}`),
    MARK_END,
  ].join(EOL);
  const body = text.replace(/\n/g, EOL);
  return Buffer.from(`${body}${EOL}${EOL}${block}${EOL}`, 'utf8');
}

function buildUnfreezeBuffer(originalText) {
  const { text, removed } = stripBlock(originalText);
  if (removed === 0) return null;
  return Buffer.from(`${text.replace(/\n/g, EOL)}${EOL}`, 'utf8');
}

/** 直接写（应用本身已有权限时走这条路，不会弹 UAC）。 */
function tryWriteDirect(buffer) {
  try {
    fs.writeFileSync(HOSTS_PATH, buffer);
    return { ok: true, elevated: false };
  } catch (error) {
    return { ok: false, error: String(error && error.message), code: error && error.code };
  }
}

/**
 * 提权写入：把新内容写到临时文件，再用一个隐藏窗口的 PowerShell（UAC 提权）覆盖 hosts。
 * 只有 UAC 弹窗，不会有任何终端窗口。
 */
async function writeElevated(buffer) {
  const id = `${Date.now()}-${process.pid}`;
  const tmpDir = path.join(os.tmpdir(), `sla-qqfreeze-${id}`);
  await fsp.mkdir(tmpDir, { recursive: true });
  const src = path.join(tmpDir, 'hosts.new');
  const resultFile = path.join(tmpDir, 'result.json');
  const scriptFile = path.join(tmpDir, 'apply.ps1');
  await fsp.writeFile(src, buffer);
  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `$result = @{ ok = $false; error = '' }`,
    `try {`,
    `  Copy-Item -LiteralPath '${src}' -Destination '${HOSTS_PATH}' -Force`,
    `  Start-Sleep -Milliseconds 200`,
    `  & ipconfig.exe /flushdns | Out-Null`,
    `  $result.ok = $true`,
    `} catch { $result.error = $_.Exception.Message }`,
    `$result | ConvertTo-Json -Compress | Set-Content -LiteralPath '${resultFile}' -Encoding ASCII`,
  ].join('\r\n');
  await fsp.writeFile(scriptFile, script, 'utf8');

  const launcher = [
    `$p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -PassThru -Wait`,
    `  -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','${scriptFile}';`,
    `exit $p.ExitCode`,
  ].join(' ');
  const res = await u.runHidden('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', launcher], { timeoutMs: 180000 });

  let result = null;
  try {
    result = u.readJson(resultFile, null);
  } catch { /* ignore */ }
  await u.rmrf(tmpDir);
  if (res.code === 0 && result && result.ok) return { ok: true, elevated: true };
  const stderr = (res.stderr || '').trim();
  const cancelled = /取消|canceled|cancelled|1223/i.test(stderr) || res.code === 1223;
  return {
    ok: false,
    elevated: true,
    cancelled,
    error: cancelled ? '已取消管理员授权（UAC）' : ((result && result.error) || stderr || `提权写入失败（退出码 ${res.code}）`),
  };
}

/** 冻结 QQ 自动更新。 */
async function freeze() {
  const buf = readHostsBuffer();
  if (!buf) return { ok: false, error: `无法读取 ${HOSTS_PATH}` };
  const text = buf.toString('utf8');
  if (text.includes(MARK_BEGIN)) return { ok: true, already: true, ...status() };
  const next = buildFreezeBuffer(text);
  let result = tryWriteDirect(next);
  if (!result.ok) result = await writeElevated(next);
  if (!result.ok) return { ok: false, error: result.error, cancelled: result.cancelled };
  return { ok: true, elevated: result.elevated, ...status() };
}

/** 解除冻结（只移除本应用写入的标记块，不动别人写的记录）。 */
async function unfreeze() {
  const buf = readHostsBuffer();
  if (!buf) return { ok: false, error: `无法读取 ${HOSTS_PATH}` };
  const text = buf.toString('utf8');
  const next = buildUnfreezeBuffer(text);
  if (!next) return { ok: true, already: true, ...status() };
  let result = tryWriteDirect(next);
  if (!result.ok) result = await writeElevated(next);
  if (!result.ok) return { ok: false, error: result.error, cancelled: result.cancelled };
  return { ok: true, elevated: result.elevated, ...status() };
}

module.exports = {
  status,
  freeze,
  unfreeze,
  HOSTS_PATH,
  BLOCK_HOSTS,
  MARK_BEGIN,
  MARK_END,
  // 以下为纯函数导出，便于自检（不触碰系统文件）
  _internal: { buildFreezeBuffer, buildUnfreezeBuffer, stripBlock, hasBlockedDomain, isWritable },
};
