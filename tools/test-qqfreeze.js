'use strict';
/**
 * 冻结 QQ 自动更新功能自检：
 *  1) 纯逻辑验证（hosts 内容构造/还原、幂等、他人记录识别）
 *  2) 只有当当前进程真能写 hosts 时才做真实冻结→解除循环（避免触发 UAC 卡住自动化）
 */
const q = require('../app/main/qqfreeze');

const { buildFreezeBuffer, buildUnfreezeBuffer, stripBlock, hasBlockedDomain, isWritable } = q._internal;

const SAMPLE = [
  '# Copyright (c) 1993-2009 Microsoft Corp.',
  '#',
  '127.0.0.1 localhost',
  '::1 localhost',
  '192.168.1.10 nas.local',
  '',
].join('\r\n');

let pass = true;
const check = (name, ok, extra = '') => {
  if (!ok) pass = false;
  console.log(`${ok ? '✔' : '✘'} ${name}${extra ? ` — ${extra}` : ''}`);
};

// 1) 冻结后标记块存在且包含目标域名
const frozen = buildFreezeBuffer(SAMPLE).toString('utf8');
check('冻结内容包含标记块', frozen.includes(q.MARK_BEGIN) && frozen.includes(q.MARK_END));
check('冻结内容包含 0.0.0.0 qqpatch.gtimg.cn', frozen.includes('0.0.0.0 qqpatch.gtimg.cn'));
check('原有 hosts 行未被破坏', frozen.includes('127.0.0.1 localhost') && frozen.includes('192.168.1.10 nas.local'));

// 2) 解除后应完全还原（除行尾空行外）
const unfrozen = buildUnfreezeBuffer(frozen).toString('utf8');
const normalize = (s) => s.replace(/\r\n/g, '\n').trimEnd();
check('解除后内容与原始一致', normalize(unfrozen) === normalize(SAMPLE), JSON.stringify(normalize(unfrozen)));

// 3) 幂等：重复冻结不会叠加标记块
const twice = buildFreezeBuffer(frozen).toString('utf8');
check('重复冻结只有一个标记块', twice.split(q.MARK_BEGIN).length - 1 === 1);

// 4) 解除时不会误删别人的记录
const foreign = `${SAMPLE}0.0.0.0 qqpatch.gtimg.cn\r\n`;
check('能识别他人写入的冻结记录', hasBlockedDomain(foreign) === true);
check('本应用写入的块同样被识别为已屏蔽', hasBlockedDomain(frozen) === true);
const strippedForeign = stripBlock(foreign);
check('解除只删自己的标记块（不动他人记录）', strippedForeign.removed === 0 && strippedForeign.text.includes('qqpatch.gtimg.cn'));

// 5) 无记录时解除应返回 null
check('无标记块时解除返回 null', buildUnfreezeBuffer(SAMPLE) === null);

// 6) 真实系统状态
const status = q.status();
console.log(`\nhosts 路径：${status.hostsPath}`);
console.log(`当前状态：${status.frozen ? '已冻结' : '未冻结'}（本应用写入：${status.ours}，他人写入：${status.foreign}）`);
console.log(`当前进程可直接写入 hosts：${status.writable}`);

(async () => {
  if (status.writable) {
    console.log('\n=== 真实冻结 → 解除 循环 ===');
    const before = q.status();
    const f = await q.freeze();
    console.log('冻结结果：', JSON.stringify(f));
    const afterFreeze = q.status();
    check('冻结后状态为已冻结', afterFreeze.frozen === true && afterFreeze.ours === true);
    const u = await q.unfreeze();
    console.log('解除结果：', JSON.stringify(u));
    const afterUnfreeze = q.status();
    check('解除后状态还原', afterUnfreeze.frozen === before.frozen && afterUnfreeze.ours === false);
  } else {
    console.log('\n（当前进程无 hosts 写权限，跳过真实写入测试；应用运行时将通过 UAC 提权完成，行为符合预期）');
  }
  console.log(pass ? '\n✔ 冻结 QQ 自动更新自检通过' : '\n✘ 存在失败项');
  process.exit(pass ? 0 : 1);
})();
