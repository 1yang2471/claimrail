import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, appendFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { check, init, recordCmd, rulesCmd, invalidateCmd, LEDGER_PATH } from '../src/cli.mjs';
import { repoWithEvidence } from './helpers.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name) => join('test', 'fixtures', name);



test('端到端：证据查得到 + 代价算得低 → 放行，退出码 0', async () => {
  const dir = await repoWithEvidence();
  try {
    const res = await check({ cwd: dir });
    assert.equal(res.code, 0, res.text);
    assert.match(res.text, /✓ 可以交付/);
    assert.match(res.text, /分叉 1 条 · 需打断 0 次/);
    // 光有这两条不够：低代价但证据不成立时也会绿（审查抓到的弱断言）
    assert.match(res.text, /未验证 0 条/, res.text);
    assert.match(res.text, /均有可回验证据/, res.text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('端到端：没有测量对象 → 程序把 low 覆写成 high → 拦住', async () => {
  const res = await check({ cwd: repo, ledger: fixture('ledger-block.json'), diffText: '' });
  assert.equal(res.code, 1, res.text);
  assert.match(res.text, /申报 low → 程序 high/);
  assert.match(res.text, /引用数取不到/);
  assert.match(res.text, /【开工前 1 条 · 需你定】/);
  assert.match(res.text, /✗ 交付被拦住（block）/);
});

test('无人值守时同一份台账报 halt，而不是"先按熟悉的做法建好"', async () => {
  const res = await check({ cwd: repo, ledger: fixture('ledger-block.json'), diffText: '', unattended: true });
  assert.equal(res.code, 1);
  assert.match(res.text, /✗ 交付被拦住（halt）/);
});

test('结构不合规就不进入后续检查——先修申报，再谈代价', async () => {
  const res = await check({ cwd: repo, ledger: fixture('ledger-invalid.json'), diffText: '' });
  assert.equal(res.code, 1);
  assert.match(res.text, /结构不合规/);
  assert.doesNotMatch(res.text, /分叉 \d+ 条/);
  assert.match(res.text, /cost.two-grade|cost_if_wrong 只能/);
});

test('台账缺失给出可执行的下一步，不抛栈', async () => {
  const res = await check({ cwd: repo, ledger: 'test/fixtures/nope.json', diffText: '' });
  assert.equal(res.code, 1);
  assert.match(res.text, /claimrail init/);
});

// —— 偏好闭环端到端：record 写下的东西必须能当证据用，编出来的行号必须过不去 ——

const ledgerWithMemoryRef = async (dir, ref) => {
  const ledger = {
    schema: 1,
    task_class: 'ui-new',
    forks: [
      {
        fork: '卡片上下间距用几档',
        options: ['8px', '16px'],
        picked: '16px',
        evidence: { kind: 'memory', ref, asserts: ['16px'] },
        cost_if_wrong: 'low',
        verified: true,
      },
    ],
  };
  await writeFile(join(dir, LEDGER_PATH), JSON.stringify(ledger), 'utf8');
};

test('闭环：两次命中升格，台账引用 log#2 就过得去', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-loop-'));
  try {
    await init({ cwd: dir });
    const r1 = await recordCmd({ cwd: dir, key: 'card-gap', what: '卡片间距 8px 太挤' });
    assert.equal(r1.code, 0, r1.text);
    assert.match(r1.text, /还没升格/);

    const r2 = await recordCmd({ cwd: dir, key: 'card-gap', what: '卡片上下间距至少 16px' });
    assert.match(r2.text, /已升格/);
    assert.match(r2.text, /\[来源: log#1,log#2]/);
    assert.match((await rulesCmd({ cwd: dir })).text, /现行规则 1 条/);

    await ledgerWithMemoryRef(dir, 'log#2');
    const res = await check({ cwd: dir });
    assert.equal(res.code, 0, res.text);
    assert.match(res.text, /✓ 可以交付/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('闭环反向：引用不存在的 log#9，门照样拦', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-loop2-'));
  try {
    await init({ cwd: dir });
    await recordCmd({ cwd: dir, key: 'card-gap', what: '卡片间距 8px 太挤' });
    await recordCmd({ cwd: dir, key: 'card-gap', what: '要 16px' });
    await ledgerWithMemoryRef(dir, 'log#9');

    const res = await check({ cwd: dir });
    assert.equal(res.code, 1, res.text);
    assert.match(res.text, /log#9 不存在于 log/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('废掉的规则不再出现在 rules 输出里，原始记录一条不少', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-inval-'));
  try {
    await init({ cwd: dir });
    await recordCmd({ cwd: dir, key: 'card-gap', what: '太挤' });
    await recordCmd({ cwd: dir, key: 'card-gap', what: '要 16px' });

    const inv = await invalidateCmd({ cwd: dir, key: 'card-gap' });
    assert.equal(inv.code, 0, inv.text);
    assert.match(inv.text, /原始 log 一条没动/);
    assert.match((await rulesCmd({ cwd: dir })).text, /现行规则 0 条/);
    assert.equal((await readFile(join(dir, 'memory', 'log.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).length, 2);

    assert.equal((await invalidateCmd({ cwd: dir, key: 'card-gap' })).code, 1, '重复废同一条要说清');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('log 坏了要让 check 报非零并说清第几行，不许谎报成"记录不存在"', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-corrupt-'));
  try {
    await init({ cwd: dir });
    await recordCmd({ cwd: dir, key: 'k', what: '要 16px' });
    await appendFile(join(dir, 'memory', 'log.jsonl'), '{"key":"k","what": 坏\n', 'utf8');
    await ledgerWithMemoryRef(dir, 'log#1');

    const res = await check({ cwd: dir });
    assert.equal(res.code, 1, res.text);
    assert.match(res.text, /第 2 行/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('record 缺参数给用法，而不是写出半条记录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-args-'));
  try {
    assert.equal((await recordCmd({ cwd: dir, key: 'k' })).code, 1);
    assert.equal((await recordCmd({ cwd: dir })).code, 1);
    await assert.rejects(() => readFile(join(dir, 'memory', 'log.jsonl'), 'utf8'), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('刚 init 的空仓库可以直接过：无分叉 + 留了原因', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claimrail-empty-'));
  try {
    await init({ cwd: dir });
    const res = await check({ cwd: dir });
    assert.equal(res.code, 0, res.text);
    // 0 条分叉说的是"申报无分叉 + 原因"，不是"所有分叉都有证据"。
    // init 的模板原因是一句占位提示，正好该被显示出来提醒改写。
    assert.match(res.text, /申报无分叉/);
    assert.match(res.text, /为什么这次没有分叉/);
    assert.ok((await stat(join(dir, LEDGER_PATH))).size > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 实测到的假阴性来源：web.dev 对没带 Accept-Language 的回访返回过法语页，英文原句因此在
// 自己引过的那篇上匹配不上。回访核实的是"那句话在不在页面上"，语言漂移属于核实之外的噪声。
test('回访带 accept-language: en，且按可见正文核对要点', async () => {
  const { createServer } = await import('node:http');
  const { writeFile: wf, mkdtemp: mk } = await import('node:fs/promises');
  const seen = {};
  const srv = createServer((req, res) => {
    seen.lang = req.headers['accept-language'];
    res.writeHead(200, { 'content-type': 'text/html' });
    // 句子被行内标签切开：原始 HTML 里没有连写的 "composer spacing is tight"
    res.end('<p>the <strong>composer spacing</strong> is <em>tight</em> on this page.</p>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const dir = await mk(join(tmpdir(), 'fk-net-'));
  try {
    const ref = `http://127.0.0.1:${srv.address().port}/guide`;
    const ledger = 'net-ledger.json';
    await wf(join(dir, ledger), JSON.stringify({
      schema: 1, task_class: 'refactor',
      forks: [{ fork: '列表项密度', options: ['紧凑', '宽松'], picked: '宽松', evidence: { kind: 'web', ref, asserts: ['composer spacing is tight'] }, cost_if_wrong: 'low', verified: true }],
    }));
    const res = await check({ cwd: dir, ledger, diffText: '', allowNet: true });
    assert.equal(seen.lang, 'en', `回访没带语言标头：${JSON.stringify(seen)}`);
    assert.doesNotMatch(res.text, /来源里没有声称的要点/, res.text);
  } finally {
    srv.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// 实测（2026-11-07，ZCode 0.17.1 无头）：技能描述已加载、Skill 工具可调，但模型在一个
// "把保存按钮改成底部固定栏" 的设计任务上就是不加载 claimrail（改完样式还自己起了 Chrome
// 验证）。光靠 description 触发不了，所以 init 要在目标仓库写一段宿主必读的指路。
test('init 在目标仓库 AGENTS.md 写指路段（没有就建）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-agents-'));
  try {
    await init({ cwd: dir });
    const agents = await readFile(join(dir, 'AGENTS.md'), 'utf8');
    assert.match(agents, /claimrail:begin/);
    assert.match(agents, /decisions\.json/);
    assert.match(agents, /claimrail check/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('重复 init 不重复写指路，也不动已有内容', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-agents2-'));
  try {
    await writeFile(join(dir, 'AGENTS.md'), '# 本仓库规则\n\n- 用 pnpm\n', 'utf8');
    await init({ cwd: dir });
    await init({ cwd: dir });
    const agents = await readFile(join(dir, 'AGENTS.md'), 'utf8');
    assert.match(agents, /^# 本仓库规则/, '原有内容被改动了');
    assert.match(agents, /- 用 pnpm/);
    assert.equal((agents.match(/claimrail:begin/g) ?? []).length, 1, '指路段被重复写入');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// hooks 层刻意做薄：宿主在"一次响应结束（交付前）"调它。ZCode 的语义是退出码 0 放行、
// 2 才是故意阻断；其它非零会被宿主当成故障，而不是"拦住"。没有台账 = 这个仓库不在协议里。

// 非 git 目录是显式的降级模式，不是"程序真算出来代价很高"。这两件事在报告里必须分开说：
// 实测教训（PRD-notes 第 58 条）——Shinsekai 不是 git 仓库，于是每条分叉都判 high；
// 不写明的话，读报告的人会以为工具真的测出了高代价，实际是三个输入一个都取不到。
test('非 git 目录：报告要标明这是降级模式，并逐条说清"不在 git 里"', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-nogit-'));
  try {
    await mkdir(join(dir, '.claimrail'), { recursive: true });
    await writeFile(
      join(dir, '.claimrail', 'decisions.json'),
      JSON.stringify({
        schema: 1,
        task_class: 'ui-new',
        forks: [
          {
            fork: '导航结构：顶部还是侧边',
            options: ['顶部', '侧边'],
            picked: '顶部',
            evidence: null,
            cost_if_wrong: 'low',
            verified: false,
          },
        ],
      }),
      'utf8',
    );

    const res = await check({ cwd: dir });
    assert.equal(res.code, 1, res.text);
    assert.match(res.text, /非 git 目录/);
    assert.match(res.text, /保守默认/, '没说明这是保守默认');
    // 三条原因要逐条说清：只断言"出现过一次"的话，坏掉其中一条也测不出来
    assert.match(res.text, /不在 git 仓库里，引用数取不到/, res.text);
    assert.match(res.text, /不在 git 仓库里，发布状态取不到/, res.text);
    assert.match(res.text, /不在 git 仓库里，改动内容取不到/, res.text);
    // "没有仓库"不许被说成"grep 抽风"——两个原因差着一个 git init 的距离
    assert.doesNotMatch(res.text, /git grep 失败/);
    // 也不许把"半瞎"说成"全瞎"：repo 档在 git 之外仍读得了文件与行，
    // 真正丢掉的是"先干后证"（那一步要 git）。文案必须点名丢掉的是哪一条。
    assert.match(res.text, /先干后证/, res.text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 审查抓到的误判：任何 git 失败都被说成"非 git 目录"，于是用户被指去 `git init`
// 一个本来就是仓库的目录。实测两条 stderr 是可分辨的：
//   非仓库   → fatal: not a git repository (or any of the parent directories): .git
//   坏 GIT_DIR → fatal: not a git repository: '<路径>'
test('gitState 的三态辨认：none 的消息、unknown 的消息、正常仓库', async () => {
  const { gitState } = await import('../src/observe/git.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'fk-gitmissing-'));
  try {
    // 真目录：确实不是仓库
    assert.equal(await gitState(dir), 'none');

    // unknown 的两条实测消息（坏 GIT_DIR 与 safe.directory）都长这样：
    //   fatal: not a git repository: '<路径>'   ← 没有括号那句
    // 归类逻辑靠这个分辨，钉死它不许退化成"全叫 none"。
    const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    g(['init', '-q']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    assert.equal(await gitState(dir), 'repo');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('git 用不了 ≠ 不在仓库里：两种降级要说不同的话', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-gitbad-'));
  const env = process.env.GIT_DIR;
  try {
    const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    g(['init', '-q']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    await writeFile(join(dir, 'package.json'), '{"name":"x"}', 'utf8');
    g(['add', '-A']);
    g(['commit', '-qm', 'init']);
    await mkdir(join(dir, '.claimrail'), { recursive: true });
    await writeFile(
      join(dir, '.claimrail', 'decisions.json'),
      JSON.stringify({ schema: 1, task_class: 'ui-new', forks: [] , no_fork_reason: '只改文档' }),
      'utf8',
    );

    process.env.GIT_DIR = 'C:/definitely-not-a-repo/nope.git';
    const res = await check({ cwd: dir });
    assert.doesNotMatch(res.text, /非 git 目录（降级模式）/, res.text);
    assert.match(res.text, /git 读不出|git 不可用/, res.text);
  } finally {
    if (env === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = env;
    await rm(dir, { recursive: true, force: true });
  }
});

// 通用性（实测 2026-11-08）：仓库路径含中文与空格（Windows 上极常见）。
// git 的 core.quotepath=false 已在 gitRaw 里统一关掉；这条钉住全流程真的能跑。
test('中文 + 空格路径的仓库：init 与 check 全流程可用', async () => {
  const base = await mkdtemp(join(tmpdir(), 'fk-cn-'));
  const dir = join(base, '我的 项目');
  try {
    await mkdir(dir, { recursive: true });
    const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    g(['init', '-q']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    await mkdir(join(dir, '源代码'), { recursive: true });
    await writeFile(join(dir, '源代码', 'ui.ts'), 'export const 按钮样式常量 = 1;', 'utf8');
    g(['add', '-A']);
    g(['commit', '-qm', 'init']);

    const initOut = execFileSync('node', [join(repo, 'src', 'cli.mjs'), 'init'], { cwd: dir, encoding: 'utf8' });
    assert.match(initOut, /已建/, initOut);

    await writeFile(
      join(dir, '.claimrail', 'decisions.json'),
      JSON.stringify({
        schema: 1,
        task_class: 'ui-new',
        forks: [
          {
            fork: '按钮样式',
            options: ['描边', '填充'],
            picked: '描边',
            target: { file: '源代码/ui.ts', symbol: '按钮样式常量' },
            evidence: { kind: 'repo', ref: '源代码/ui.ts:1', asserts: ['按钮样式常量'] },
            cost_if_wrong: 'low',
            verified: true,
          },
        ],
      }),
      'utf8',
    );
    const out = execFileSync('node', [join(repo, 'src', 'cli.mjs'), 'check'], { cwd: dir, encoding: 'utf8' });
    assert.match(out, /可以交付/, out);
    assert.match(out, /均有可回验证据/, out);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
