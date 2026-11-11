import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { check } from '../src/cli.mjs';

// repo 证据的 ref 只能读仓库里的文件。schema 挡住了 `..` 路径段，但 junction/symlink
// 是词法上仍在仓库内、实际指向仓库外的路径——不解析 realpath 就会把仓库外内容
// 当成"仓库既有做法"。这里用 junction（Windows 无需管理员）把仓库内路径指到外面。
test('repo 证据不许通过 junction/symlink 读到仓库外', async () => {
  const base = await mkdtemp(join(tmpdir(), 'fk-contain-'));
  const repo = join(base, 'repo');
  const outside = join(base, 'outside');
  try {
    await mkdir(repo, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'secret.txt'), 'TOPSECRET-CANARY\n', 'utf8');
    await writeFile(join(repo, 'package.json'), '{"name":"probe"}\n', 'utf8');
    const g = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    g(['init', '-q']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    g(['add', '-A']);
    g(['commit', '-qm', 'init']);

    symlinkSync(outside, join(repo, 'leak'), process.platform === 'win32' ? 'junction' : 'dir');
    await mkdir(join(repo, '.claimrail'), { recursive: true });
    await writeFile(
      join(repo, '.claimrail', 'decisions.json'),
      JSON.stringify({
        schema: 1,
        task_class: 'docs-new',
        forks: [
          {
            fork: '把仓库外的内容当成既有做法',
            options: ['按仓库做法', '按外部做法'],
            picked: '按仓库做法',
            evidence: { kind: 'repo', ref: 'leak/secret.txt:1', asserts: ['TOPSECRET-CANARY'] },
            target: { file: 'package.json' },
            cost_if_wrong: 'low',
            verified: true,
          },
        ],
      }),
      'utf8',
    );

    // changed 传空对象：把"未跟踪文件算本次改动"这层先摘掉，只测路径 containment 本身。
    const res = await check({
      cwd: repo,
      changed: { ranges: new Map(), untracked: [], renamed: [] },
      diffText: '',
    });
    assert.equal(res.code, 0, res.text);
    assert.equal(res.unverified.length, 1, res.text);
    assert.match(res.text, /未验证/, res.text);
    assert.match(res.text, /读不到|不存在/, res.text);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
