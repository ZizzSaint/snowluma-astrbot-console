'use strict';
/**
 * 创建 GitHub Release 并上传附件（走 api.github.com / uploads.github.com）。
 * 令牌通过环境变量 GH_TOKEN 传入（见 tools/push-to-github.ps1），不落盘、不打印。
 *
 * 用法：node tools/publish-release.js <owner/repo> <tag> <标题> <说明文件.md> <附件1> [附件2 ...]
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const TOKEN = process.env.GH_TOKEN || '';
const [slug, tag, title, notesPath, ...assets] = process.argv.slice(2);

if (!TOKEN || !slug || !tag || !title || !notesPath) {
  console.error('用法：node tools/publish-release.js <owner/repo> <tag> <标题> <说明文件.md> <附件...>');
  process.exit(1);
}

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* ignore */ }
        resolve({ status: res.statusCode, json, text: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function api(method, url, payload) {
  const body = payload ? Buffer.from(JSON.stringify(payload)) : null;
  return request({
    method,
    hostname: 'api.github.com',
    path: url,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'snowluma-astrbot-console-publisher',
      ...(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}),
    },
  }, body);
}

/** 流式上传附件，带进度输出（大文件不占内存）。 */
function uploadAssetOnce(uploadUrl, file, label) {
  return new Promise((resolve, reject) => {
    const stat = fs.statSync(file);
    const url = new URL(uploadUrl);
    const req = https.request({
      method: 'POST',
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'snowluma-astrbot-console-publisher',
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        Connection: 'close',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* ignore */ }
        resolve({ status: res.statusCode, json, text: data });
      });
    });
    req.on('error', reject);

    const stream = fs.createReadStream(file, { highWaterMark: 1 << 20 });
    let sent = 0;
    let lastLog = Date.now();
    const started = Date.now();
    stream.on('data', (chunk) => {
      sent += chunk.length;
      const now = Date.now();
      if (now - lastLog > 10000 || sent === stat.size) {
        lastLog = now;
        const pct = ((sent / stat.size) * 100).toFixed(1);
        const secs = (now - started) / 1000;
        const speed = sent / 1024 / 1024 / Math.max(secs, 0.001);
        console.log(`   ${label} ${pct}%  ${(sent / 1048576).toFixed(1)}/${(stat.size / 1048576).toFixed(1)} MB  ${speed.toFixed(2)} MB/s`);
      }
    });
    stream.on('error', reject);
    stream.pipe(req);
  });
}

/**
 * 带重试的上传：慢速/不稳定网络下长连接可能被中途重置，重试从头开始（GitHub 不支持断点续传）。
 * 次数由 GH_UPLOAD_ATTEMPTS 控制（默认 3）。
 */
async function uploadAsset(uploadUrl, file, label) {
  const attempts = Math.max(1, Number(process.env.GH_UPLOAD_ATTEMPTS || 3));
  let lastError = '';
  for (let i = 1; i <= attempts; i += 1) {
    if (i > 1) console.log(`   第 ${i}/${attempts} 次尝试…`);
    try {
      const res = await uploadAssetOnce(uploadUrl, file, label);
      if (res.status === 201) return res;
      lastError = `HTTP ${res.status} ${res.text.slice(0, 200)}`;
      console.error(`   失败：${lastError}`);
    } catch (error) {
      lastError = String(error && error.message);
      console.error(`   连接中断：${lastError}`);
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, 5000));
  }
  return { status: 0, text: lastError, json: null };
}

/**
 * 慢速/易断网络下的分片模式：GH_PARTS_MB=20 时，大于该体积的附件会被切成 20 MB 分片上传，
 * 每片单独重试，并附带分片清单与合并脚本。分片之间并发上传（GH_PARTS_CONCURRENCY，默认 3）。
 */
function splitFile(file, partMb, outDir) {
  const stat = fs.statSync(file);
  const base = path.basename(file);
  const partSize = Math.max(1, Math.floor(partMb)) * 1024 * 1024;
  const total = Math.ceil(stat.size / partSize);
  fs.mkdirSync(outDir, { recursive: true });
  const fd = fs.openSync(file, 'r');
  const parts = [];
  try {
    for (let i = 0; i < total; i += 1) {
      const start = i * partSize;
      const length = Math.min(partSize, stat.size - start);
      const name = `${base}.part${String(i + 1).padStart(2, '0')}`;
      const dest = path.join(outDir, name);
      const buf = Buffer.allocUnsafe(length);
      fs.readSync(fd, buf, 0, length, start);
      fs.writeFileSync(dest, buf);
      parts.push({ name, path: dest, size: length, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
    }
  } finally {
    fs.closeSync(fd);
  }

  const whole = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const manifest = [
    `# ${base}`,
    `# size: ${stat.size} bytes (${(stat.size / 1048576).toFixed(2)} MB)`,
    `# sha256(whole): ${whole}`,
    '# parts are ordered by file name',
    ...parts.map((p) => `${p.sha256}  ${p.name}`),
    '',
  ].join('\n');
  const manifestPath = path.join(outDir, `${base}.parts.txt`);
  fs.writeFileSync(manifestPath, manifest, 'utf8');

  const joinScript = `@echo off
rem ============================================================
rem  Join the split parts of ${base} back into one file, then
rem  print its SHA256 for verification.
rem  Put this script next to the .part01/.part02/... files and
rem  double-click it.
rem  (ASCII only on purpose: cmd.exe reads .cmd files in the OEM
rem   codepage, so non-ASCII text would break the script.)
rem ============================================================
setlocal
set TARGET=${base}
cd /d "%~dp0"

if exist "%TARGET%" del /f /q "%TARGET%"

set FOUND=0
for %%F in ("%TARGET%.part*") do (
  set FOUND=1
  echo Joining %%F ...
  if exist "%TARGET%" (
    copy /b "%TARGET%"+"%%F" "%TARGET%.joining" >nul
    move /y "%TARGET%.joining" "%TARGET%" >nul
  ) else (
    copy /b "%%F" "%TARGET%" >nul
  )
)

if "%FOUND%"=="0" (
  echo No part files found. Make sure this script sits next to %TARGET%.part01 ...
  pause
  exit /b 1
)

echo.
echo Joined: %TARGET%
echo.
echo SHA256 of the result:
certutil -hashfile "%TARGET%" SHA256
echo.
echo Expected SHA256 is listed in ${base}.parts.txt
pause
`;
  const joinPath = path.join(outDir, 'join-installer.cmd');
  fs.writeFileSync(joinPath, joinScript, 'ascii');
  return { parts, manifestPath, joinPath, whole };
}

async function mapLimit(items, limit, worker) {
  const results = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

(async () => {
  const notes = fs.readFileSync(path.resolve(notesPath), 'utf8');
  const partsMb = Number(process.env.GH_PARTS_MB || 0);
  const concurrency = Math.max(1, Number(process.env.GH_PARTS_CONCURRENCY || 3));
  const workDir = path.resolve('dist-installer', '.parts');

  console.log(`1) 准备 Release ${tag}`);
  let release = (await api('GET', `/repos/${slug}/releases/tags/${tag}`)).json;
  if (release && release.id) {
    console.log(`   已存在（id=${release.id}），复用并更新说明`);
    const updated = await api('PATCH', `/repos/${slug}/releases/${release.id}`, { name: title, body: notes });
    if (updated.json) release = updated.json;
  } else {
    const created = await api('POST', `/repos/${slug}/releases`, {
      tag_name: tag,
      target_commitish: 'main',
      name: title,
      body: notes,
      draft: false,
      prerelease: false,
    });
    if (created.status !== 201) {
      console.error(`   创建失败：HTTP ${created.status} ${created.text.slice(0, 300)}`);
      process.exit(2);
    }
    release = created.json;
    console.log(`   已创建：${release.html_url}`);
  }

  const existingAssets = new Map((release.assets || []).map((a) => [a.name, a]));

  async function uploadOne(file, name) {
    if (existingAssets.has(name)) {
      const old = existingAssets.get(name);
      console.log(`   同名附件已存在，先删除旧的：${name}`);
      await api('DELETE', `/repos/${slug}/releases/assets/${old.id}`);
      existingAssets.delete(name);
    }
    const mb = (fs.statSync(file).size / 1048576).toFixed(1);
    console.log(`   上传 ${name}（${mb} MB）…`);
    const res = await uploadAsset(
      `https://uploads.github.com/repos/${slug}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
      file,
      name,
    );
    if (res.status !== 201) {
      console.error(`   上传失败：${res.text.slice(0, 300)}`);
      process.exit(4);
    }
    console.log(`   ✔ ${res.json.name}  ${(res.json.size / 1048576).toFixed(1)} MB  digest=${res.json.digest || 'n/a'}`);
    return res.json;
  }

  for (const asset of assets) {
    const file = path.resolve(asset);
    const name = path.basename(file);
    if (!fs.existsSync(file)) {
      console.error(`   附件不存在：${file}`);
      process.exit(3);
    }
    const sizeBytes = fs.statSync(file).size;

    if (partsMb > 0 && sizeBytes > partsMb * 1024 * 1024) {
      // 分片模式：并发上传，每片单独重试（慢速链路下单条长连接容易被重置）
      console.log(`2) ${name} 超过 ${partsMb} MB，按 ${partsMb} MB 分片上传（并发 ${concurrency}）…`);
      const { parts, manifestPath, joinPath, whole } = splitFile(file, partsMb, workDir);
      console.log(`   切成 ${parts.length} 片，整包 sha256=${whole}`);
      await mapLimit(parts, concurrency, async (part) => {
        await uploadOne(part.path, part.name);
      });
      await uploadOne(joinPath, 'join-installer.cmd');
      await uploadOne(manifestPath, `${name}.parts.txt`);
      console.log(`   提示：下载全部分片 + join-installer.cmd，放在同一目录双击即可合并（脚本会打印 SHA256 供校验）`);
    } else {
      console.log(`2) 上传 ${name}…`);
      await uploadOne(file, name);
    }
  }

  const final = (await api('GET', `/repos/${slug}/releases/tags/${tag}`)).json;
  console.log('\n完成：');
  console.log(`  Release：${final.html_url}`);
  console.log(`  标签：${final.tag_name}  附件 ${final.assets.length} 个`);
  final.assets.forEach((a) => {
    console.log(`   - ${a.name}  ${(a.size / 1048576).toFixed(1)} MB`);
    console.log(`     ${a.browser_download_url}`);
  });
})();
