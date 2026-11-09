// 入口层守卫（2026-11-10 审查修复）：junction/主模块判断、baseline 修复、fail-closed、
// 子目录仓库根基准、绝对路径台账。入口层接线错误在单元层全绿，这些用例走 check()/init()
// 与真进程（spawnSync）——详见 docs/AUDIT-2026-11-10.md。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { check, init } from '../src/cli.mjs';
import { repoWithEvidence } from './helpers.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

// —— 2026-11-10 审查修复的守卫 ——

// P0：junction/symlink 下 Node 按 realpath 解析主模块而 argv[1] 保留链接路径，
// 旧的字符串相等判断永远不成立 → CLI 静默 exit 0。npm link / pnpm 的两种真实安装形态都长这样。
test('junction/链接路径下 CLI 不许静默退出 0', async () => {
  const { symlink } = await import('node:fs/promises');
  const base = await mkdtemp(join(tmpdir(), 'fk-junction-'));
  const link = join(base, 'link');
  try {
    await symlink(repo, link, process.platform === 'win32' ? 'junction' : 'dir');
    const r = spawnSync(process.execPath, [join(link, 'src', 'cli.mjs'), 'check'], { cwd: base, encoding: 'utf8' });
    assert.notEqual(r.status, 0, `链接路径下 check 静默通过：status=${r.status} out=${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout ?? ''}${r.stderr ?? ''}`, /台账读不到/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// P1：init 跑在没有提交的仓库里只留下空 baseline，而且永不修复；
// 之后 commit 掉的改动对门不可见，模板台账照样退出 0。
test('空 baseline：commit 后必须拦住，re-init 修复', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-baseline-'));
  try {
    const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    g(['init', '-q']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    await init({ cwd: dir }); // 没有 HEAD：baseline 写成空文件
    await writeFile(join(dir, 'work.ts'), 'export const a = 1;\n', 'utf8');
    g(['add', '-A']);
    g(['commit', '-qm', 'work']);

    const blocked = await check({ cwd: dir });
    assert.equal(blocked.code, 1, blocked.text);
    assert.match(blocked.text, /没有 baseline/);

    const r2 = await init({ cwd: dir });
    assert.match(r2.text, /起点记在/);
    const ok = await check({ cwd: dir });
    assert.equal(ok.code, 0, ok.text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// P1：GIT_DIR 坏掉时"工作区是否改过"无从判断，模板台账以前照样认证交付（fail-open）。
test('git 读不出状态时模板台账不许认证交付', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-unknown-'));
  const env = process.env.GIT_DIR;
  try {
    const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    g(['init', '-q']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    await writeFile(join(dir, 'package.json'), '{"name":"x"}', 'utf8');
    g(['add', '-A']);
    g(['commit', '-qm', 'init']);
    await init({ cwd: dir });
    await writeFile(join(dir, 'work.ts'), 'export const a = 1;\n', 'utf8');

    process.env.GIT_DIR = 'C:/definitely-not-a-repo/nope.git';
    const r = await check({ cwd: dir });
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, /无法判断是否已申报/);
    assert.match(r.text, /git 读不出仓库状态/);
  } finally {
    if (env === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = env;
    await rm(dir, { recursive: true, force: true });
  }
});

// P1：从子目录跑 check 必须以仓库根为基准。旧实现里 git diff 的键是根相对路径而
// 文件读取按 cwd 拼接——"先干后证"在子目录里漏拦（cwd 相对 ref 躲过变更比对），
// 根相对 ref 反而读不到文件。两个方向都要钉住。
test('子目录运行：check 以仓库根为基准，台账与 ref 都按根相对解析', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-subdir-'));
  try {
    const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    g(['init', '-q']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    await mkdir(join(dir, 'pkg'), { recursive: true });
    await writeFile(join(dir, 'pkg', 'x.ts'), 'const x = 1;\n', 'utf8');
    g(['add', '-A']);
    g(['commit', '-qm', 'init']);
    await init({ cwd: dir });

    await writeFile(join(dir, 'pkg', 'x.ts'), 'const x = 1;\nconst brandNew = 2;\n', 'utf8');
    await writeFile(
      join(dir, '.claimrail', 'decisions.json'),
      JSON.stringify({
        schema: 1,
        task_class: 'refactor',
        forks: [
          {
            fork: '新增常量放哪',
            options: ['放 x.ts', '放新文件'],
            picked: '放 x.ts',
            evidence: { kind: 'repo', ref: 'pkg/x.ts:2', asserts: ['brandNew'] },
            cost_if_wrong: 'low',
            verified: true,
          },
        ],
      }),
      'utf8',
    );

    // 第 2 行是本次新写的行：无论从根还是从子目录跑，"先干后证"都必须把它拦下来
    // （证据判假 → low 被覆写成 high → block，而不是放行）
    const fromRoot = await check({ cwd: dir });
    assert.equal(fromRoot.code, 1, fromRoot.text);
    assert.match(fromRoot.text, /本次改动新增\/修改的行/);

    const fromSub = await check({ cwd: join(dir, 'pkg') });
    assert.equal(fromSub.code, fromRoot.code, fromSub.text);
    assert.match(fromSub.text, /本次改动新增\/修改的行/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// P2：--ledger 给绝对路径（Windows 盘符）不再被 join 拼成 <cwd>\D:\x。
test('--ledger 接受绝对路径', async () => {
  const dir = await repoWithEvidence();
  try {
    const res = await check({ cwd: dir, ledger: join(dir, '.claimrail', 'decisions.json') });
    assert.equal(res.code, 0, res.text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
