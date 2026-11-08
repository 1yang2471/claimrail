// 申报无分叉时的审计线索。不是拦截：程序判不了"有没有分叉"，只把
// "台账说没有分叉，而 diff 确实落在这一类任务的面上"记下来，供人抽查与 bench 统计。
// 所以这里既要有"命中要说出来"，也要有"不在面上就闭嘴"——否则审计项会变成噪音，
// 第一天就被人无视。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { surfaceFiles } from '../src/audit.mjs';
import { check } from '../src/cli.mjs';

const git = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

async function repoWithLedger(ledger, { files = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fk-audit-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 't']);
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(join(dir, rel.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
    await writeFile(join(dir, rel), body, 'utf8');
  }
  await writeFile(join(dir, 'package.json'), '{"name":"probe"}', 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'init']);
  await mkdir(join(dir, '.claimrail'), { recursive: true });
  await writeFile(join(dir, '.claimrail', 'decisions.json'), JSON.stringify(ledger, null, 2), 'utf8');
  return dir;
}

const emptyUI = () => ({ schema: 1, task_class: 'ui-new', forks: [], no_fork_reason: '这个页面只有一种写法' });

test('面分类：UI / 文档 / 接口各自认自己的文件，不越界', () => {
  assert.deepEqual(
    surfaceFiles('ui-new', ['src/page.tsx', 'src/app.css', 'src/logic.mjs', 'README.md']),
    ['src/page.tsx', 'src/app.css'],
  );
  assert.deepEqual(
    surfaceFiles('docs-new', ['README.md', 'docs/guide.md', 'src/page.tsx', 'notes.rst']),
    ['README.md', 'docs/guide.md', 'notes.rst'],
  );
  assert.deepEqual(
    surfaceFiles('api-design', ['api/routes.ts', 'openapi.yaml', 'config/app.yaml', 'src/proto/user.proto']),
    ['api/routes.ts', 'openapi.yaml', 'src/proto/user.proto'],
  );
});

test('refactor 没有面：它的"面"是任意代码，命中等于没有区分度', () => {
  assert.deepEqual(surfaceFiles('refactor', ['src/a.mjs', 'src/page.tsx']), []);
  // 非协议类别同样不产生审计项
  assert.deepEqual(surfaceFiles('typo', ['README.md']), []);
});

test('申报无分叉但动了 UI 文件：审计项上屏、进 --json，退出码不变', async () => {
  const dir = await repoWithLedger(emptyUI());
  try {
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'page.tsx'), 'export const Page = () => <div />;\n', 'utf8');
    const res = await check({ cwd: dir });
    assert.equal(res.code, 0, res.text);
    assert.match(res.text, /【申报无分叉的审计项 · 本次改动落在 ui-new 的面上】/, res.text);
    assert.match(res.text, /src\/page\.tsx/, res.text);
    assert.match(res.text, /不拦交付/, res.text);
    assert.deepEqual(res.data.emptyDeclaration, {
      reason: '这个页面只有一种写法',
      touched: ['src/page.tsx'],
      touchedTotal: 1,
    });
    assert.equal(res.data.no_fork_reason, '这个页面只有一种写法');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('申报无分叉但只动了不在面上的文件：审计项闭嘴', async () => {
  const dir = await repoWithLedger(emptyUI());
  try {
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'logic.mjs'), 'export const x = 1;\n', 'utf8');
    const res = await check({ cwd: dir });
    assert.equal(res.code, 0, res.text);
    assert.doesNotMatch(res.text, /审计项/);
    assert.equal(res.data.emptyDeclaration, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('已跟踪的 UI 文件被改动也算——不只看未跟踪的新文件', async () => {
  const dir = await repoWithLedger(emptyUI(), { files: { 'src/page.tsx': 'export const Page = () => <div />;\n' } });
  try {
    await writeFile(join(dir, 'src', 'page.tsx'), 'export const Page = () => <main />;\n', 'utf8');
    const res = await check({ cwd: dir });
    assert.equal(res.code, 0, res.text);
    assert.match(res.text, /src\/page\.tsx/, res.text);
    assert.equal(res.data.emptyDeclaration.touchedTotal, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('文档类任务动了 README 也留下审计项', async () => {
  const dir = await repoWithLedger({ schema: 1, task_class: 'docs-new', forks: [], no_fork_reason: '只补一句安装说明' });
  try {
    await writeFile(join(dir, 'README.md'), '# probe\n\n补一句。\n', 'utf8');
    const res = await check({ cwd: dir });
    assert.equal(res.code, 0, res.text);
    assert.match(res.text, /docs-new 的面上/, res.text);
    assert.deepEqual(res.data.emptyDeclaration.touched, ['README.md']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('审计项超过展示上限时如实说"另有 N 个"，不许假装全列了', async () => {
  const dir = await repoWithLedger(emptyUI());
  try {
    await mkdir(join(dir, 'src'), { recursive: true });
    for (let i = 0; i < 7; i += 1) {
      await writeFile(join(dir, 'src', `w${i}.tsx`), `export const C${i} = () => null;\n`, 'utf8');
    }
    const res = await check({ cwd: dir });
    assert.equal(res.code, 0, res.text);
    assert.equal(res.data.emptyDeclaration.touchedTotal, 7);
    assert.equal(res.data.emptyDeclaration.touched.length, 5);
    assert.match(res.text, /另有 2 个/, res.text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
