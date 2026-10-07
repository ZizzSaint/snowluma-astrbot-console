'use strict';
/** 基于 yauzl 的流式 zip 解压（带进度、目录穿越防护、可选剥掉顶层目录）。 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const yauzl = require('yauzl');
const { ensureDir } = require('./util');

function safeJoin(destRoot, entryName) {
  const normalized = entryName.replace(/\\/g, '/').replace(/^\/+/, '');
  const target = path.resolve(destRoot, normalized);
  const root = path.resolve(destRoot);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`不安全的压缩包路径：${entryName}`);
  }
  return target;
}

function openZip(zipPath, options) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, options, (err, zipfile) => (err ? reject(err) : resolve(zipfile)));
  });
}

/**
 * @param {string} zipPath
 * @param {string} destDir
 * @param {{onProgress?:Function, stripComponents?:number}} options
 */
async function extractZip(zipPath, destDir, { onProgress = () => {}, stripComponents = 0 } = {}) {
  await ensureDir(destDir);
  const zipfile = await openZip(zipPath, { lazyEntries: true, autoClose: true, decodeStrings: true });
  const total = Math.max(1, zipfile.entryCount);
  let index = 0;
  let written = 0;

  return new Promise((resolve, reject) => {
    const fail = (error) => {
      try { zipfile.close(); } catch { /* ignore */ }
      reject(error);
    };

    zipfile.on('error', fail);
    zipfile.on('end', () => resolve({ files: index, bytes: written }));

    zipfile.on('entry', (entry) => {
      index += 1;
      const rawName = entry.fileName;
      const parts = rawName.replace(/\\/g, '/').split('/').filter((p) => p.length > 0);
      const stripped = parts.slice(stripComponents);
      const isDir = /\/$/.test(rawName) || parts.length === 0;
      const report = () => onProgress({ phase: 'extract', percent: Math.round((index / total) * 1000) / 10, files: index, total, bytes: written, name: rawName });

      if (stripped.length === 0) {
        report();
        zipfile.readEntry();
        return;
      }

      let target;
      try {
        target = safeJoin(destDir, stripped.join('/'));
      } catch (error) {
        fail(error);
        return;
      }

      if (isDir) {
        ensureDir(target).then(() => { report(); zipfile.readEntry(); }, fail);
        return;
      }

      ensureDir(path.dirname(target)).then(() => {
        zipfile.openReadStream(entry, (err, readStream) => {
          if (err) { fail(err); return; }
          const out = fs.createWriteStream(target, { mode: entry.externalFileAttributes ? (entry.externalFileAttributes >>> 16) & 0o777 || 0o644 : 0o644 });
          readStream.on('error', fail);
          out.on('error', fail);
          readStream.on('data', (chunk) => { written += chunk.length; });
          out.on('close', () => { report(); zipfile.readEntry(); });
          readStream.pipe(out);
        });
      }, fail);
    });

    zipfile.readEntry();
  });
}

/** 解压后，GitHub zipball 会多一层 <repo>-<sha>/ —— 需要探测并返回该目录。 */
async function detectSingleRoot(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length === 1 && entries.length === 1) return path.join(dir, dirs[0].name);
  return dir;
}

module.exports = { extractZip, detectSingleRoot };
