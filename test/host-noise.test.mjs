// 宿主运行时状态目录（HOST_NOISE = .mimosa）的过滤必须贯穿所有消费方：
// untracked、diff ranges、以及整段 diff 文本（treeHash 与副作用扫描读文本）。
// 只挡 untracked 一路时，一个曾经被跟踪过的 .mimosa 文件（或：宿主持续改写它）会经
// diff 混进"改动面"、或让 hook 的 treeHash 变化而误判 stale。真 git 仓库复现。
//
// 名单只收实测过的 .mimosa：.claude/.cursor 等常被用户有意跟踪为配置，不算噪音——
// 下面用一条反向用例钉住"跟踪的 .claude 改动仍是工作改动"。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { check, init, hook } from '../src/cli.mjs';

const g = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

const declared = (dir) => writeFile(join(dir, '.claimrail', 'decisions.json'), JSON.stringify({
  schema: 1,
  task_class: 'refactor',
  forks: [],
  no_fork_reason: '只加一个常量，没有两种以上合理写法',
}, null, 2), 'utf8');

async function repoWith({ hostFile }) {
  const dir = await mkdtemp(join(tmpdir(), 'fk-hostnoise-'));
  g(dir, ['init', '-q']);
  g(dir, ['config', 'user.email', 't@t']);
  g(dir, ['config', 'user.name', 't']);
  await mkdir(join(dir, hostFile.split('/').slice(0, -1).join('/')), { recursive: true });
  await writeFile(join(dir, hostFile), '{"a":1}\n', 'utf8');
  await writeFile(join(dir, 'app.ts'), 'export const a = 1;\n', 'utf8');
  g(dir, ['add', '-A']);
  g(dir, ['commit', '-qm', 'init']);
  await init({ cwd: dir });
  return dir;
}

test('被跟踪的 .mimosa 状态文件被改写：不进"改动面"清单', async () => {
  const dir = await repoWith({ hostFile: '.mimosa/hook-state/sess.json' });
  try {
    await writeFile(join(dir, '.mimosa', 'hook-state', 'sess.json'), '{"a":2}\n', 'utf8');
    await writeFile(join(dir, 'app.ts'), 'export const a = 2;\n', 'utf8');
    await declared(dir);

    const r = await check({ cwd: dir });
    assert.match(r.text, /改动面 .*app\.ts/, r.text);
    assert.doesNotMatch(r.text, /\.mimosa/, `宿主状态文件混进改动面：${r.text}`);
    assert.ok(r.data.changedFiles.includes('app.ts'), JSON.stringify(r.data.changedFiles));
    assert.ok(!r.data.changedFiles.some((f) => f.startsWith('.mimosa/')), JSON.stringify(r.data.changedFiles));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('hook：只改被跟踪的 .mimosa 状态文件，不触发 stale（touched 稳定）', async () => {
  const dir = await repoWith({ hostFile: '.mimosa/hook-state/sess.json' });
  try {
    // app.ts 在第一次 hook 前就是脏的（未提交），touched 非空但稳定
    await writeFile(join(dir, 'app.ts'), 'export const a = 2;\n', 'utf8');
    await declared(dir);
    const first = await hook({ cwd: dir });
    assert.equal(first.code, 0, first.text);

    // 第二次：只有宿主状态文件变了，app.ts 没再动、台账没动
    await writeFile(join(dir, '.mimosa', 'hook-state', 'sess.json'), '{"a":3}\n', 'utf8');
    const second = await hook({ cwd: dir });
    assert.equal(second.code, 0, second.text);
    assert.doesNotMatch(second.text, /台账自上次放行后未变/, second.text);
    assert.doesNotMatch(second.text, /这次改了/, second.text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('.claude 是被用户跟踪的配置，不算宿主噪音：它的改动仍是工作改动', async () => {
  const dir = await repoWith({ hostFile: '.claude/settings.json' });
  try {
    await writeFile(join(dir, '.claude', 'settings.json'), '{"a":2}\n', 'utf8');
    await declared(dir);
    const r = await check({ cwd: dir });
    // 只改了 .claude/settings.json → 它必须被看见（按工作改动），不是被当噪音吞掉
    assert.match(r.text, /改动面 .*\.claude/, r.text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
