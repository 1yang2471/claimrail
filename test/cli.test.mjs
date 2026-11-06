import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { check, init, LEDGER_PATH } from '../src/cli.mjs';

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
