import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLedger, SCHEMA_VERSION, TASK_CLASSES } from '../src/schema.mjs';

const fork = (over = {}) => ({
  fork: '聊天滚动区：覆盖式滚动条还是留 gutter',
  options: ['覆盖式', '留 gutter'],
  picked: '留 gutter',
  evidence: { kind: 'repo', ref: 'src/Chat.tsx:88', asserts: ['scrollbar-gutter'] },
  cost_if_wrong: 'low',
  verified: true,
  ...over,
});

const ledger = (over = {}) => ({ schema: SCHEMA_VERSION, task_class: 'ui-new', forks: [fork()], ...over });

test('合法台账通过', () => {
  assert.deepEqual(validateLedger(ledger()), { ok: true, errors: [] });
});

test('task_class 取值范围固定，且包含机械类白名单', () => {
  assert.ok(TASK_CLASSES.includes('typo'));
  assert.ok(TASK_CLASSES.includes('bugfix-known-cause'));
  assert.equal(validateLedger(ledger({ task_class: 'magic' })).ok, false);
});

test('旧版本台账不得被静默判过', () => {
  assert.equal(validateLedger(ledger({ schema: 0 })).ok, false);
});

test('申报无分叉必须留原因，留了就通过', () => {
  const bare = ledger({ forks: [] });
  assert.equal(validateLedger(bare).ok, false);
  assert.equal(validateLedger({ ...bare, no_fork_reason: '已知成因的空指针修复' }).ok, true);
});

test('只有一个候选不算分叉', () => {
  const r = validateLedger(ledger({ forks: [fork({ options: ['留 gutter'], picked: '留 gutter' })] }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.rule === 'options.min'));
});

test('picked 必须在候选里', () => {
  assert.equal(validateLedger(ledger({ forks: [fork({ picked: '第三选择' })] })).ok, false);
});

test('两档制：medium 这种讨价还价的档位不收', () => {
  const r = validateLedger(ledger({ forks: [fork({ cost_if_wrong: 'medium' })] }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.rule === 'cost.two-grade'));
});

test('无证据却声称已验证，是这套机制最不能容忍的一种说法', () => {
  const r = validateLedger(ledger({ forks: [fork({ evidence: null, verified: true })] }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.rule === 'evidence.null-vs-verified'));
});

test('无证据 + verified false 是合法状态，交给门去处理', () => {
  assert.equal(validateLedger(ledger({ forks: [fork({ evidence: null, verified: false })] })).ok, true);
});

test('台账要进 git，所以禁止内联代码块', () => {
  const r = validateLedger(ledger({ forks: [fork({ fork: '怎么写\n```\noverflow: auto\n```\n' })] }));
  assert.equal(r.ok, false);
});

test('每个字段只许一行，长说明会让整屏清单没人读', () => {
  assert.equal(validateLedger(ledger({ forks: [fork({ fork: '第一行\n第二行' })] })).ok, false);
});

test('repo 证据必须给行号', () => {
  const r = validateLedger(ledger({ forks: [fork({ evidence: { kind: 'repo', ref: 'src/Chat.tsx', asserts: ['x'] } })] }));
  assert.ok(r.errors.some((e) => e.rule === 'evidence.ref'));
});

test('repo 证据必须写明声称要点，否则"参考了现有代码"无从回验', () => {
  const r = validateLedger(ledger({ forks: [fork({ evidence: { kind: 'repo', ref: 'src/Chat.tsx:88' } })] }));
  assert.ok(r.errors.some((e) => e.rule === 'evidence.asserts'));
});

test('render 证据必须是图片，且必须写断言项——"我看过了"不是证据', () => {
  assert.equal(
    validateLedger(ledger({ forks: [fork({ evidence: { kind: 'render', ref: 'shots/chat@2x.png', asserts: ['scrollbar-clears-text'] } })] })).ok,
    true,
  );
  const noAsserts = validateLedger(ledger({ forks: [fork({ evidence: { kind: 'render', ref: 'shots/chat.png' } })] }));
  assert.equal(noAsserts.ok, false);
  assert.ok(noAsserts.errors.some((e) => e.rule === 'evidence.asserts'));
  assert.equal(validateLedger(ledger({ forks: [fork({ evidence: { kind: 'render', ref: 'shots/chat.txt', asserts: ['contrast-ok'] } })] })).ok, false);
});

test('ref 不许用 ../ 跑到仓库外面去配一对伪造的 png+报告', () => {
  for (const ref of ['../outside/shot.png', './x.png']) {
    const r = validateLedger(ledger({ forks: [fork({ evidence: { kind: 'render', ref, asserts: ['contrast-ok'] } })] }));
    assert.equal(r.ok, false, ref);
  }
});

test('空格与中文文件名是合法路径，拒了只会逼人写假 ref', () => {
  assert.equal(
    validateLedger(ledger({ forks: [fork({ evidence: { kind: 'repo', ref: 'src/聊天 页面.tsx:12', asserts: ['scrollbar-gutter'] } })] })).ok,
    true,
  );
});

test('web 证据必须给可回访 URL 和要点', () => {
  assert.equal(
    validateLedger(ledger({ forks: [fork({ evidence: { kind: 'web', ref: 'https://linear.app/docs', asserts: ['composer'] } })] })).ok,
    true,
  );
  assert.equal(validateLedger(ledger({ forks: [fork({ evidence: { kind: 'web', ref: 'linear 说的' } })] })).ok, false);
});

test('未知 kind 直接拒', () => {
  assert.equal(validateLedger(ledger({ forks: [fork({ evidence: { kind: 'vibe', ref: '感觉对' } })] })).ok, false);
});

test('候选代价映射只能填两档', () => {
  const r = validateLedger(ledger({ forks: [fork({ options_cost: { 覆盖式: 'low', 留: 'sortof' } })] }));
  assert.ok(r.errors.some((e) => e.rule.startsWith('options_cost')));
});

test('测量对象合法时通过', () => {
  assert.equal(validateLedger(ledger({ forks: [fork({ target: { file: 'src/Chat.tsx', symbol: 'MessageList' } })] })).ok, true);
});

test('没有测量对象是合法状态，代价随后自然升 high 并来问人', () => {
  assert.equal(validateLedger(ledger({ forks: [fork({ target: undefined })] })).ok, true);
});

test('测量对象形状不对就拒——宁可拒了重报，不要静默算错', () => {
  assert.ok(validateLedger(ledger({ forks: [fork({ target: 'src/Chat.tsx' })] })).errors.some((e) => e.rule === 'target.shape'));
  assert.ok(validateLedger(ledger({ forks: [fork({ target: { symbol: 'X' } })] })).errors.some((e) => e.rule === 'target.file'));
  assert.ok(validateLedger(ledger({ forks: [fork({ target: { file: 'a.tsx', symbol: 'X\nY' } })] })).errors.some((e) => e.rule === 'target.symbol'));
});
