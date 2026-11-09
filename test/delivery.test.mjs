// Stop 钩子的指纹层：工作区变了、台账没变 = 沿用上次申报。
// check 无状态，判不了这一条；快照只由 hook 在放行时写，反复跑 check 推不动它。
// 只拦一次：第二次仍没申报就放行，但落一条 violations 记录，让"放行"也可统计。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hook, init } from '../src/cli.mjs';
import { readSnapshot } from '../src/delivery.mjs';
import { TEMPLATE_TEXT } from '../src/template.mjs';

const g = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const ledgerPath = (dir) => join(dir, '.claimrail', 'decisions.json');
const violationsPath = (dir) => join(dir, '.claimrail', 'violations.jsonl');

const DECLARED = { schema: 1, task_class: 'refactor', forks: [], no_fork_reason: '只加一个常量' };

async function repoWithLedger() {
  const dir = await mkdtemp(join(tmpdir(), 'fk-delivery-'));
  g(dir, ['init', '-q']);
  g(dir, ['config', 'user.email', 't@t']);
  g(dir, ['config', 'user.name', 't']);
  await writeFile(join(dir, 'package.json'), '{"name":"probe"}', 'utf8');
  g(dir, ['add', '-A']);
  g(dir, ['commit', '-qm', 'init']);
  await init({ cwd: dir });
  await writeFile(ledgerPath(dir), `${JSON.stringify(DECLARED, null, 2)}\n`, 'utf8');
  await writeFile(join(dir, 'src-one.ts'), 'export const a = 1;\n', 'utf8');
  return dir;
}

const violations = async (dir) => {
  try {
    return (await readFile(violationsPath(dir), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch {
    return [];
  }
};

test('第一次放行写快照；工作区没再变时不重复拦', async () => {
  const dir = await repoWithLedger();
  try {
    const first = await hook({ cwd: dir });
    assert.equal(first.code, 0, first.text);
    const snap = await readSnapshot(dir);
    assert.ok(snap?.treeHash && snap?.ledgerHash, JSON.stringify(snap));

    const again = await hook({ cwd: dir });
    assert.equal(again.code, 0, again.text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('工作区变了、台账没变：拦一次，快照不前进', async () => {
  const dir = await repoWithLedger();
  try {
    assert.equal((await hook({ cwd: dir })).code, 0);
    const before = await readSnapshot(dir);

    await writeFile(join(dir, 'src-two.ts'), 'export const b = 2;\n', 'utf8');
    const blocked = await hook({ cwd: dir });
    assert.equal(blocked.code, 2, blocked.text);
    assert.match(blocked.text, /台账自上次放行后未变/);
    assert.match(blocked.text, /src-two\.ts/);

    const after = await readSnapshot(dir);
    assert.equal(after.treeHash, before.treeHash, '被拦时不许把快照推到新状态');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('第二次仍沿用旧台账：放行，但落一条 stale 记录', async () => {
  const dir = await repoWithLedger();
  try {
    assert.equal((await hook({ cwd: dir })).code, 0);
    await writeFile(join(dir, 'src-two.ts'), 'export const b = 2;\n', 'utf8');

    const passed = await hook({ cwd: dir, payload: { stop_hook_active: true } });
    assert.equal(passed.code, 0, passed.text);

    const rows = await violations(dir);
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.equal(rows[0].reason, 'stale');
    assert.ok(rows[0].changedTotal >= 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('台账跟着这次改动更新：放行并推进快照', async () => {
  const dir = await repoWithLedger();
  try {
    assert.equal((await hook({ cwd: dir })).code, 0);
    await writeFile(join(dir, 'src-two.ts'), 'export const b = 2;\n', 'utf8');
    await writeFile(
      ledgerPath(dir),
      `${JSON.stringify({ ...DECLARED, no_fork_reason: '这次只加了一个常量' }, null, 2)}\n`,
      'utf8',
    );

    const r = await hook({ cwd: dir });
    assert.equal(r.code, 0, r.text);
    assert.equal((await violations(dir)).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('台账被删：初始化过就拦；续过一轮则放行并落 ledger-deleted', async () => {
  const dir = await repoWithLedger();
  try {
    await unlink(ledgerPath(dir));
    const blocked = await hook({ cwd: dir });
    assert.equal(blocked.code, 2, blocked.text);
    assert.match(blocked.text, /台账被删了/);

    const passed = await hook({ cwd: dir, payload: { stop_hook_active: true } });
    assert.equal(passed.code, 0, passed.text);
    const rows = await violations(dir);
    assert.equal(rows.at(-1).reason, 'ledger-deleted');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('从没 init 过的仓库：静默放行，不算删台账', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-delivery-plain-'));
  try {
    g(dir, ['init', '-q']);
    const r = await hook({ cwd: dir });
    assert.equal(r.code, 0, r.text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('台账仍是模板：hook 复用 check 的未申报拦截', async () => {
  const dir = await repoWithLedger();
  try {
    await writeFile(ledgerPath(dir), TEMPLATE_TEXT, 'utf8');
    const blocked = await hook({ cwd: dir });
    assert.equal(blocked.code, 2, blocked.text);
    assert.match(blocked.text, /未申报 · 台账仍是 init 模板/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 本地状态是审计线索，不是交付的前置条件：写不进去也不许把交付打成宿主故障。
test('快照写不进去（路径被占）：放行，不抛错', async () => {
  const dir = await repoWithLedger();
  try {
    await mkdir(join(dir, '.claimrail', 'last-delivery.json'));
    const r = await hook({ cwd: dir });
    assert.equal(r.code, 0, r.text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('违规记录写不进去：仍然放行', async () => {
  const dir = await repoWithLedger();
  try {
    assert.equal((await hook({ cwd: dir })).code, 0);
    await writeFile(join(dir, 'src-two.ts'), 'export const b = 2;\n', 'utf8');
    await mkdir(join(dir, '.claimrail', 'violations.jsonl'));
    const r = await hook({ cwd: dir, payload: { stop_hook_active: true } });
    assert.equal(r.code, 0, r.text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 自定义台账路径：提示必须指向实际文件。OCR 审查发现 undeclared 那条修了，
// stale 与"台账被删"两条仍写死默认路径——同一类 bug 在 hook 侧还有两处。
test('自定义台账路径：stale 与删台账的提示都写实际路径', async () => {
  const dir = await repoWithLedger();
  try {
    const custom = join(dir, 'custom-ledger.json');
    await writeFile(custom, `${JSON.stringify(DECLARED, null, 2)}\n`, 'utf8');

    assert.equal((await hook({ cwd: dir, ledger: 'custom-ledger.json' })).code, 0);

    await writeFile(join(dir, 'src-two.ts'), 'export const b = 2;\n', 'utf8');
    const stale = await hook({ cwd: dir, ledger: 'custom-ledger.json' });
    assert.equal(stale.code, 2, stale.text);
    assert.match(stale.text, /custom-ledger\.json/);
    assert.doesNotMatch(stale.text, /\.claimrail\/decisions\.json/);
    const changedLine = stale.text.split('\n').find((l) => l.startsWith('这次改了'));
    assert.ok(changedLine, stale.text);
    assert.doesNotMatch(changedLine, /custom-ledger\.json/, '台账自己不算工作改动');

    await unlink(custom);
    const gone = await hook({ cwd: dir, ledger: 'custom-ledger.json' });
    assert.equal(gone.code, 2, gone.text);
    assert.match(gone.text, /custom-ledger\.json/);
    assert.doesNotMatch(gone.text, /\.claimrail\/decisions\.json/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
