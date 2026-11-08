// 「没申报」本身要能拦住交付：工作区有改动、台账还是 init 模板 → check 退出 1。
// 这是 2026-11-08 pilot 的直接产物：on 臂 5/6 根本没写台账，旧 check 用模板照样退出 0。
// 只判「有没有写」，不判「写得对不对」——后者归 schema、证据回访和代价覆写。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { check, init } from '../src/cli.mjs';

const g = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

async function repoWithTemplate() {
  const dir = await mkdtemp(join(tmpdir(), 'fk-undeclared-'));
  g(dir, ['init', '-q']);
  g(dir, ['config', 'user.email', 't@t']);
  g(dir, ['config', 'user.name', 't']);
  await writeFile(join(dir, 'package.json'), '{"name":"probe"}', 'utf8');
  g(dir, ['add', '-A']);
  g(dir, ['commit', '-qm', 'init']);
  await init({ cwd: dir });
  return dir;
}

const ledgerPath = (dir) => join(dir, '.claimrail', 'decisions.json');
const writeLedger = (dir, body) => writeFile(ledgerPath(dir), `${JSON.stringify(body, null, 2)}\n`, 'utf8');

test('刚 init 完、还没开工：init 自己的脚印不算改动，不拦', async () => {
  const dir = await repoWithTemplate();
  try {
    const r = await check({ cwd: dir });
    assert.equal(r.code, 0, r.text);
    assert.equal(r.data.undeclared ?? null, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('工作区有改动、台账仍是模板：退出 1，并点名改动文件', async () => {
  const dir = await repoWithTemplate();
  try {
    await writeFile(join(dir, 'src-note.ts'), 'export const a = 1;\n', 'utf8');
    const r = await check({ cwd: dir });
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, /未申报 · 台账仍是 init 模板/);
    assert.match(r.text, /src-note\.ts/);
    assert.equal(r.data.action, 'block');
    assert.equal(r.data.undeclared.changedTotal, 1);
    assert.deepEqual(r.data.undeclared.changed, ['src-note.ts']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('写了 forks: [] + 自己的理由：算已申报，放行', async () => {
  const dir = await repoWithTemplate();
  try {
    await writeFile(join(dir, 'src-note.ts'), 'export const a = 1;\n', 'utf8');
    await writeLedger(dir, {
      schema: 1,
      task_class: 'refactor',
      forks: [],
      no_fork_reason: '只加一个常量，没有两种以上合理写法',
    });
    const r = await check({ cwd: dir });
    assert.equal(r.code, 0, r.text);
    assert.equal(r.data.undeclared ?? null, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('把模板重新序列化但占位理由没改：仍算没申报', async () => {
  const dir = await repoWithTemplate();
  try {
    await writeFile(join(dir, 'src-note.ts'), 'export const a = 1;\n', 'utf8');
    const tpl = JSON.parse(await readFile(ledgerPath(dir), 'utf8'));
    // 缩进和键序都变了，哈希对不上；占位理由还在，必须仍判"没申报"。
    await writeFile(ledgerPath(dir), JSON.stringify(tpl, null, 4), 'utf8');
    const r = await check({ cwd: dir });
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, /未申报/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('老仓库没有 template.sha256：退回当前模板常量，仍能判', async () => {
  const dir = await repoWithTemplate();
  try {
    await unlink(join(dir, '.claimrail', 'template.sha256'));
    await writeFile(join(dir, 'src-note.ts'), 'export const a = 1;\n', 'utf8');
    const r = await check({ cwd: dir });
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, /未申报/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('只改 AGENTS.md / .gitignore 这类 init 脚印：不拦', async () => {
  const dir = await repoWithTemplate();
  try {
    await writeFile(join(dir, 'AGENTS.md'), `${await readFile(join(dir, 'AGENTS.md'), 'utf8')}\n补充一行。\n`, 'utf8');
    const r = await check({ cwd: dir });
    assert.equal(r.code, 0, r.text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
