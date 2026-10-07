'use strict';
/**
 * 数据目录迁移：把整个数据根目录（apps/ + instances/ + downloads/ + logs/ + state/）
 * 搬到新的位置（例如从 C 盘搬到 F 盘）。
 *
 * 安全策略：
 *  1) 先做计划（体积、文件数、目标盘剩余空间、服务是否在运行），让用户确认；
 *  2) 复制（Windows 上用 robocopy /MT 多线程，失败则回退 fs.cp）；
 *  3) 逐项校验（文件数 + 总字节数必须完全一致）后才删除源目录；
 *  4) 任何一步失败都保留源目录，并给出明确错误。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const u = require('./util');

const SUBDIRS = ['apps', 'instances', 'downloads', 'logs', 'state'];

async function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  const walk = async (d) => {
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        files += 1;
        try {
          bytes += (await fsp.stat(full)).size;
        } catch { /* ignore */ }
      }
    }
  };
  if (u.exists(dir)) await walk(dir);
  return { files, bytes };
}

function freeSpace(dir) {
  return new Promise((resolve) => {
    const target = path.parse(path.resolve(dir)).root || dir;
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-PSDrive -Name '${target.replace(/:.*$/, '')}').Free`,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    ps.stdout.on('data', (d) => { out += d; });
    ps.on('error', () => resolve(-1));
    ps.on('close', () => {
      const value = Number(String(out).trim());
      resolve(Number.isFinite(value) ? value : -1);
    });
  });
}

function isSubPath(parent, child) {
  const p = path.resolve(parent).toLowerCase().replace(/[\\/]+$/, '');
  const c = path.resolve(child).toLowerCase().replace(/[\\/]+$/, '');
  return c === p || c.startsWith(`${p}${path.sep}`);
}

/** 迁移前的检查与计划。 */
async function plan({ sourceRoot, targetRoot }) {
  const src = path.resolve(sourceRoot);
  const dst = path.resolve(targetRoot);
  const notes = [];
  const blockers = [];

  if (src.toLowerCase() === dst.toLowerCase()) blockers.push('目标目录与当前数据目录相同');
  if (isSubPath(src, dst)) blockers.push('目标目录不能位于当前数据目录内部');
  if (isSubPath(dst, src)) blockers.push('目标目录不能是当前数据目录的上级目录');
  const srcDrive = path.parse(src).root.toLowerCase();
  const dstDrive = path.parse(dst).root.toLowerCase();
  if (srcDrive === dstDrive) notes.push('源与目标在同一个磁盘分区（迁移后仍然可用，只是换了个目录）');

  const existing = u.exists(dst) ? await fsp.readdir(dst).catch(() => []) : [];
  if (existing.length) blockers.push(`目标目录已存在且不为空（${existing.length} 个条目）：${dst}`);

  const stats = await dirStats(src);
  const free = await freeSpace(dstDrive);
  if (free >= 0 && free < stats.bytes * 1.05) {
    blockers.push(`目标磁盘剩余空间不足：需要约 ${u.formatBytes(stats.bytes * 1.05)}，可用 ${u.formatBytes(free)}`);
  }

  return {
    sourceRoot: src,
    targetRoot: dst,
    bytes: stats.bytes,
    files: stats.files,
    freeSpace: free,
    crossDrive: srcDrive !== dstDrive,
    subdirs: SUBDIRS.map((name) => ({
      name,
      exists: u.exists(path.join(src, name)),
      bytes: 0,
    })),
    notes,
    blockers,
    ok: blockers.length === 0,
  };
}

/** 用 robocopy 复制（Windows 专用，多线程、支持长路径）；返回是否成功。 */
function robocopy(src, dst, onLine) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('robocopy.exe', [
        src, dst,
        '/E',            // 含空目录
        '/COPY:DAT',     // 数据 + 属性 + 时间戳
        '/DCOPY:T',
        '/R:2', '/W:1',  // 重试 2 次
        '/MT:16',        // 16 线程
        '/NFL', '/NDL', '/NJH', '/NJS', '/NP',
      ], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, code: -1, error: String(error.message) });
      return;
    }
    let tail = [];
    const handle = (chunk) => {
      const text = u.stripAnsi(String(chunk)).replace(/\r/g, '\n');
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        tail.push(trimmed);
        if (tail.length > 60) tail = tail.slice(-60);
        if (onLine) onLine(trimmed);
      }
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('error', (error) => resolve({ ok: false, code: -1, error: String(error.message) }));
    // robocopy 退出码 < 8 表示成功（0=没有需要复制的文件，1=已复制，2=有多余文件，3=1+2…）
    child.on('close', (code) => resolve({ ok: code !== null && code >= 0 && code < 8, code, tail }));
  });
}

async function copyFallback(src, dst) {
  await fsp.mkdir(dst, { recursive: true });
  await fsp.cp(src, dst, { recursive: true, force: true, preserveTimestamps: true, errorOnExist: false });
  return { ok: true, code: 0, tail: ['fs.cp 回退复制完成'] };
}

/**
 * 执行迁移。onProgress({phase, percent, message, detail})
 * 返回 { ok, moved: {...}, sourceRoot, targetRoot }
 */
async function run({ sourceRoot, targetRoot, onProgress = () => {}, stopServices = async () => {}, startServices = async () => {} }) {
  const info = await plan({ sourceRoot, targetRoot });
  if (!info.ok) return { ok: false, error: info.blockers.join('；'), plan: info };

  const src = info.sourceRoot;
  const dst = info.targetRoot;
  onProgress({ phase: 'prepare', percent: 0, message: `准备迁移：停止服务…` });
  await stopServices();

  // 注意：dst 的父目录可能就是盘符根（如 F:\），对它 mkdir 会 EPERM，直接递归建 dst 即可
  await u.ensureDir(dst);

  onProgress({ phase: 'copy', percent: 0, message: `复制 ${u.formatBytes(info.bytes)}（${info.files} 个文件）到 ${dst}`, indeterminate: false });

  let poller = setInterval(async () => {
    try {
      const now = await dirStats(dst);
      const percent = info.bytes ? Math.min(99, Math.round((now.bytes / info.bytes) * 100)) : 50;
      onProgress({
        phase: 'copy',
        percent,
        message: `正在复制到 ${dst}`,
        detail: `${u.formatBytes(now.bytes)} / ${u.formatBytes(info.bytes)}（${now.files}/${info.files} 个文件）`,
      });
    } catch { /* ignore */ }
  }, 900);

  let copyResult;
  try {
    copyResult = process.platform === 'win32' ? await robocopy(src, dst) : await copyFallback(src, dst);
    if (!copyResult.ok) {
      onProgress({ phase: 'copy', percent: 0, message: 'robocopy 失败，改用 fs.cp 回退复制…' });
      copyResult = await copyFallback(src, dst);
    }
  } finally {
    clearInterval(poller);
  }

  onProgress({ phase: 'verify', percent: 99, message: '校验复制结果（文件数与体积）…', indeterminate: true });
  const srcStats = await dirStats(src);
  const dstStats = await dirStats(dst);
  const verified = srcStats.files === dstStats.files && srcStats.bytes === dstStats.bytes;
  if (!verified) {
    return {
      ok: false,
      error: `校验失败，已保留源目录。源 ${srcStats.files} 个文件/${u.formatBytes(srcStats.bytes)}，目标 ${dstStats.files} 个文件/${u.formatBytes(dstStats.bytes)}`,
      plan: info,
    };
  }

  onProgress({ phase: 'cleanup', percent: 99, message: '删除旧目录…', indeterminate: true });
  try {
    await u.rmrf(src);
  } catch (error) {
    return { ok: false, error: `复制与校验都成功，但删除旧目录失败：${error.message}（新目录已可用，可手动删除 ${src}）`, plan: info, targetRoot: dst };
  }

  // 收尾：重建目录骨架（新位置直接可用）
  for (const name of SUBDIRS) await u.ensureDir(path.join(dst, name));

  onProgress({ phase: 'done', percent: 100, message: `迁移完成：${dst}` });
  return {
    ok: true,
    sourceRoot: src,
    targetRoot: dst,
    moved: { files: dstStats.files, bytes: dstStats.bytes },
    plan: info,
  };
}

module.exports = { plan, run, dirStats, SUBDIRS };
