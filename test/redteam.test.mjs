import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { check, init, recordCmd, invalidateCmd, rulesCmd } from '../src/cli.mjs';

// 这一层测的是产品存在的理由：模型能不能不实做却拿到"已验证"。
// 前面 170 多个测试全是老实 ctx 的用例， trouble-maker 当场复现出三条伪造路径。
// 素材全用仓库自带的真实文本形状，不新造危险代码。

const g = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

const withRepo = async (fn) => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-red-'));
  try {
    g(dir, ['init', '-q']);
    g(dir, ['config', 'user.email', 't@t']);
    g(dir, ['config', 'user.name', 't']);
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src/base.mjs'), 'export const a = 1;\n');
    await g(dir, ['add', '-A']);
    await g(dir, ['commit', '-qm', 'init']);
    await init({ cwd: dir });
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const ledger = (dir, forks, extra = {}) =>
  writeFile(join(dir, '.forklight', 'decisions.json'), JSON.stringify({ schema: 1, task_class: 'ui-new', forks, ...extra }, null, 2), 'utf8');

const fork = (over = {}) => ({ fork: '滚动区实现', options: ['覆盖式', '留 gutter'], picked: '留 gutter', cost_if_wrong: 'low', verified: false, evidence: null, ...over });

test('伪造一：手写 png + report.json 冒充判过 → 拦', async () => {
  await withRepo(async (dir) => {
    await mkdir(join(dir, '.forklight/shots'), { recursive: true });
    await writeFile(join(dir, '.forklight/shots/x.png'), 'PNG');
    await writeFile(
      join(dir, '.forklight/shots/x.report.json'),
      JSON.stringify({ checks: [{ id: 'anything-i-made-up', ok: true }] }), // 无版本、无 name、id 是编的、四项缺失
    );
    await ledger(dir, [fork({ evidence: { kind: 'render', ref: '.forklight/shots/x.png', asserts: ['scrollbar-clears-text'] }, verified: true })]);

    const r = await check({ cwd: dir });
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, /未知检查项|版本不对|缺了/);
  });
});

test('伪造二：引用本次刚写的代码冒充既有做法 → 拦', async () => {
  await withRepo(async (dir) => {
    await writeFile(join(dir, 'src/Chat.tsx'), '  scrollbar-gutter: stable;\n  overflow-y: auto;\n');
    await g(dir, ['add', 'src/Chat.tsx']);
    await ledger(dir, [
      fork({
        target: { file: 'src/Chat.tsx', symbol: 'scrollbarGutter' },
        evidence: { kind: 'repo', ref: 'src/Chat.tsx:1', asserts: ['scrollbar-gutter'] },
        verified: true,
      }),
    ]);

    const r = await check({ cwd: dir });
    // 低代价 + 证据不成立 = 照做但必须进末尾汇总（锁定的降级规则），不是静默通过
    assert.match(r.text, /本次改动新增/, r.text);
    assert.match(r.text, /未验证 1 条/, r.text);
    assert.doesNotMatch(r.text, /已重读确认/, r.text);
  });
});

test('伪造三：先 commit 再 check 绕开副作用扫描 → 未跟踪与暂存都要扫到', async () => {
  await withRepo(async (dir) => {
    await writeFile(join(dir, 'src/cleanup.mjs'), 'execSync("rm -rf /home/user/data");\n');
    await g(dir, ['add', 'src/cleanup.mjs']);
    await ledger(dir, [fork({ target: { file: 'src/base.mjs', symbol: 'a' }, verified: false })]);

    const r = await check({ cwd: dir });
    assert.match(r.text, /已发布或有副作用：recursive-delete|命中 recursive-delete/, r.text);
    assert.equal(r.code, 1, r.text);
  });
});

test('伪造四：未跟踪的删除脚本对档位完全隐身 → 现在算副作用', async () => {
  await withRepo(async (dir) => {
    await writeFile(join(dir, 'wipe.mjs'), 'fs.rmSync(dir, { recursive: true });\n'); // 从不 git add
    await ledger(dir, [fork({ target: { file: 'src/base.mjs', symbol: 'a' } })]);
    const r = await check({ cwd: dir });
    assert.match(r.text, /recursive-delete/, r.text);
  });
});

test('中文文件名：旧截图不许因为路径被转义而蒙过新鲜度', async () => {
  await withRepo(async (dir) => {
    await writeFile(join(dir, 'src/清理脚本.mjs'), 'export const b = 1;\n');
    await g(dir, ['add', 'src/清理脚本.mjs']);
    await g(dir, ['commit', '-qm', '中文名']);

    const mk = join(dir, '.forklight/shots');
    await mkdir(mk, { recursive: true });
    await writeFile(join(mk, 's.png'), 'PNG');
    await writeFile(
      join(mk, 's.report.json'),
      JSON.stringify({
        report_schema: 1,
        name: 's',
        checks: [
          { id: 'scrollbar-clears-text', ok: true },
          { id: 'touch-targets-ok', ok: true },
          { id: 'contrast-ok', ok: true },
          { id: 'focus-visible-ok', ok: true },
          { id: 'bottom-not-covered', ok: true },
        ],
      }),
    );
    // 把截图时间戳调到过去，再改一次代码：真实 mtime 关系必须被读出来
    const past = new Date(Date.now() - 60_000);
    const { utimes } = await import('node:fs/promises');
    await utimes(join(mk, 's.png'), past, past);

    await ledger(dir, [fork({ target: { file: 'src/清理脚本.mjs', symbol: 'b' }, evidence: { kind: 'render', ref: '.forklight/shots/s.png', asserts: ['contrast-ok'] }, verified: true })]);
    const r = await check({ cwd: dir });
    // 低代价 + 证据不成立 → 照做但当场说出（锁定的降级规则），关键是旧图没被当成新图
    assert.match(r.text, /截图比代码旧/, r.text);
    assert.equal(r.text.includes('晚于最后一次代码改动'), false, r.text);
  });
});

test('非 ASCII 路径必须参与时间戳计算（承重是 -z：git 在该格式下不转义路径）', async () => {
  await withRepo(async (dir) => {
    await writeFile(join(dir, 'src/中文模块.mjs'), 'export const c = 1;\n');
    await g(dir, ['add', 'src/中文模块.mjs']);
    await g(dir, ['commit', '-qm', '中文名']);

    const target = join(dir, 'src', '中文模块.mjs');
    const future = new Date(Date.now() + 5_000);
    const { utimes } = await import('node:fs/promises');
    await utimes(target, future, future);

    const { newestTrackedMtime } = await import('../src/observe/git.mjs');
    const newest = await newestTrackedMtime(dir);
    assert.ok(typeof newest === 'number' && newest >= future.getTime(), `中文名文件的 mtime 没被算进去：newest=${newest} < ${future.getTime()}（多半是 git 把路径八进制转义后 stat 失败被吞掉了）`);
  });
});
test('规则四的代价由程序逐候选算：选更贵的那个照样被拦，自填字段连台账都进不去', async () => {
  await withRepo(async (dir) => {
    // hot 被 40 个文件引用（≥FAN_IN_HIGH），cold 没人引用。两个候选各自带 target。
    const refs = ['const x = hot;'];
    for (let i = 0; i < 40; i++) refs.push(`import { hot } from './hot.mjs'; // ${i}`);
    await writeFile(join(dir, 'src/hot.mjs'), 'export const hot = 1;\n');
    await writeFile(join(dir, 'src/cold.mjs'), 'export const cold = 1;\n');
    await writeFile(join(dir, 'src/refs.mjs'), refs.join('\n') + '\n');
    await g(dir, ['add', '-A']);
    await g(dir, ['commit', '-qm', '引用图']);

    const OPTS = [
      { label: 'hot 旁边', target: { file: 'src/hot.mjs', symbol: 'hot' } },
      { label: 'cold 旁边', target: { file: 'src/cold.mjs', symbol: 'cold' } },
    ];
    const both = (picked) => [
      {
        fork: '这个新符号该放哪',
        options: OPTS,
        picked,
        // 分叉级 target 跟着选中的候选走：否则引用数取不到 → 档位 high → 规则一先拦，
        // 这条用例就测不到规则四的独立作用了
        target: OPTS.find((o) => o.label === picked).target,
        evidence: null,
        cost_if_wrong: 'low',
        verified: false,
      },
    ];

    await ledger(dir, both('hot 旁边'));
    const bad = await check({ cwd: dir });
    assert.equal(bad.code, 1, bad.text);
    assert.match(bad.text, /无证据却选了改起来更贵的候选/, bad.text);

    await ledger(dir, both('cold 旁边'));
    const good = await check({ cwd: dir });
    assert.equal(good.code, 0, good.text);
    assert.match(good.text, /未验证 1 条/, good.text);

    // 自供字段现在连 schema 都过不了
    await ledger(dir, [{ ...both('hot 旁边')[0], options_cost: { 'hot 旁边': 'low', 'cold 旁边': 'high' } }]);
    const self = await check({ cwd: dir });
    assert.match(self.text, /未知字段 "options_cost"/, self.text);
  });
});

test('log 被删一行：所有既有引用当场报错，不静默改指', async () => {
  await withRepo(async (dir) => {
    await recordCmd({ cwd: dir, key: 'k1', what: '第一条原文' });
    await recordCmd({ cwd: dir, key: 'k2', what: '第二条原文' });
    const p = join(dir, 'memory', 'log.jsonl');
    await writeFile(p, (await readFile(p, 'utf8')).split('\n').slice(1).join('\n'));

    await ledger(dir, [fork({ evidence: { kind: 'memory', ref: 'log#2', asserts: ['第二条'] }, verified: true })]);
    const r = await check({ cwd: dir });
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, /行号被改动过|编号是/, r.text);
  });
});

test('denied.json 坏了不能当成"没禁过"，被废的规则不许复活', async () => {
  await withRepo(async (dir) => {
    await recordCmd({ cwd: dir, key: 'gap', what: '卡片间距 8px 太挤' });
    await recordCmd({ cwd: dir, key: 'gap', what: '至少 16px' });
    await invalidateCmd({ cwd: dir, key: 'gap' });
    assert.match((await rulesCmd({ cwd: dir })).text, /现行规则 0 条/);

    await writeFile(join(dir, 'memory', 'denied.json'), '["gap"');
    const r = await rulesCmd({ cwd: dir });
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, /读坏了/);
  });
});

test('诚实台账不该因为描述危险选项而被自己扫成 high', async () => {
  await withRepo(async (dir) => {
    await ledger(dir, [fork({ fork: '发布前要不要 rm -rf 旧缓存并 git push --force 重写历史', options: ['rm -rf 旧缓存', '保留缓存'], picked: '保留缓存' })]);
    const r = await check({ cwd: dir });
    assert.doesNotMatch(r.text, /命中 recursive-delete|已发布或有副作用：recursive-delete/, r.text);
  });
});

test('rules#1 冒充 log#1 一律拒', async () => {
  await withRepo(async (dir) => {
    await recordCmd({ cwd: dir, key: 'gap', what: '至少 16px' });
    await ledger(dir, [fork({ evidence: { kind: 'memory', ref: 'rules#1', asserts: ['16px'] }, verified: true })]);
    const r = await check({ cwd: dir });
    // rules#1 在 schema 就被拒（memory 档只认 log#n），根本轮不到回验
    assert.match(r.text, /格式不符|只接受 log#n/, r.text);
  });
});

test('弱断言一律拒：单字符、跨整文件、第 0 行', async () => {
  await withRepo(async (dir) => {
    for (const [ref, asserts] of [
      ['src/base.mjs:1', ['e']],
      ['src/base.mjs:1-10000', ['export']],
      ['src/base.mjs:0', ['export']],
    ]) {
      await ledger(dir, [fork({ evidence: { kind: 'repo', ref, asserts }, verified: true })]);
      const r = await check({ cwd: dir });
      assert.equal(r.code, 1, `${ref} 居然过了：${r.text}`);
      assert.match(r.text, /要点太短|不可用/, ref);
    }
  });
});

test('空报告全 null 也不能当证据：未判就是未判', async () => {
  await withRepo(async (dir) => {
    const mk = join(dir, '.forklight/shots');
    await mkdir(mk, { recursive: true });
    await writeFile(join(mk, 'e.png'), 'PNG');
    const ids = ['scrollbar-clears-text', 'touch-targets-ok', 'contrast-ok', 'focus-visible-ok', 'bottom-not-covered'];
    await writeFile(join(mk, 'e.report.json'), JSON.stringify({ report_schema: 1, name: 'e', checks: ids.map((id) => ({ id, ok: null, detail: '未采到' })) }));
    await ledger(dir, [fork({ evidence: { kind: 'render', ref: '.forklight/shots/e.png', asserts: ['contrast-ok'] }, verified: true })]);
    const r = await check({ cwd: dir });
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, /不作数/);
  });
});
