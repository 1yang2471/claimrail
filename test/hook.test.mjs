import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { check, hook } from '../src/cli.mjs';
import { repoWithEvidence } from './helpers.mjs';

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
    assert.equal(first.code, 2, first.text);
    assert.match(first.text, /逐条声明未验证项/);
    assert.match(first.text, /列表行高用 token 还是写死/);

    const second = await hook({ cwd: dir, payload: { stop_hook_active: true } });
    assert.equal(second.code, 0, second.text);
    assert.match(second.text, /不再重复阻断/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
