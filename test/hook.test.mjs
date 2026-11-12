import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { check, hook, init } from '../src/cli.mjs';
import { readIncoming } from '../src/commands/hook.mjs';
import { repoWithEvidence, repoWithUnverified } from './helpers.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name) => join('test', 'fixtures', name);

// hooks 层单独一个文件：宿主接线只有这一处，混在 CLI 用例里既挤又看不清。
// 语义：退出码 0 放行、2 是故意阻断（宿主会把 stderr 交给模型续一轮），其它非零会被当成故障。

// hooks 层刻意做薄：宿主在"一次响应结束（交付前）"调它。ZCode 的语义是退出码 0 放行、
// 2 才是故意阻断；其它非零会被宿主当成故障，而不是"拦住"。没有台账 = 这个仓库不在协议里。
test('hook：没台账时静默放行，不制造噪音', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-hook-'));
  try {
    const r = await hook({ cwd: dir });
    assert.equal(r.code, 0);
    assert.equal(r.text, '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('hook：台账通过 → 0；被拦 → 2（2 才是故意阻断）', async () => {
  const dir = await repoWithEvidence();
  try {
    const ok = await hook({ cwd: dir });
    assert.equal(ok.code, 0, ok.text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const blocked = await hook({ cwd: repo, ledger: fixture('ledger-block.json') });
  assert.equal(blocked.code, 2);
  assert.match(blocked.text, /拦住/);
});

// 业界语义（Claude Code / ZCode 同一套）：Stop 的退出码 2 会"续一轮"把 stderr 交给模型。
// 所以已经因 Stop 钩子续过一轮（stop_hook_active）时不能再拦，否则死循环。
test('hook：stop_hook_active 为真时不再阻断（防自锁），但仍然报原因', async () => {
  const again = await hook({ cwd: repo, ledger: fixture('ledger-block.json'), payload: { stop_hook_active: true } });
  assert.equal(again.code, 0, again.text);
  assert.match(again.text, /拦住|block|未验证/, '第二次至少要说明为什么没交付');
});

test('hook：stopHookActive（ZCode 驼峰）同样认', async () => {
  const again = await hook({ cwd: repo, ledger: fixture('ledger-block.json'), payload: { stopHookActive: true } });
  assert.equal(again.code, 0, again.text);
});

// 门对"低代价 + 无证据"是放行但要点名（check 退出码 0）。真模型实测会把这个点名当耳旁风：
// 正文照样写"全部核实"。所以钩子要把未验证条目回给模型续一轮，逼交付说明逐条声明。
// 夹具用临时 git 仓库：本仓库现在有 0.1.0 tag，会把 low 覆写成 high 走 block 路径。
test('hook：低代价未验证也要拦一轮，把条目递给模型去声明', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-hook-unv-'));
  try {
    const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    g(['init', '-q']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    await writeFile(join(dir, 'package.json'), '{\n  "name": "x"\n}\n', 'utf8');
    g(['add', '-A']);
    g(['commit', '-qm', 'init']);
    await mkdir(join(dir, '.claimrail'), { recursive: true });
    const ledger = {
      schema: 1,
      task_class: 'refactor',
      forks: [
        {
          fork: '列表行高用 token 还是写死',
          options: ['token', '写死 24px'],
          picked: 'token',
          target: { file: 'package.json' },
          evidence: null,
          cost_if_wrong: 'low',
          verified: false,
        },
      ],
    };
    await writeFile(join(dir, '.claimrail', 'decisions.json'), JSON.stringify(ledger, null, 2), 'utf8');

    const c = await check({ cwd: dir });
    assert.equal(c.code, 0, c.text);
    assert.equal(c.unverified.length, 1, c.text);

    const first = await hook({ cwd: dir });
    // 宿主没给正文：判不了"有没有声明"，按未判放行；拦下去会在不提供正文的宿主上死循环。
    assert.equal(first.code, 0, first.text);
    assert.match(first.text, /宿主没给交付正文/);
    assert.match(first.text, /列表行高用 token 还是写死/);

    const overclaim = await hook({ cwd: dir, payload: { last_assistant_message: '全部核实，可以交付。' } });
    assert.equal(overclaim.code, 2, overclaim.text);
    assert.match(overclaim.text, /这两句不能同时成立/);

    const declared = await hook({
      cwd: dir,
      payload: { last_assistant_message: '这条我没能验证，原因是列表行高没有证据。' },
    });
    assert.equal(declared.code, 0, declared.text);

    const second = await hook({
      cwd: dir,
      payload: { stop_hook_active: true, last_assistant_message: '全部核实，可以交付。' },
    });
    assert.equal(second.code, 0, second.text);
    assert.match(second.text, /不再重复阻断/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 走真正的命令行入口（起进程），而不是直接调函数。
// 入口层的接线错一次，单元测试会全绿而实际钩子跑不起来——审查时就是这样发现的：
// 拆文件后 readIncoming 没接上，hook 在命令行里返回"没跑成：readIncoming is not defined"。
// hook 的文本走 stderr（退出码才是宿主的接口），所以必须 stdout+stderr 都收，
// 否则"放行但留了原因"的分支测不到输出（execFileSync 只在失败时给 stderr）。
const runCli = (args, { cwd, stdin = '' }) => {
  // 剥掉会话注入的 ZCODE_PROJECT_DIR / CLAUDE_PROJECT_DIR：真实宿主靠它指路，测试里
  // 它是环境泄漏——不剥的话，钩子在 forklight 会话里跑测试会去查 forklight 的台账
  // （2026-11-12 实测：cwd 短路修复后 env 优先级生效，这条泄漏让入口用例看错仓库）。
  const env = { ...process.env };
  delete env.ZCODE_PROJECT_DIR;
  delete env.CLAUDE_PROJECT_DIR;
  const r = spawnSync(process.execPath, [join(repo, 'src', 'cli.mjs'), ...args], { cwd, input: stdin, encoding: 'utf8', env });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

// git 仓库 + 已提交 + init 过（模板台账 + baseline），给入口层用例用。
const repoWithTemplate = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-hook-tpl-'));
  const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  g(['init', '-q']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  await writeFile(join(dir, 'package.json'), '{"name":"probe"}', 'utf8');
  g(['add', '-A']);
  g(['commit', '-qm', 'init']);
  await init({ cwd: dir });
  return dir;
};

test('命令行入口：hook 真的跑得起来，不许停在"没跑成"', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-cli-hook-'));
  try {
    await mkdir(join(dir, '.claimrail'), { recursive: true });
    await writeFile(
      join(dir, '.claimrail', 'decisions.json'),
      JSON.stringify({
        schema: 1,
        task_class: 'ui-new',
        forks: [
          {
            fork: '主视觉风格：跟随系统还是固定深色',
            options: ['跟随系统', '固定深色'],
            picked: '固定深色',
            evidence: null,
            cost_if_wrong: 'low',
            verified: false,
          },
        ],
      }),
      'utf8',
    );

    const blocked = runCli(['hook'], { cwd: dir, stdin: '{}' });
    assert.equal(blocked.code, 2, blocked.out);
    assert.doesNotMatch(blocked.out, /没跑成/);
    assert.match(blocked.out, /拦住/);

    const noLedger = runCli(['hook'], { cwd: await mkdtemp(join(tmpdir(), 'fk-cli-hook2-')), stdin: '{}' });
    assert.equal(noLedger.code, 0, noLedger.out);
    assert.equal(noLedger.out.trim(), '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 审查抓到的 P0：readIncoming 里的 async IIFE 少了一对括号，Promise.race 拿到的是函数
// 而不是 Promise → payload 永远 null → stop_hook_active 在命令行入口从未生效过。
// 这条走真进程 + 真 stdin，钉住"只拦一次"的护栏在入口层也存在。
test('命令行入口：stop_hook_active 经 stdin 生效（防死循环护栏不许只在单元层活着）', async () => {
  const dir = await repoWithTemplate();
  try {
    await writeFile(join(dir, 'work.ts'), 'export const a = 1;\n', 'utf8');
    const first = runCli(['hook'], { cwd: dir, stdin: '{}' });
    assert.equal(first.code, 2, first.out);
    assert.match(first.out, /未申报/);

    const again = runCli(['hook'], { cwd: dir, stdin: JSON.stringify({ stop_hook_active: true }) });
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /不再重复阻断/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 同一个 bug 的另一半：定时器不 unref 时进程要多等 5 秒才退出，宿主每轮 Stop 白等。
test('命令行入口：hook 在流读完时立即返回，不吊着 5 秒定时器', async () => {
  const dir = await repoWithTemplate();
  try {
    const t0 = Date.now();
    runCli(['hook'], { cwd: dir, stdin: '{}' });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 2000, `hook 跑了 ${elapsed}ms：定时器没有随流结束清理`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 2026-11-10 真机复现：stdin 保持打开但不给数据时，只让定时器赢下 Promise.race 不够——
// 挂着的异步迭代器仍持有事件循环，`sleep 12 | hook` 会等到 stdin 关闭（宿主那边是 30s
// 超时），注释里承诺的 5 秒上限形同虚设。超时必须销毁流。
test('readIncoming：stdin 不关也不给数据时，超时上限真的生效', async () => {
  const { PassThrough } = await import('node:stream');
  const stdin = new PassThrough();
  const t0 = Date.now();
  const got = await readIncoming({ stdin, timeoutMs: 60 });
  const elapsed = Date.now() - t0;
  assert.equal(got, null);
  assert.ok(elapsed < 1000, `超时后仍被 stdin 拖住：${elapsed}ms`);
  assert.equal(stdin.destroyed, true, '超时没有销毁流，事件循环仍被持有');
});

test('readIncoming：流正常关闭时返回解析后的 payload', async () => {
  const { PassThrough } = await import('node:stream');
  const stdin = new PassThrough();
  const p = readIncoming({ stdin, timeoutMs: 1000 });
  stdin.end('{"stop_hook_active":true}');
  assert.deepEqual(await p, { stop_hook_active: true });
});

// 审查抓到的误拦：touched 过滤掉协议文件后是 0，但 diff 哈希（含 AGENTS.md）变了，
// 照样进 stale 分支，拦一句"这次改了 0 个文件"。
test('只改已跟踪的协议文件（AGENTS.md）：不触发 stale', async () => {
  const dir = await repoWithEvidence();
  try {
    const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    // 协议文件必须已被 git 跟踪：未跟踪文件不进 diff 哈希，打不到 stale 的真实形状
    await writeFile(join(dir, 'AGENTS.md'), '# r\n', 'utf8');
    g(['add', 'AGENTS.md']);
    g(['commit', '-qm', 'agents']);
    const first = await hook({ cwd: dir });
    assert.equal(first.code, 0, first.text);
    // 快照已记下；第二次：工作区只动了已跟踪的 AGENTS.md（协议脚印），touched 过滤后为 0
    await writeFile(join(dir, 'AGENTS.md'), '# r\n加一行。\n', 'utf8');
    const second = await hook({ cwd: dir });
    assert.equal(second.code, 0, second.text);
    assert.doesNotMatch(second.text, /未申报/);
    assert.doesNotMatch(second.text, /改了 0 个文件/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 宿主插件在任务中途往仓库丢运行时状态（本机实测：.mimosa/hook-state/*.json，每次 Bash 一条）。
// 台账没变、工作区只多了这些噪音：旧逻辑照进 stale 分支——"台账自上次放行后未变"的假警报，
// 还会抢在正文对撞之前触发（UX 审查 #2 实测复现）。
test('hook：工作区只多了宿主插件的运行时状态文件，不触发 stale', async () => {
  const dir = await repoWithEvidence();
  try {
    const first = await hook({ cwd: dir });
    assert.equal(first.code, 0, first.text);
    await mkdir(join(dir, '.mimosa', 'hook-state'), { recursive: true });
    await writeFile(join(dir, '.mimosa', 'hook-state', 'sess_x.json'), '{"ok":1}\n', 'utf8');
    const second = await hook({ cwd: dir });
    assert.equal(second.code, 0, second.text);
    assert.doesNotMatch(second.text, /台账自上次放行后未变/, second.text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// UX 审查 #8：--json 承诺"structured verdict for hosts and scripts"，而新用户最常撞的
// schema 拒收路径只给一坨塞进 error 字符串的中文散文，没有结构化字段。
test('命令行入口：schema 拒收时 --json 给结构化 errors，不是散文', async () => {
  const dir = await repoWithUnverified();
  try {
    await writeFile(join(dir, '.claimrail', 'decisions.json'), JSON.stringify({
      schema: 1, task_class: 'refactor',
      forks: [{ fork: 'x' }],
    }), 'utf8');
    const r = runCli(['check', '--json'], { cwd: dir });
    assert.equal(r.code, 1);
    const data = JSON.parse(r.out);
    assert.equal(data.action, 'error');
    assert.ok(Array.isArray(data.errors) && data.errors.length > 0, '没有结构化 errors 数组');
    assert.match(data.errors[0].path, /forks\[0\]/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 结构化判定（host 面）：同一个 check，既可读文本也可取 JSON。
// 这条走真命令行入口，钉住 --json 的输出形状与退出码语义不变。
test('命令行入口：check --json 输出可解析的结构化判定', async () => {
  const dir = await repoWithUnverified(); // 真 git 仓库：target 能测出引用数，代价判 low
  try {
    const r = runCli(['check', '--json'], { cwd: dir });
    assert.equal(r.code, 0, r.out); // 低代价 + 无证据 = 放行但点名
    const data = JSON.parse(r.out);
    assert.equal(data.schema, 1);
    assert.equal(data.action, 'proceed');
    assert.equal(data.metrics.unverified, 1);
    assert.equal(data.unverified.length, 1);
    assert.match(data.unverified[0].fork, /列表行高/);
    assert.equal(typeof data.unverified[0].picked, 'string');
    assert.equal(typeof data.unverified[0].why, 'string');
    assert.ok(Array.isArray(data.questions) && Array.isArray(data.violations) && Array.isArray(data.notEnabled));
    assert.ok(Array.isArray(data.overrides));
    assert.ok(Array.isArray(data.changedFiles), 'changedFiles 必须总是数组（宿主要靠它知道门看见了什么）');
    assert.equal(data.degraded, null, '真仓库不该报降级');

    // 要求了 JSON 但台账读不到：仍然给 JSON（带 error），不许混出一段中文
    const missing = runCli(['check', '--json', '--ledger', 'nope.json'], { cwd: dir });
    assert.equal(missing.code, 1);
    assert.equal(JSON.parse(missing.out).action, 'error');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 真实日志挖出的接线缺陷（2026-11-12）：CLI 入口把 flags.cwd（=钩子进程自己的
// process.cwd()）传给 hook()，把 payload.cwd 与 ZCODE_PROJECT_DIR 两条解析路短路掉——
// 在别的目录手动跑 hook 会去查错误仓库的台账并静默放行。真实宿主靠 env 兜底才没翻车。
// 这里钉住解析顺序：payload.cwd > ZCODE_PROJECT_DIR > 进程 cwd。
test('命令行入口：hook 的仓库解析顺序 payload.cwd > env > 进程 cwd', async () => {
  const repoA = await repoWithTemplate(); // 无高代价分叉：放行（code 0）
  const repoB = await mkdtemp(join(tmpdir(), 'fk-hook-cwdB-'));
  try {
    await mkdir(join(repoB, '.claimrail'), { recursive: true });
    await writeFile(join(repoB, '.claimrail', 'decisions.json'), JSON.stringify({
      schema: 1,
      task_class: 'ui-new',
      forks: [{ fork: '主视觉', options: ['A', 'B'], picked: 'A', evidence: null, cost_if_wrong: 'high', verified: false }],
    }), 'utf8');

    // ① payload.cwd 必须赢过进程 cwd：进程 cwd=repoA、payload 指向 repoB → 拦 repoB（code 2）
    const viaPayload = runCli(['hook'], { cwd: repoA, stdin: JSON.stringify({ cwd: repoB.split(sep).join('/') }) });
    assert.equal(viaPayload.code, 2, viaPayload.out);

    // ② env 必须赢过进程 cwd：进程 cwd=repoA、ZCODE_PROJECT_DIR 指向 repoB → code 2
    const env = { ...process.env, ZCODE_PROJECT_DIR: repoB };
    const r = spawnSync(process.execPath, [join(repo, 'src', 'cli.mjs'), 'hook'], { cwd: repoA, input: '{}', encoding: 'utf8', env });
    assert.equal(r.status, 2, `${r.stdout ?? ''}${r.stderr ?? ''}`);
  } finally {
    await rm(repoA, { recursive: true, force: true });
    await rm(repoB, { recursive: true, force: true });
  }
});

// 宿主把 Stop 拦截原因截到 4000 字符：真实台账（永雏小菲，37 条需你定）的 22.5KB
// 全量文本会被腰斩，模型只见到前几条——"一次问完"做不到。压缩后必须装进预算。
test('compactStopBlock：超预算文本按结构化数据重排，收尾指令必保', async () => {
  const { compactStopBlock } = await import('../src/commands/hook.mjs');
  const questions = Array.from({ length: 40 }, (_, i) => ({
    fork: `分叉第 ${i + 1} 号：${'比较长的分叉描述文本'.repeat(12)}`,
    picked: '候选甲',
    why: '未获同意，不得外发查询',
  }));
  const r = {
    text: ['任务类型 docs-new · 分叉 40 条 · 需你定 37 条', '✗ 交付被拦住（block）'].concat(
      questions.map((q) => `  1. ${q.fork}\n     候选 甲 | 乙 → 已选 ${q.picked}\n     代价 high · 凭什么 ${q.why}`),
    ).join('\n'),
    data: {
      task_class: 'docs-new', total: 40,
      metrics: { interrupts: 37, unverified: 0 },
      overrides: ['覆写一', '覆写二'],
      questions: questions.map((q) => ({ fork: q.fork, picked: q.picked, why: q.why })),
    },
  };
  const out = compactStopBlock(r, 3600);
  assert.ok(out.length <= 3600, `压缩后仍超预算：${out.length}`);
  assert.match(out, /还有 [0-9]+ 条需你定的分叉/);
  assert.match(out, /一次问完用户/);
  assert.match(out, /【程序覆写档位】2 条未展开/);
  // 短文本原样返回：不做无谓重排
  const short = compactStopBlock({ text: '短', data: null });
  assert.equal(short, '短');
});
