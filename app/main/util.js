'use strict';
/**
 * 通用工具函数：全部与 Electron 解耦，方便单元验证。
 * 关键约定：所有子进程一律 windowsHide:true + 不使用 shell，确保不弹出任何终端窗口。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const isWin = process.platform === 'win32';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

function readJson(file, fallback = null) {
  if (typeof file !== 'string' || !file) return fallback;
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 去掉 BOM（AstrBot 的配置带 BOM）
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function hasBom(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(3);
    const read = fs.readSync(fd, buf, 0, 3, 0);
    fs.closeSync(fd);
    return read === 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(file, obj, { bom = false } = {}) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const text = `${bom ? '\ufeff' : ''}${JSON.stringify(obj, null, 2)}`;
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, file);
}

async function rmrf(target, attempts = 4) {
  if (!target) return;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await fsp.rm(target, { recursive: true, force: true, maxRetries: 3 });
      return;
    } catch (error) {
      if (i === attempts - 1) throw error;
      await sleep(300 * (i + 1));
    }
  }
}

function exists(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function isDir(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** 运行一个隐藏窗口的子进程，捕获输出（不弹终端）。 */
function runHidden(exe, args = [], options = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, args, {
        cwd: options.cwd,
        env: { ...process.env, ...(options.env || {}) },
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error && error.message), error });
      return;
    }
    let stdout = '';
    let stderr = '';
    const limit = 512 * 1024;
    const timer = setTimeout(() => {
      try {
        if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else child.kill('SIGKILL');
      } catch { /* ignore */ }
    }, options.timeoutMs || 120000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { if (stdout.length < limit) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < limit) stderr += d; });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(error && error.message), error });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code === null ? -1 : code, stdout, stderr });
    });
  });
}

/**
 * 流式运行子进程：逐行回调（用于 pip install 这类长耗时、需要实时进度的任务）。
 * 同样 windowsHide:true，不弹终端。
 */
function runStreaming(exe, args = [], { cwd, env, onLine, timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, args, {
        cwd,
        env: { ...process.env, ...(env || {}) },
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: -1, error });
      return;
    }
    let tail = [];
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { killTree(child.pid); } catch { /* ignore */ }
      }, timeoutMs);
    }
    const handle = (streamName) => (chunk) => {
      const text = stripAnsi(String(chunk)).replace(/\r/g, '\n');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 400) tail = tail.slice(-400);
        if (onLine) {
          try { onLine(streamName, line); } catch { /* ignore */ }
        }
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', handle('stdout'));
    child.stderr.on('data', handle('stderr'));
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, error, tail });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code === null ? -1 : code, tail });
    });
  });
}

/** 结束整棵进程树（Windows 下 taskkill /T，避免留下孤儿进程）。 */
function killTree(pid) {
  if (!pid) return;
  try {
    if (isWin) {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch { /* ignore */ }
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '');
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 探测 HTTP 服务是否已经起来（用于"启动就绪"判定）。 */
function httpProbe(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let lib;
    try {
      const parsed = new URL(url);
      lib = parsed.protocol === 'https:' ? require('https') : require('http');
      const req = lib.request(
        { method: 'GET', hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search, timeout: timeoutMs },
        (res) => {
          res.resume();
          done({ ok: true, status: res.statusCode });
        },
      );
      req.on('timeout', () => { req.destroy(); done({ ok: false, status: 0, error: 'timeout' }); });
      req.on('error', (error) => done({ ok: false, status: 0, error: String(error && error.message) }));
      req.end();
    } catch (error) {
      done({ ok: false, status: 0, error: String(error && error.message) });
    }
  });
}

async function waitForHttp(url, { timeoutMs = 90000, intervalMs = 700, onTick } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await httpProbe(url, 1500);
    if (last.ok) return last;
    if (typeof onTick === 'function') onTick(last);
    await sleep(intervalMs);
  }
  return { ok: false, status: 0, error: last ? last.error : 'timeout' };
}

/** 读取 PE 文件的机器类型（判断 QQ / node.exe 是 x64 还是 arm64）。 */
function peArch(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const read = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    if (read < 0x40) return null;
    const peOffset = buf.readUInt32LE(0x3c);
    if (peOffset + 6 > read) return null;
    if (buf.readUInt32LE(peOffset) !== 0x00004550) return null;
    const machine = buf.readUInt16LE(peOffset + 4);
    switch (machine) {
      case 0x8664: return 'x64';
      case 0xaa64: return 'arm64';
      case 0x014c: return 'ia32';
      default: return `0x${machine.toString(16)}`;
    }
  } catch {
    return null;
  }
}

async function copyDirMerge(src, dest, { skip = [] } = {}) {
  await ensureDir(dest);
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (skip.includes(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirMerge(from, to, { skip });
    } else {
      await fsp.copyFile(from, to);
    }
  }
}

function nowStamp() {
  const d = new Date();
  const p = (n, len = 2) => String(n).padStart(len, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

module.exports = {
  isWin,
  sleep,
  ensureDir,
  readJson,
  writeJsonAtomic,
  hasBom,
  rmrf,
  exists,
  isDir,
  listDirs,
  runHidden,
  runStreaming,
  killTree,
  stripAnsi,
  formatBytes,
  httpProbe,
  waitForHttp,
  peArch,
  copyDirMerge,
  nowStamp,
};
