'use strict';
/**
 * 通过 GitHub REST API 把当前仓库推上去。
 *
 * 为什么不用 git push：本机到 github.com:443 的连接被网络阻断（api.github.com / codeload 正常），
 * 所以改用官方 Git Data API 创建仓库 → 上传 blob → 建 tree → 建 commit → 建 ref。
 *
 * 环境变量：
 *   GH_TOKEN   必填，GitHub 令牌（只在本进程内存中使用，不落盘、不打印）
 *   GH_OWNER   可选，默认用令牌对应账号
 *   GH_REPO    必填，仓库名
 *   GH_PRIVATE 可选，'1' 表示私有仓库（默认公开）
 *   GH_BRANCH  可选，默认 main
 *   GH_MESSAGE 可选，提交信息（默认一条汇总式 feat 提交）
 *
 * 说明：如果目标分支已有提交，新提交会以它作为父提交，历史正常累加；
 *      仓库完全为空时（首次创建）才使用无父提交的初始提交。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const API = 'https://api.github.com';
const TOKEN = process.env.GH_TOKEN || '';
const REPO = process.env.GH_REPO || '';
const PRIVATE = process.env.GH_PRIVATE === '1';
const BRANCH = process.env.GH_BRANCH || 'main';
const ROOT = path.resolve(__dirname, '..');

if (!TOKEN) {
  console.error('缺少 GH_TOKEN');
  process.exit(1);
}
if (!REPO) {
  console.error('缺少 GH_REPO');
  process.exit(1);
}

async function api(method, url, body) {
  const res = await fetch(url.startsWith('http') ? url : `${API}${url}`, {
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
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应 */ }
  return { ok: res.ok, status: res.status, json, text };
}

function gitFiles() {
  // -z 用 NUL 分隔，git 不会对中文/特殊字符做引号转义，得到的是原始路径
  const out = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' });
  return out.split('\0').map((s) => s.trim()).filter(Boolean);
}

(async () => {
  console.log('1) 校验令牌');
  const me = await api('GET', '/user');
  if (!me.ok) {
    console.error(`   令牌无效：HTTP ${me.status} ${me.text.slice(0, 200)}`);
    process.exit(2);
  }
  const owner = process.env.GH_OWNER || me.json.login;
  console.log(`   账号：${owner}`);

  console.log(`2) 准备仓库 ${owner}/${REPO}`);
  const existing = await api('GET', `/repos/${owner}/${REPO}`);
  if (existing.ok) {
    console.log('   仓库已存在，将直接上传内容');
  } else if (existing.status === 404) {
    const created = await api('POST', '/user/repos', {
      name: REPO,
      description: 'SnowLuma × AstrBot 一体化控制台：在同一个 Windows 应用里下载、启动并使用 SnowLuma 与 AstrBot（内嵌控制台、一键桥接、数据迁移、冻结 QQ 更新）',
      private: PRIVATE,
      has_issues: true,
      has_wiki: false,
      has_projects: false,
      auto_init: false,
    });
    if (!created.ok) {
      console.error(`   创建失败：HTTP ${created.status} ${created.text.slice(0, 300)}`);
      process.exit(3);
    }
    console.log(`   已创建：${created.json.html_url}`);
  } else {
    console.error(`   查询失败：HTTP ${existing.status} ${existing.text.slice(0, 200)}`);
    process.exit(4);
  }

  const files = gitFiles();
  console.log(`3) 上传 ${files.length} 个文件（Git Data API）`);

  // 全新空仓库的 git database 尚未初始化，直接建 blob 会 409；先用 Contents API 放一个占位文件，
  // 稍后把分支强制指向我们的提交，占位提交就变成不可达对象，历史里只剩一条干净记录。
  const probe = await api('POST', `/repos/${owner}/${REPO}/git/blobs`, {
    content: Buffer.from('probe').toString('base64'),
    encoding: 'base64',
  });
  if (!probe.ok && probe.status === 409) {
    console.log('   空仓库：先用 Contents API 初始化数据库…');
    const init = await api('PUT', `/repos/${owner}/${REPO}/contents/README.md`, {
      message: 'chore: initialize repository',
      content: Buffer.from('# init\n').toString('base64'),
    });
    if (!init.ok) {
      console.error(`   初始化失败：HTTP ${init.status} ${init.text.slice(0, 200)}`);
      process.exit(5);
    }
  } else if (!probe.ok) {
    console.error(`   探测失败：HTTP ${probe.status} ${probe.text.slice(0, 200)}`);
    process.exit(5);
  }

  const tree = [];
  let index = 0;
  let bytes = 0;
  for (const file of files) {
    const full = path.join(ROOT, file);
    const data = fs.readFileSync(full);
    bytes += data.length;
    const blob = await api('POST', `/repos/${owner}/${REPO}/git/blobs`, {
      content: data.toString('base64'),
      encoding: 'base64',
    });
    if (!blob.ok) {
      console.error(`   上传失败 ${file}：HTTP ${blob.status} ${blob.text.slice(0, 200)}`);
      process.exit(5);
    }
    tree.push({ path: file.replace(/\\/g, '/'), mode: '100644', type: 'blob', sha: blob.json.sha });
    index += 1;
    if (index % 10 === 0 || index === files.length) {
      console.log(`   ${index}/${files.length} 个文件（${(bytes / 1024).toFixed(0)} KB）`);
    }
  }

  console.log('4) 创建提交');
  const headRef = await api('GET', `/repos/${owner}/${REPO}/git/ref/heads/${BRANCH}`);
  const parents = headRef.ok && headRef.json && headRef.json.object ? [headRef.json.object.sha] : [];
  if (parents.length) console.log(`   基于现有提交 ${parents[0].slice(0, 10)} 追加`);
  const treeRes = await api('POST', `/repos/${owner}/${REPO}/git/trees`, { tree });
  if (!treeRes.ok) {
    console.error(`   建树失败：HTTP ${treeRes.status} ${treeRes.text.slice(0, 300)}`);
    process.exit(6);
  }
  const message = process.env.GH_MESSAGE || [
    'feat: SnowLuma × AstrBot 一体化控制台',
    '',
    '- 应用内下载/安装/启动/停止/更新 SnowLuma 与 AstrBot，全程不弹终端窗口',
    '- 内嵌两者 WebUI（5099 / 6185），支持一键登录（SnowLuma 表单填充、AstrBot 换取 JWT）',
    '- 更新保留数据：程序目录整体替换，instances/ 数据不动',
    '- 一键桥接：自动写入 AstrBot OneBot v11 反向 WS 与 SnowLuma 反向 WS 客户端配置',
    '- 内置桥接教程、运行日志页、设置页（端口/镜像/pip 源/Python）',
    '- 数据目录迁移（robocopy + 校验 + 切换根目录）与便携模式',
    '- 应用内冻结/解除 QQ 自动更新（hosts 标记块，按需 UAC 提权）',
    '- 多镜像回退下载（断点续传 + SHA256 校验）与 Node/Python/QQ 环境探测',
    '- NSIS 单文件安装包与免安装绿色版打包脚本',
  ].join('\n');

  const commit = await api('POST', `/repos/${owner}/${REPO}/git/commits`, {
    message,
    tree: treeRes.json.sha,
    parents,
  });
  if (!commit.ok) {
    console.error(`   建提交失败：HTTP ${commit.status} ${commit.text.slice(0, 300)}`);
    process.exit(7);
  }
  console.log(`   提交：${commit.json.sha.slice(0, 10)}`);

  console.log(`5) 指向分支 ${BRANCH}`);
  const existingRef = await api('GET', `/repos/${owner}/${REPO}/git/ref/heads/${BRANCH}`);
  const refRes = existingRef.ok
    ? await api('PATCH', `/repos/${owner}/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.json.sha, force: true })
    : await api('POST', `/repos/${owner}/${REPO}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.json.sha });
  if (!refRes.ok) {
    console.error(`   更新分支失败：HTTP ${refRes.status} ${refRes.text.slice(0, 300)}`);
    process.exit(8);
  }

  await api('PATCH', `/repos/${owner}/${REPO}`, {
    default_branch: BRANCH,
    homepage: '',
    has_issues: true,
  });
  await api('PUT', `/repos/${owner}/${REPO}/topics`, {
    names: ['snowluma', 'astrbot', 'qqbot', 'onebot', 'electron', 'windows', 'launcher', 'qqnt'],
  });

  console.log('\n完成：');
  console.log(`  仓库：https://github.com/${owner}/${REPO}`);
  console.log(`  提交：https://github.com/${owner}/${REPO}/commit/${commit.json.sha}`);
  console.log(`  文件：${files.length} 个 / ${(bytes / 1024 / 1024).toFixed(2)} MB`);
})();
