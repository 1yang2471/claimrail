import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, appendFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { check, init, recordCmd, rulesCmd, invalidateCmd, LEDGER_PATH } from '../src/cli.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name) => join('test', 'fixtures', name);

test('端到端：证据查得到 + 代价算得低 → 放行，退出码 0', async () => {
  const res = await check({ cwd: repo, ledger: fixture('ledger-clean.json'), diffText: '' });
  assert.equal(res.code, 0, res.text);
  assert.match(res.text, /✓ 可以交付/);
  assert.match(res.text, /分叉 1 条 · 需打断 0 次/);
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
  assert.match(res.text, /forklight init/);
});

test('init 建模板、说清数据去向，并让偏好与截图不进 git', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forklight-init-'));
  try {
    const res = await init({ cwd: dir });
    assert.equal(res.code, 0);
    assert.match(res.text, /已建/);
    assert.match(res.text, /decisions\.json\s+进 git/);
    assert.match(res.text, /memory\//);

    const ledger = JSON.parse(await readFile(join(dir, LEDGER_PATH), 'utf8'));
    assert.equal(ledger.schema, 1);
    assert.deepEqual(ledger.forks, []);

    const gi = await readFile(join(dir, '.gitignore'), 'utf8');
    for (const p of ['memory/', '*.png', '.forklight/shots/']) assert.ok(gi.includes(p), p);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('init 不覆盖已有台账——那是别人的申报记录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forklight-init2-'));
  try {
    await init({ cwd: dir });
    const file = join(dir, LEDGER_PATH);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, '{"schema":1,"task_class":"typo","forks":[],"no_fork_reason":"我写的"}', 'utf8');

    const res = await init({ cwd: dir });
    assert.match(res.text, /已存在，不动/);
    assert.match(await readFile(file, 'utf8'), /我写的/);
    assert.ok(existsSync(join(dir, '.gitignore')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
  const dir = await mkdtemp(join(tmpdir(), 'forklight-empty-'));
  try {
    await init({ cwd: dir });
    const res = await check({ cwd: dir });
    assert.equal(res.code, 0, res.text);
    assert.match(res.text, /无需打断/);
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
// "把保存按钮改成底部固定栏" 的设计任务上就是不加载 forklight（改完样式还自己起了 Chrome
// 验证）。光靠 description 触发不了，所以 init 要在目标仓库写一段宿主必读的指路。
test('init 在目标仓库 AGENTS.md 写指路段（没有就建）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-agents-'));
  try {
    await init({ cwd: dir });
    const agents = await readFile(join(dir, 'AGENTS.md'), 'utf8');
    assert.match(agents, /forklight:begin/);
    assert.match(agents, /decisions\.json/);
    assert.match(agents, /forklight check/);
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
    assert.equal((agents.match(/forklight:begin/g) ?? []).length, 1, '指路段被重复写入');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
