'use strict';
/**
 * 把本机 SSH 公钥注册到 GitHub（令牌通过环境变量 GH_TOKEN 传入，不落盘、不打印）。
 *
 * 两种模式：
 *  1) 账号级公钥：需要令牌具备 admin:public_key 权限（多数 OAuth 令牌没有）；
 *  2) 部署密钥（Deploy Key）：只需令牌有 repo 权限，把公钥加到指定仓库并授予写权限，
 *     同样可以用 `git push`，只是作用范围限于该仓库。
 *
 * 用法：
 *   node tools/gh-add-ssh-key.js [公钥文件] [标题] [owner/repo]
 *   给了 owner/repo 就优先按部署密钥添加；否则尝试账号级公钥。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const API = 'https://api.github.com';
const TOKEN = process.env.GH_TOKEN || '';
const pubPath = process.argv[2] || path.join(os.homedir(), '.ssh', 'id_ed25519.pub');
const title = process.argv[3] || `SnowLuma-AstrBot-Console (${os.hostname()})`;
const slug = process.argv[4] || '';

if (!TOKEN) {
  console.error('缺少 GH_TOKEN（请通过 tools/push-to-github.ps1 调用）');
  process.exit(1);
}
if (!fs.existsSync(pubPath)) {
  console.error(`找不到公钥文件：${pubPath}`);
  process.exit(2);
}
const key = fs.readFileSync(pubPath, 'utf8').trim().split(/\r?\n/)[0].trim();

async function api(method, url, body) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'snowluma-astrbot-console-publisher',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  return { ok: res.ok, status: res.status, json, text };
}

(async () => {
  const me = await api('GET', '/user');
  if (!me.ok) {
    console.error(`令牌无效：HTTP ${me.status}`);
    process.exit(3);
  }
  const owner = me.json.login;
  const shorthand = key.split(/\s+/)[1];

  // 模式 2：部署密钥（只需 repo 权限）
  if (slug) {
    const list = await api('GET', `/repos/${slug}/keys`);
    if (list.ok && Array.isArray(list.json)) {
      const dup = list.json.find((k) => String(k.key).trim().split(/\s+/)[1] === shorthand);
      if (dup) {
        console.log(`该公钥已是 ${slug} 的部署密钥（id=${dup.id}，标题：${dup.title}，只读：${dup.read_only}）`);
        if (dup.read_only) {
          console.log('⚠ 该部署密钥是只读的，推送会被拒绝；请到仓库 Settings → Deploy keys 勾选写权限，或删除后重新添加。');
        }
        return;
      }
      console.log(`仓库 ${slug} 现有 ${list.json.length} 个部署密钥`);
    }
    const addedDeploy = await api('POST', `/repos/${slug}/keys`, { title, key, read_only: false });
    if (addedDeploy.ok) {
      console.log(`✔ 已添加为部署密钥（含写权限）：${addedDeploy.json.title}`);
      console.log('  说明：部署密钥只对这一个仓库有效；账号级公钥需要 admin:public_key 权限，本令牌没有。');
      return;
    }
    console.error(`✘ 部署密钥添加失败：HTTP ${addedDeploy.status} ${addedDeploy.text.slice(0, 200)}`);
    process.exit(4);
  }

  // 模式 1：账号级公钥
  const existing = await api('GET', '/user/keys');
  if (existing.ok && Array.isArray(existing.json)) {
    const dup = existing.json.find((k) => String(k.key).trim().split(/\s+/)[1] === shorthand);
    if (dup) {
      console.log(`该公钥已存在于账号中（id=${dup.id}，标题：${dup.title}），无需重复添加`);
      return;
    }
    console.log(`当前账号已有 ${existing.json.length} 个公钥`);
  } else if (!existing.ok) {
    console.log(`读取账号公钥列表失败（HTTP ${existing.status}）：${existing.text.slice(0, 160)}`);
  }

  const added = await api('POST', '/user/keys', { title, key });
  if (added.ok) {
    console.log(`✔ 公钥已注册：${added.json.title}`);
    console.log(`  指纹：${added.json.fingerprint}`);
    console.log('  可在 https://github.com/settings/keys 查看或删除');
  } else {
    console.error(`✘ 注册失败：HTTP ${added.status} ${added.text.slice(0, 200)}`);
    console.error('  （令牌缺少 admin:public_key 权限。可改用部署密钥模式：追加参数 owner/repo）');
    process.exit(5);
  }
})();
