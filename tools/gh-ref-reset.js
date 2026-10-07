'use strict';
/**
 * 把远端分支指针重置到指定提交（默认强制）。
 * 用途：发布工具走的是 Git Data API，偶尔需要回退分支；也方便把多余提交从历史里摘掉。
 *
 * 用法（通常由 tools/push-to-github.ps1 注入令牌后调用）：
 *   node tools/gh-ref-reset.js <owner>/<repo> <branch> <sha> [--no-force]
 */
const API = 'https://api.github.com';
const TOKEN = process.env.GH_TOKEN || '';
const [slug, branch = 'main', sha = '', ...rest] = process.argv.slice(2);
const force = !rest.includes('--no-force');

if (!TOKEN || !slug || !sha) {
  console.error('用法：node tools/gh-ref-reset.js <owner>/<repo> <branch> <sha> [--no-force]');
  process.exit(1);
}

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
  const target = await api('GET', `/repos/${slug}/git/commits/${sha}`);
  if (!target.ok) {
    console.error(`找不到提交 ${sha}：HTTP ${target.status}`);
    process.exit(2);
  }
  const res = await api('PATCH', `/repos/${slug}/git/refs/heads/${branch}`, { sha, force });
  if (!res.ok) {
    console.error(`重置失败：HTTP ${res.status} ${res.text.slice(0, 200)}`);
    process.exit(3);
  }
  console.log(`已将 ${slug} 的 ${branch} 重置到 ${sha.slice(0, 10)}（force=${force}）`);
  const list = await api('GET', `/repos/${slug}/commits?per_page=5`);
  if (list.ok && Array.isArray(list.json)) {
    console.log(`当前分支提交数（前 5 条）：${list.json.length}`);
    list.json.forEach((c) => console.log(`  ${c.sha.slice(0, 10)}  ${c.commit.message.split('\n')[0]}`));
  }
})();
