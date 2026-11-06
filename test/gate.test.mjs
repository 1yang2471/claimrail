import test from 'node:test';
import assert from 'node:assert/strict';
import { enrich, decide, render } from '../src/gate.mjs';

const LOW = { fanIn: 1, published: [], irreversible: [] };
const HIGH = { fanIn: 1, published: ['tag:v1'], irreversible: [] };
const IRREVERSIBLE = { fanIn: 1, published: [], irreversible: ['recursive-delete'] };
const GOOD = { ok: true, why: 'Chat.tsx:88 已重读确认' };
const NONE = { ok: false, why: 'evidence: null' };

const fork = (over = {}) => ({
  fork: '聊天滚动区实现',
  options: ['覆盖式', '留 gutter'],
  picked: '留 gutter',
  cost_if_wrong: 'low',
  ...over,
});

const run = (forks, { observations, verifications, humanPresent = true } = {}) =>
  decide(enrich({ forks }, { observations, verifications }), { humanPresent });

test('每条分叉都有可回验证据：不打断，直接放行', () => {
  const d = run([fork()], { observations: [LOW], verifications: [GOOD] });
  assert.equal(d.action, 'proceed');
  assert.equal(d.metrics.interrupts, 0);
  assert.equal(render(d), '【无需打断 · 1 条分叉均有可回验证据】');
});

test('高代价 + 无证据 + 人在：开工前阻塞等一句话', () => {
  const d = run([fork()], { observations: [HIGH], verifications: [NONE] });
  assert.equal(d.action, 'block');
  assert.equal(d.questions.length, 1);
  assert.equal(d.unverified.length, 0);
});

test('高代价 + 无证据 + 人不在：硬停，产出必须是"我卡在这儿"而不是成品', () => {
  const d = run([fork()], { observations: [HIGH], verifications: [NONE], humanPresent: false });
  assert.equal(d.action, 'halt');
});

test('不可逆副作用按高代价处理，不管它看起来多小', () => {
  const d = run([fork({ cost_if_wrong: 'low' })], { observations: [IRREVERSIBLE], verifications: [NONE] });
  assert.equal(d.questions[0].cost, 'high');
  assert.equal(d.action, 'block');
});

test('低代价 + 无证据：照做，但必须进末尾汇总，不许静默', () => {
  const d = run([fork()], { observations: [LOW], verifications: [NONE] });
  assert.equal(d.action, 'proceed');
  assert.equal(d.unverified.length, 1);
  assert.match(render(d), /条未验证/);
});

test('模型只能往高报：申报 low 而程序算出 high，仍然按 high 拦', () => {
  const d = run([fork({ cost_if_wrong: 'low' })], { observations: [LOW], verifications: [GOOD] });
  assert.equal(d.action, 'proceed');
  const d2 = run([fork({ cost_if_wrong: 'low' })], { observations: [HIGH], verifications: [NONE] });
  assert.equal(d2.action, 'block');
});

test('无证据却选了改起来更贵的候选——静默塌缩最典型的形状', () => {
  const d = run([fork({ options_cost: { 覆盖式: 'low', '留 gutter': 'high' }, picked: '留 gutter' })], {
    observations: [LOW],
    verifications: [NONE],
  });
  assert.equal(d.violations.length, 1);
  assert.equal(d.action, 'block');
});

test('有证据时选贵的做法是知情决定，不拦', () => {
  const d = run([fork({ options_cost: { 覆盖式: 'low', '留 gutter': 'high' }, picked: '留 gutter' })], {
    observations: [LOW],
    verifications: [GOOD],
  });
  assert.equal(d.violations.length, 0);
  assert.equal(d.action, 'proceed');
});

test('候选代价数据不齐就不判——误拦一次的代价比漏拦一次高', () => {
  const d = run([fork({ options_cost: { 覆盖式: 'low' } })], { observations: [LOW], verifications: [NONE] });
  assert.equal(d.violations.length, 0);
  assert.equal(d.action, 'proceed');
});

test('同一条分叉既缺证据又选了贵做法，只算一次打断', () => {
  const d = run([fork({ options_cost: { 覆盖式: 'low', '留 gutter': 'high' }, picked: '留 gutter' })], {
    observations: [HIGH],
    verifications: [NONE],
  });
  assert.equal(d.questions.length, 1);
  assert.equal(d.violations.length, 1);
  assert.equal(d.metrics.interrupts, 1);
});

test('一屏呈现：需你定在前，未验证汇总在后，每条固定三行', () => {
  const text = render(
    run(
      [
        fork({ fork: '信息架构要不要独立路由', options_cost: undefined }),
        fork({ fork: '列表行高 token' }),
      ],
      { observations: [HIGH, LOW], verifications: [NONE, NONE] },
    ),
  );
  const lines = text.split('\n');
  assert.ok(lines[0].startsWith('【开工前 1 条'));
  assert.ok(lines.findIndex((l) => l.startsWith('【交付末尾')) > 3);
  // 分叉 / 候选与已选 / 代价与凭什么
  assert.equal(lines.filter((l) => /^     /.test(l)).length, 2);
  assert.match(lines[3], /代价 high · 凭什么/);
});

test('台账为空数组不报错，也没有任何东西可打断', () => {
  const d = decide(enrich({ forks: [] }, {}), { humanPresent: false });
  assert.equal(d.action, 'proceed');
  assert.equal(d.total, 0);
});

test('分叉多于一条时逐条独立判定，互不遮蔽', () => {
  const d = run([fork({ fork: 'A' }), fork({ fork: 'B' }), fork({ fork: 'C' })], {
    observations: [HIGH, LOW, LOW],
    verifications: [NONE, NONE, GOOD],
  });
  assert.deepEqual([d.questions.length, d.unverified.length], [1, 1]);
  assert.equal(d.metrics.interrupts, 1);
});
