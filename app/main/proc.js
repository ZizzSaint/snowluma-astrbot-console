'use strict';
/**
 * 受管子进程：负责隐藏窗口启动、日志收集（内存环形缓冲 + 落盘）、停止与进程树清理。
 * 这是"不显示终端控制台"的关键：GUI 进程 + windowsHide + 不经过 shell。
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { ensureDir, killTree, stripAnsi, sleep } = require('./util');

const MAX_BUFFER_LINES = 3000;
const MAX_LOG_FILE_BYTES = 8 * 1024 * 1024;

class ManagedProcess extends EventEmitter {
  constructor({ name, logDir }) {
    super();
    this.name = name;
    this.logDir = logDir;
    this.child = null;
    this.buffer = [];
    this.startedAt = 0;
    this.exitedAt = 0;
    this.lastExit = null;
    this.stopping = false;
    this.stream = null;
  }

  get running() {
    return Boolean(this.child) && this.child.exitCode === null && !this.child.killed;
  }

  get pid() {
    return this.child ? this.child.pid : 0;
  }

  logFile() {
    return path.join(this.logDir, `${this.name}.log`);
  }

  async openLogStream() {
    await ensureDir(this.logDir);
    const file = this.logFile();
    try {
      const stat = fs.existsSync(file) ? fs.statSync(file) : null;
      if (stat && stat.size > MAX_LOG_FILE_BYTES) {
        fs.renameSync(file, `${file}.1`);
      }
    } catch { /* ignore */ }
    this.stream = fs.createWriteStream(file, { flags: 'a' });
    this.stream.on('error', () => { /* 日志写入失败不影响主流程 */ });
  }

  push(streamName, rawText) {
    const text = stripAnsi(rawText).replace(/\r/g, '');
    const lines = text.split('\n');
    for (const line of lines) {
      if (line === '' && lines.length > 1) continue;
      const entry = { ts: Date.now(), stream: streamName, text: line };
      this.buffer.push(entry);
      if (this.buffer.length > MAX_BUFFER_LINES) this.buffer.splice(0, this.buffer.length - MAX_BUFFER_LINES);
      if (this.stream) {
        try { this.stream.write(`[${new Date(entry.ts).toISOString()}] ${line}\n`); } catch { /* ignore */ }
      }
      this.emit('line', entry);
    }
  }

  pushLocal(text) {
    this.push('app', text);
  }

  /**
   * @param {{exe:string,args:string[],cwd:string,env:Object,label?:string}} options
   */
  async start(options) {
    if (this.running) return { ok: true, already: true, pid: this.pid };
    await this.openLogStream();
    const env = { ...process.env, ...(options.env || {}) };
    // 让 Node / Python 都按 UTF-8 输出，避免中文日志乱码
    env.PYTHONIOENCODING = env.PYTHONIOENCODING || 'utf-8';
    env.PYTHONUTF8 = env.PYTHONUTF8 || '1';
    env.FORCE_COLOR = '0';
    env.NO_COLOR = '1';

    this.pushLocal(`启动 ${options.label || this.name}`);
    this.pushLocal(`  可执行文件: ${options.exe}`);
    this.pushLocal(`  参数: ${(options.args || []).join(' ')}`);
    this.pushLocal(`  工作目录: ${options.cwd}`);

    const child = spawn(options.exe, options.args || [], {
      cwd: options.cwd,
      env,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.startedAt = Date.now();
    this.stopping = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => this.push('stdout', d));
    child.stderr.on('data', (d) => this.push('stderr', d));

    const settle = (code, signal) => {
      this.exitedAt = Date.now();
      this.lastExit = { code, signal, at: this.exitedAt, expected: this.stopping };
      this.pushLocal(`进程退出：code=${code} signal=${signal || ''}${this.stopping ? '（由启动器停止）' : ''}`);
      this.child = null;
      this.emit('exit', this.lastExit);
    };

    child.on('error', (error) => {
      this.push('stderr', `启动失败：${error.message}`);
      settle(-1, null);
    });
    child.on('exit', (code, signal) => settle(code, signal));

    return { ok: true, pid: child.pid };
  }

  async stop({ timeoutMs = 4000 } = {}) {
    if (!this.child) return { ok: true, already: true };
    const pid = this.child.pid;
    this.stopping = true;
    this.pushLocal('正在停止进程…');
    try { this.child.kill(); } catch { /* ignore */ }
    const deadline = Date.now() + timeoutMs;
    while (this.running && Date.now() < deadline) {
      await sleep(150);
    }
    if (this.running) {
      this.pushLocal('强制结束进程树…');
      killTree(pid);
      await sleep(400);
    }
    this.pushLocal('已停止。');
    return { ok: true, pid };
  }

  recent(n = 400) {
    return this.buffer.slice(Math.max(0, this.buffer.length - n));
  }

  clear() {
    this.buffer = [];
  }
}

module.exports = { ManagedProcess };
