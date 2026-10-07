'use strict';
/**
 * 网络层：GitHub API 读取、多源自动切换下载（带断点续传 / 限速保护 / 校验）。
 * 国内直连 github.com/releases 常常超时，因此所有资源都支持"直连优先 + 镜像回退"。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { ensureDir, formatBytes, sleep } = require('./util');

const UA = 'SnowLumaAstrBotLauncher/1.0 (+local)';

function withMirror(prefix, url) {
  return `${prefix}${url}`;
}

function buildCandidates(url, mirrors = []) {
  const list = [url];
  for (const prefix of mirrors) {
    if (!prefix) continue;
    list.push(withMirror(prefix, url));
  }
  return [...new Set(list)];
}

async function fetchText(url, { timeoutMs = 20000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json', ...headers },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const error = new Error(`HTTP ${res.status} ${res.statusText}`);
      error.status = res.status;
      error.body = text.slice(0, 400);
      throw error;
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** 依次尝试直连与镜像前缀，返回第一个成功的 JSON。 */
async function fetchJsonAny(url, mirrors = [], { timeoutMs = 20000 } = {}) {
  const errors = [];
  for (const candidate of buildCandidates(url, mirrors)) {
    try {
      const text = await fetchText(candidate, { timeoutMs });
      return { json: JSON.parse(text), url: candidate };
    } catch (error) {
      errors.push(`${candidate} → ${error.message}`);
    }
  }
  const error = new Error(`请求失败：${errors.join(' | ')}`);
  error.attempts = errors;
  throw error;
}

const releaseCache = new Map();

async function listReleases(repo, { mirrors = [], limit = 30, force = false } = {}) {
  const key = `${repo}:${limit}`;
  const cached = releaseCache.get(key);
  if (!force && cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.data;
  const url = `https://api.github.com/repos/${repo}/releases?per_page=${limit}`;
  const { json } = await fetchJsonAny(url, mirrors, { timeoutMs: 20000 });
  const data = Array.isArray(json) ? json : [];
  releaseCache.set(key, { at: Date.now(), data });
  return data;
}

const PRERELEASE_RE = /[\-_.]?(alpha|beta|rc|dev)[\-_.]?\d*$/i;

function isPrereleaseTag(tag) {
  return PRERELEASE_RE.test(String(tag || ''));
}

function pickRelease(releases, { channel = 'stable', tag = '' } = {}) {
  const list = (releases || []).filter((r) => r && r.tag_name);
  if (tag) {
    const exact = list.find((r) => r.tag_name === tag) || list.find((r) => r.tag_name.replace(/^v/, '') === tag.replace(/^v/, ''));
    if (exact) return exact;
    return null;
  }
  const pool = channel === 'prerelease' ? list : list.filter((r) => !isPrereleaseTag(r.tag_name));
  const usable = pool.length ? pool : list;
  return usable[0] || null;
}

/**
 * 下载文件到 dest（先写 .part，成功后再 rename）。
 * - 断点续传：若 .part 已存在则带 Range 请求
 * - 卡死检测：连续 stallMs 无新数据则放弃当前源，换下一个镜像继续
 * - 校验：优先 size，其次 sha256（GitHub release 的 digest 字段）
 */
async function downloadFile({
  urls,
  dest,
  mirrors = [],
  expectedSize = 0,
  sha256 = '',
  onProgress = () => {},
  stallMs = 45000,
  budgetMs = 60 * 60 * 1000,
}) {
  const candidates = [];
  for (const u of urls) candidates.push(...buildCandidates(u, mirrors));
  const unique = [...new Set(candidates)];
  await ensureDir(path.dirname(dest));
  const part = `${dest}.part`;
  const errors = [];

  for (const url of unique) {
    const started = Date.now();
    let controller = new AbortController();
    let aborted = false;
    try {
      const existing = await fsp.stat(part).then((s) => s.size).catch(() => 0);
      const headers = { 'User-Agent': UA, Accept: '*/*' };
      if (existing > 0) headers.Range = `bytes=${existing}-`;
      let received = existing;
      let total = expectedSize || 0;

      let lastTick = Date.now();
      let lastBytes = received;
      const watchdog = setInterval(() => {
        if (received === lastBytes) {
          if (Date.now() - lastTick > stallMs) {
            aborted = true;
            controller.abort(new Error('下载停滞，切换下一个源'));
          }
        } else {
          lastTick = Date.now();
          lastBytes = received;
        }
        if (Date.now() - started > budgetMs && !aborted) {
          aborted = true;
          controller.abort(new Error('下载超时，切换下一个源'));
        }
      }, 2000);

      try {
        const res = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
        if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
        const resumeOk = existing > 0 && res.status === 206;
        if (!resumeOk) received = 0;
        const len = Number(res.headers.get('content-length') || 0);
        total = resumeOk ? received + len : len || expectedSize || 0;
        const out = fs.createWriteStream(part, { flags: resumeOk ? 'a' : 'w' });
        const reader = res.body.getReader();
        const speedStart = Date.now();
        const baseBytes = received;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.length;
          if (!out.write(Buffer.from(value))) {
            await new Promise((resolve) => out.once('drain', resolve));
          }
          const elapsed = Math.max(1, Date.now() - speedStart) / 1000;
          onProgress({
            phase: 'download',
            received,
            total,
            percent: total ? Math.min(100, Math.round((received / total) * 1000) / 10) : 0,
            speed: Math.round((received - baseBytes) / elapsed),
            url,
          });
        }
        await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
      } finally {
        clearInterval(watchdog);
      }

      const size = (await fsp.stat(part)).size;
      if (expectedSize && size !== expectedSize) {
        throw new Error(`大小不符：期望 ${expectedSize}，实际 ${size}`);
      }
      if (sha256) {
        onProgress({ phase: 'verify', received: size, total: size, percent: 100, speed: 0, url });
        const actual = await hashFile(part);
        if (actual.toLowerCase() !== sha256.toLowerCase()) {
          await fsp.rm(part, { force: true });
          throw new Error(`SHA256 校验失败（实际 ${actual.slice(0, 12)}…）`);
        }
      }
      await fsp.rm(dest, { force: true });
      await fsp.rename(part, dest);
      onProgress({ phase: 'done', received: size, total: size, percent: 100, speed: 0, url });
      return { ok: true, path: dest, size, url };
    } catch (error) {
      const message = aborted ? '下载停滞或超时' : String((error && error.message) || error);
      errors.push(`${url} → ${message}`);
      onProgress({ phase: 'retry', message, percent: 0, received: 0, total: expectedSize || 0, url });
      await sleep(400);
    }
  }
  const error = new Error(`全部下载源均失败：\n${errors.join('\n')}`);
  error.attempts = errors;
  throw error;
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (d) => hash.update(d));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function parseDigest(digest) {
  if (!digest || typeof digest !== 'string') return '';
  const match = /^sha256:([0-9a-f]{64})$/i.exec(digest.trim());
  return match ? match[1] : '';
}

module.exports = {
  UA,
  buildCandidates,
  fetchText,
  fetchJsonAny,
  listReleases,
  pickRelease,
  isPrereleaseTag,
  downloadFile,
  hashFile,
  parseDigest,
  formatBytes,
};
