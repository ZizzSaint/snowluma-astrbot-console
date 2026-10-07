'use strict';
/**
 * 本机环境探测：QQ（NTQQ）安装情况、Node.js、Python。
 * "下载本地 QQ 对应的 SnowLuma 版本"依赖这里的探测结果（平台 / 架构 / Node 版本）。
 */
const fs = require('fs');
const path = require('path');
const { exists, isDir, listDirs, peArch, runHidden, readJson } = require('./util');

const QQ_CANDIDATE_DIRS = [
  'C:\\Program Files\\Tencent\\QQNT',
  'C:\\Program Files (x86)\\Tencent\\QQNT',
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Tencent', 'QQNT'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Tencent', 'QQNT'),
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Tencent', 'QQNT'),
  path.join(process.env.LOCALAPPDATA || '', 'Tencent', 'QQNT'),
  'D:\\Program Files\\Tencent\\QQNT',
  'E:\\Program Files\\Tencent\\QQNT',
];

function versionFromVersionsDir(dir) {
  // 形如 versions/9.9.35-52973
  const names = listDirs(path.join(dir, 'versions'))
    .filter((n) => /^\d+\.\d+\.\d+/.test(n));
  if (!names.length) return '';
  names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const latest = names[names.length - 1];
  const match = /^(\d+\.\d+\.\d+)[-.](\d+)$/.exec(latest);
  return match ? `${match[1]}.${match[2]}` : latest;
}

async function versionFromRegistry() {
  for (const key of [
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
  ]) {
    const res = await runHidden('reg.exe', ['query', key, '/v', 'DisplayVersion'], { timeoutMs: 8000 });
    const match = /DisplayVersion\s+REG_SZ\s+(\S+)/.exec(res.stdout || '');
    if (match) return match[1];
  }
  return '';
}

async function detectQQ() {
  const info = {
    installed: false,
    dir: '',
    exe: '',
    version: '',
    arch: '',
    source: '',
    checkedAt: Date.now(),
  };
  for (const dir of QQ_CANDIDATE_DIRS) {
    if (!dir || !isDir(dir)) continue;
    const exe = path.join(dir, 'QQ.exe');
    if (!exists(exe)) continue;
    info.installed = true;
    info.dir = dir;
    info.exe = exe;
    info.arch = peArch(exe) || process.arch;
    info.version = versionFromVersionsDir(dir);
    if (info.version) info.source = 'versions 目录';
    break;
  }
  if (info.installed && !info.version) {
    info.version = await versionFromRegistry();
    if (info.version) info.source = '注册表';
  }
  if (info.installed && !info.version) {
    const res = await runHidden('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Item -LiteralPath '${info.exe.replace(/'/g, "''")}').VersionInfo.FileVersion`,
    ], { timeoutMs: 15000 });
    const version = (res.stdout || '').trim().split(/\r?\n/).pop().trim();
    if (version) { info.version = version; info.source = 'QQ.exe 版本信息'; }
  }
  return info;
}

async function detectNode() {
  const candidates = [];
  const res = await runHidden('node.exe', ['-v'], { timeoutMs: 10000 });
  if (res.code === 0) {
    const version = (res.stdout || '').trim();
    const where = await runHidden('where.exe', ['node'], { timeoutMs: 8000 });
    const exe = (where.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || 'node.exe';
    candidates.push({ source: '系统 PATH', exe, version, supported: snowlumaNodeSupported(version) });
  }
  return candidates[0] || null;
}

/** SnowLuma 的 Node 版本要求：^22.13.0 || >=23.4.0 */
function snowlumaNodeSupported(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version || ''));
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  if (major === 22) return minor >= 13;
  if (major === 23) return minor >= 4;
  return major > 23;
}

async function detectPythons() {
  const found = [];
  const seen = new Set();
  const push = (exe, version, source) => {
    if (!exe || seen.has(exe.toLowerCase())) return;
    seen.add(exe.toLowerCase());
    found.push({ exe, version, source, major: Number((version || '0').split('.')[0]), minor: Number((version || '0').split('.')[1] || 0) });
  };

  if (process.platform === 'win32') {
    const res = await runHidden('py.exe', ['-0p'], { timeoutMs: 15000 });
    for (const line of (res.stdout || '').split(/\r?\n/)) {
      const match = /^\s*-V:(\d+(?:\.\d+)?)\s*(\*)?\s*(.+?)\s*$/.exec(line);
      if (!match) continue;
      const exe = match[3].trim();
      const verRes = await runHidden(exe, ['-c', 'import sys;print("%d.%d.%d"%sys.version_info[:3])'], { timeoutMs: 15000 });
      const version = (verRes.stdout || '').trim() || match[1];
      push(exe, version, `py -${match[1]}`);
    }
  }
  for (const cmd of process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python']) {
    const res = await runHidden(cmd, ['-c', 'import sys;print("%d.%d.%d"%sys.version_info[:3])'], { timeoutMs: 15000 });
    if (res.code === 0) {
      const version = (res.stdout || '').trim();
      const which = process.platform === 'win32' ? await runHidden('where.exe', [cmd], { timeoutMs: 8000 }) : { stdout: cmd };
      const exe = (which.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || cmd;
      push(exe, version, 'PATH');
    }
  }

  // AstrBot 要求 Python >= 3.12；优先 3.13（3.14 部分依赖尚无轮子）
  const usable = found.filter((p) => p.major === 3 && p.minor >= 12);
  const rank = (p) => (p.minor === 13 ? 0 : p.minor === 12 ? 1 : p.minor === 14 ? 2 : 3);
  usable.sort((a, b) => rank(a) - rank(b));
  return { all: found, usable };
}

/** 探测一个 Node 安装目录里是否带有可用运行时（用于 SnowLuma 完整版）。 */
function findBundledNode(installDir) {
  const guesses = [
    'node.exe', 'node/node.exe', 'nodejs/node.exe', 'runtime/node.exe', 'bin/node.exe',
    'node/bin/node.exe', 'node-runtime/node.exe', 'runtime/bin/node.exe',
  ];
  for (const guess of guesses) {
    const full = path.join(installDir, guess);
    if (exists(full)) return full;
  }
  // 兜底：浅层递归搜索（最多 3 层）
  const walk = (dir, depth) => {
    if (depth > 3) return null;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase() === 'node.exe') return path.join(dir, entry.name);
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const found = walk(path.join(dir, entry.name), depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(installDir, 0);
}

function readPackageVersion(dir) {
  const pkg = readJson(path.join(dir, 'package.json'), null);
  return pkg && pkg.version ? pkg.version : '';
}

module.exports = {
  detectQQ,
  detectNode,
  detectPythons,
  snowlumaNodeSupported,
  findBundledNode,
  readPackageVersion,
  versionFromRegistry,
};
