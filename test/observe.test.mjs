import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { observe, whyUnknown } from '../src/observe/index.mjs';
import { grade } from '../src/cost.mjs';

// 这一层按 PRD 不做逐命令 mock，直接对 forklight 自己的仓库跑：
// 它是手头唯一的真 git 仓库，而且正好是 PRD 点名的最大风险形状——
// 一个没有任何 tag、也没有上游的仓库。
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

test('干净未发布仓库：published 是空数组而不是 null', async () => {
  const obs = await observe({ file: 'src/cost.mjs', symbol: 'FAN_IN_HIGH' }, { cwd: repo, diffText: '' });
  assert.deepEqual(obs.published, []);
  assert.deepEqual(obs.irreversible, []);
});

test('引用数从 git grep 读出来，是个有限的数', async () => {
  const obs = await observe({ file: 'src/cost.mjs', symbol: 'FAN_IN_HIGH' }, { cwd: repo, diffText: '' });
  assert.equal(typeof obs.fanIn, 'number');
  assert.ok(obs.fanIn >= 1);
});

test('没有测量对象时不硬猜，档位随之升 high', async () => {
  const obs = await observe(undefined, { cwd: repo, diffText: '' });
  assert.equal(obs.fanIn, null);
  assert.equal(grade(obs), 'high');
});

test('排除定义所在文件：自己引用自己不涨 fan-in', async () => {
  const selfExcluded = await observe({ file: 'src/observe/effects.mjs', symbol: 'EFFECT_KINDS' }, { cwd: repo, diffText: '' });
  const selfIncluded = await observe({ symbol: 'EFFECT_KINDS' }, { cwd: repo, diffText: '' });
  assert.equal(typeof selfExcluded.fanIn, 'number');
  assert.ok(selfIncluded.fanIn > selfExcluded.fanIn, '定义文件里的那一次不该算引用');
  assert.equal(grade(selfExcluded), 'low');
});

test('diff 里的执行动作仍会被扫到', async () => {
  const d = ['diff --git a/scripts/cleanup.sh b/scripts/cleanup.sh', '@@ -0,0 +1 @@', '+rm -rf ./cache'].join('\n');
  const obs = await observe({ file: 'src/cost.mjs', symbol: 'FAN_IN_HIGH' }, { cwd: repo, diffText: d });
  assert.deepEqual(obs.irreversible, ['recursive-delete']);
  assert.equal(grade(obs), 'high');
});

test('取不到的输入要能指名道姓地说出来', () => {
  const missing = whyUnknown({ fanIn: null, published: null, irreversible: [] });
  assert.equal(missing.length, 2);
  assert.match(missing[0], /引用数/);
  assert.match(missing[1], /发布状态/);
  assert.deepEqual(whyUnknown({ fanIn: 0, published: [], irreversible: [] }), []);
});

test('规则表自身与测试数据不会被当成副作用', async () => {
  const d = ["diff --git a/test/x.test.mjs b/test/x.test.mjs", '@@ -0,0 +1 @@', "+'rm -rf /'"].join('\n');
  const obs = await observe({ file: 'src/cost.mjs', symbol: 'FAN_IN_HIGH' }, { cwd: repo, diffText: d });
  assert.deepEqual(obs.irreversible, []);
});

test('不在 git 仓库里时三个输入都取不到，档位必须升 high', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-nogit-'));
  try {
    const obs = await observe({ file: 'a.mjs', symbol: 'x' }, { cwd: dir, diffText: null });
    assert.equal(obs.fanIn, null, 'git grep 失败不能降级成"0 处引用"');
    assert.equal(obs.published, null);
    assert.equal(obs.irreversible, null, '读不到 diff 不能当成"没有副作用"');
    assert.equal(grade(obs), 'high');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('git 退出码归类：缺 git 是"未知"，不是"0 处引用"', async () => {
  const { mapGrepExit } = await import('../src/observe/git.mjs');
  assert.equal(mapGrepExit(0, 'a.mjs:3'), 'matches');
  assert.equal(mapGrepExit(1, ''), 'none');
  assert.equal(mapGrepExit(1, '  \n'), 'none');
  assert.equal(mapGrepExit(-1, ''), 'unknown', '缺 git / 启动失败必须是未知');
  assert.equal(mapGrepExit(128, ''), 'unknown', '不在 git 仓库里');
  assert.equal(mapGrepExit(2, ''), 'unknown');
  assert.equal(mapGrepExit(1, 'a.mjs:2'), 'unknown', '退出码 1 却带输出，是异常不是零');
});
