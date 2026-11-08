import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { observe, whyUnknown } from '../src/observe/index.mjs';
import { grade } from '../src/cost.mjs';

// 这一层按 PRD 不做逐命令 mock，直接对一个真 git 仓库跑。
// 不能拿 claimrail 自己的仓库当样本：本仓库发过 0.1.0 之后就有 tag 了，
// "干净未发布"这个前提会随发版变红。改成每次拷一份工作树到临时目录、重新 init，
// 这样测试的前提由测试自己造，不受发版状态影响。
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let repo;

before(async () => {
  repo = await mkdtemp(join(tmpdir(), 'fk-observe-'));
  const skip = (p) => !/[\\/](node_modules|\.git|\.claimrail|memory)([\\/]|$)/.test(p);
  await cp(root, join(repo, 'wt'), { recursive: true, filter: skip });
  repo = join(repo, 'wt');
  const g = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  g(['init', '-q']);
  g(['config', 'user.email', 'observe@example.invalid']);
  g(['config', 'user.name', 'observe']);
  g(['add', '-A']);
  g(['commit', '-qm', 'init']);
});

after(async () => {
  if (repo) await rm(join(dirname(repo)), { recursive: true, force: true });
});

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

// 大仓库不许因为文件多就交 null。实测 6000 个文件全量 stat 只需 148ms——
// 5000 这个上限保护的是不存在的性能问题，代价是大 monorepo 的 render 证据全军覆没。
test('文件数超过旧上限时仍然给出时间戳，而不是 null', async () => {
  const { newestTrackedMtime } = await import('../src/observe/git.mjs');
  const { writeFile, utimes } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'cr-many-'));
  try {
    const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    g(['init', '-q']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    // 5200 个文件：刚好越过旧的 5000 上限
    for (let i = 0; i < 52; i++) {
      const d = join(dir, `d${i}`);
      await mkdir(d, { recursive: true });
      const names = [];
      for (let j = 0; j < 100; j++) names.push(`f${j}.txt`);
      await Promise.all(names.map((n) => writeFile(join(d, n), 'x')));
    }
    g(['add', '-A']);
    g(['commit', '-qm', 'many']);

    const target = join(dir, 'd0', 'f0.txt');
    const future = new Date(Date.now() + 5_000);
    await utimes(target, future, future);

    const newest = await newestTrackedMtime(dir);
    assert.equal(typeof newest, 'number', `超过 5000 文件就返回了 ${newest}，大仓库的 render 证据会全失效`);
    assert.ok(newest >= future.getTime(), `最新时间戳没被算进去：${newest} < ${future.getTime()}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 审查抓到的可绕过：测量对象是模型自己填的（target 来自台账），而 fanIn 是便宜/贵的
// 唯一输入之一。指向一个不存在的路径，grep 出来必然是 0 → 代价判 low → 不覆写、不打断。
test('测量对象不存在时不许给出"0 处引用"这个假零', async () => {
  const ghost = await observe({ file: 'src/does-not-exist.mjs' }, { cwd: repo, diffText: '' });
  assert.equal(ghost.fanIn, null, `不存在的文件被算成 ${ghost.fanIn} 处引用`);
  assert.equal(grade(ghost), 'high');

  const typo = await observe({ file: 'src/cost.mjs', symbol: 'NOT_A_REAL_SYMBOL' }, { cwd: repo, diffText: '' });
  assert.equal(typo.fanIn, null, `文件里没有的符号被算成 ${typo.fanIn} 处引用`);
});

// 文件级 fan-in 必须认相对写法：调用方写的是 `./helper.mjs`，而 target 给的是仓库
// 相对路径 `src/helper.mjs`。拿后者做精确匹配，被三处 import 的文件会算成 0 处引用。
test('文件级 fan-in 要认相对写法：./helper.mjs 也算引用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-refs-'));
  try {
    const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    g(['init', '-q']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'helper.mjs'), 'export const helper = 1;\n', 'utf8');
    for (const n of ['a', 'b', 'c']) {
      await writeFile(join(dir, 'src', `${n}.mjs`), `import { helper } from './helper.mjs';\nconsole.log(helper);\n`, 'utf8');
    }
    g(['add', '-A']);
    g(['commit', '-qm', 'init']);

    const obs = await observe({ file: 'src/helper.mjs' }, { cwd: dir, diffText: '' });
    assert.equal(obs.fanIn, 3, `./helper.mjs 的三处引用没被算进来：${obs.fanIn}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
