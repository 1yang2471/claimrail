import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  writeFile(join(dir, '.claimrail', 'decisions.json'), JSON.stringify({ schema: 1, task_class: 'ui-new', forks, ...extra }, null, 2), 'utf8');

const fork = (over = {}) => ({ fork: '滚动区实现', options: ['覆盖式', '留 gutter'], picked: '留 gutter', cost_if_wrong: 'low', verified: false, evidence: null, ...over });

test('伪造一：手写 png + report.json 冒充判过 → 拦', async () => {
  await withRepo(async (dir) => {
    await mkdir(join(dir, '.claimrail/shots'), { recursive: true });
    await writeFile(join(dir, '.claimrail/shots/x.png'), 'PNG');
    await writeFile(
      join(dir, '.claimrail/shots/x.report.json'),
      JSON.stringify({ checks: [{ id: 'anything-i-made-up', ok: true }] }), // 无版本、无 name、id 是编的、四项缺失
    );
    await ledger(dir, [fork({ evidence: { kind: 'render', ref: '.claimrail/shots/x.png', asserts: ['scrollbar-clears-text'] }, verified: true })]);

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
        // 符号必须真的在这个文件里：测量对象不成立时 fanIn 会取不到（→ high），
        // 这条用例要的是"低代价 + 证据不成立"那条路径，别用不存在的符号把前提改掉
        target: { file: 'src/Chat.tsx', symbol: 'scrollbar-gutter' },
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

    const mk = join(dir, '.claimrail/shots');
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

    await ledger(dir, [fork({ target: { file: 'src/清理脚本.mjs', symbol: 'b' }, evidence: { kind: 'render', ref: '.claimrail/shots/s.png', asserts: ['contrast-ok'] }, verified: true })]);
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

const here = dirname(fileURLToPath(import.meta.url));

// 素材取自仓库自带的 test/effects.test.mjs（里面本来就有那些命令形状的用例文本），
// 测试代码自己一个新造危险命令字符串都不写，断言只认 kind 名。
const dangerMaterial = async (dir, rel) => {
  const { cp } = await import('node:fs/promises');
  await cp(join(here, 'effects.test.mjs'), join(dir, rel));
};

test('绕道洞一：先把改动 commit 掉再 check，副作用照样看得见', async () => {
  await withRepo(async (dir) => {
    await dangerMaterial(dir, 'src/helper.mjs');
    await g(dir, ['add', '-A']);
    await g(dir, ['commit', '-qm', '已经提交，工作区干净']);

    await ledger(dir, [fork({ target: { file: 'src/helper.mjs', symbol: 'helper' } })]);
    const r = await check({ cwd: dir });
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, /recursive-delete/, r.text);
  });
});

test('绕道洞二：纯 rename（相对起点只有一行 rename，无内容行）也要扫落地文件', async () => {
  // 关键顺序：危险文件必须在 baseline 之前就存在并已提交。
  // 否则相对起点它算"新增文件"，diff 自带全文，这条用例就什么都没测到（我第一版就是这样）。
  const dir = await mkdtemp(join(tmpdir(), 'fk-ren-'));
  try {
    g(dir, ['init', '-q']);
    g(dir, ['config', 'user.email', 't@t']);
    g(dir, ['config', 'user.name', 't']);
    await mkdir(join(dir, 'docs'), { recursive: true });
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src/base.mjs'), 'export const a = 1;\n');
    await dangerMaterial(dir, join('docs', 'notes-copy.mjs'));
    await g(dir, ['add', '-A']);
    await g(dir, ['commit', '-qm', 'docs 里的素材早于起点']);

    await init({ cwd: dir }); // baseline = 现在，之后只有 mv

    await g(dir, ['mv', 'docs/notes-copy.mjs', 'src/notes-copy.mjs']);
    await g(dir, ['commit', '-qm', '搬进执行区']);

    // 先确认这个 diff 里真的只有 rename、没有内容行
    const raw = g(dir, ['diff', (await readFile(join(dir, '.claimrail', 'baseline'), 'utf8')).trim(), '--no-color']);
    assert.match(raw, /rename from docs\/notes-copy\.mjs/, raw.slice(0, 400));
    assert.equal(raw.includes('+rm -rf'), false, 'diff 里居然带了内容行，这条用例测不到纯 rename');

    // 同上：target 要能成立，否则覆盖原因会变成"引用数取不到"，测不到副作用那一条
    await ledger(dir, [fork({ target: { file: 'src/notes-copy.mjs' } })]);
    const r = await check({ cwd: dir });
    assert.match(r.text, /recursive-delete/, r.text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('没有 baseline 时不许静默缩小扫描范围，要当场说明', async () => {
  await withRepo(async (dir) => {
    const { rm: rmf } = await import('node:fs/promises');
    await rmf(join(dir, '.claimrail', 'baseline'), { force: true });
    await ledger(dir, [], { no_fork_reason: '本次只动了 baseline 文件，没有设计分叉' });
    const r = await check({ cwd: dir, diffText: null });
    assert.match(r.text, /没有 baseline/, r.text);
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
    const mk = join(dir, '.claimrail/shots');
    await mkdir(mk, { recursive: true });
    await writeFile(join(mk, 'e.png'), 'PNG');
    const ids = ['scrollbar-clears-text', 'touch-targets-ok', 'contrast-ok', 'focus-visible-ok', 'bottom-not-covered'];
    await writeFile(join(mk, 'e.report.json'), JSON.stringify({ report_schema: 1, name: 'e', checks: ids.map((id) => ({ id, ok: null, detail: '未采到' })) }));
    await ledger(dir, [fork({ evidence: { kind: 'render', ref: '.claimrail/shots/e.png', asserts: ['contrast-ok'] }, verified: true })]);
    const r = await check({ cwd: dir });
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, /不作数/);
  });
});
