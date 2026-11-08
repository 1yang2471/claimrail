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

const run = (forks, { observations, verifications, optionsCosts, humanPresent = true } = {}) =>
  decide(enrich({ forks }, { observations, verifications, optionsCosts }), { humanPresent });

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

const COSTS_EXPENSIVE_PICKED = { 覆盖式: 'low', '留 gutter': 'high' };
const COSTS_BOTH_LOW = { 覆盖式: 'low', '留 gutter': 'low' };

test('无证据却选了改起来更贵的候选——静默塌缩最典型的形状', () => {
  const d = run([fork()], { observations: [LOW], verifications: [NONE], optionsCosts: [COSTS_EXPENSIVE_PICKED] });
  assert.equal(d.violations.length, 1);
  assert.equal(d.action, 'block');
  assert.match(render(d), /程序算出更便宜的候选是 low/);
});

test('有证据时选贵的做法是知情决定，不拦也不报未启用', () => {
  const d = run([fork()], { observations: [LOW], verifications: [GOOD], optionsCosts: [COSTS_EXPENSIVE_PICKED] });
  assert.equal(d.violations.length, 0);
  assert.equal(d.metrics.rule4NotEnabled, 0);
  assert.equal(d.action, 'proceed');
});

test('候选代价算不出来不等于没事——当场报"规则四未启用"，让逃逸可统计', () => {
  const d = run([fork()], { observations: [LOW], verifications: [NONE] });
  assert.equal(d.violations.length, 0);
  assert.equal(d.metrics.rule4NotEnabled, 1);
  const text = render(d);
  assert.match(text, /规则四未启用 1 条/);
  assert.match(text, /覆盖式=缺 留 gutter=缺/);
});

test('候选标签对不上程序算出来的档位，同样按未启用处理', () => {
  const d = run([fork()], { observations: [LOW], verifications: [NONE], optionsCosts: [{ a: 'low', b: 'low' }] });
  assert.equal(d.metrics.rule4NotEnabled, 1, '映射不上就是没数据，不能当成"都便宜"');
});

test('部分候选有 target 也不判：半截数据比没数据更危险', () => {
  const half = [fork({ options: [{ label: '覆盖式', target: { file: 'x.ts' } }, '留 gutter'] })];
  const d = decide(enrich({ forks: half }, { observations: [LOW], verifications: [NONE] }), {});
  assert.equal(d.metrics.rule4NotEnabled, 1);
});

test('模型在台账里自填的 options_cost 一律不采信（被约束的一方不能提供约束的输入）', () => {
  const d = run([fork({ options_cost: { 覆盖式: 'low', '留 gutter': 'high' } })], { observations: [LOW], verifications: [NONE] });
  assert.equal(d.violations.length, 0, '自填的档位不该让规则判红');
  assert.equal(d.metrics.rule4NotEnabled, 1, '程序没算出来，就报未启用');
});

test('两条一字不差的分叉也算两次打断（按文本去重会低估负担）', () => {
  const d = run([fork(), fork()], { observations: [HIGH, HIGH], verifications: [NONE, NONE] });
  assert.equal(d.questions.length, 2);
  assert.equal(d.metrics.interrupts, 2);
});

test('同一条分叉既缺证据又选了贵做法，只算一次打断', () => {
  const d = run([fork()], { observations: [HIGH], verifications: [NONE], optionsCosts: [COSTS_EXPENSIVE_PICKED] });
  assert.equal(d.questions.length, 1);
  assert.equal(d.violations.length, 1);
  assert.equal(d.metrics.interrupts, 1);
});

test('一屏呈现：需你定在前，未验证汇总在后，每条固定三行', () => {
  const text = render(
    run(
      [
        fork({ fork: '信息架构要不要独立路由' }),
        fork({ fork: '列表行高 token' }),
      ],
      { observations: [HIGH, LOW], verifications: [NONE, NONE], optionsCosts: [COSTS_BOTH_LOW, COSTS_BOTH_LOW] },
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

// PRD 用户故事 4：清单里的位置要能直接点开。渲染曾是三行但没有位置，
// 用户还得回台账里翻哪个文件。
test('渲染带可点开的位置：target 优先，退回 evidence 的 file:line，都没有就不编', () => {
  const withTarget = fork({ target: { file: 'src/Chat.tsx', symbol: 'MessageList' } });
  const withRef = fork({ fork: '只带 ref', evidence: { kind: 'repo', ref: 'src/base.mjs:12', asserts: ['x'] } });
  const bare = fork({ fork: '什么都没给' });
  const text = render(run([withTarget, withRef, bare], { observations: [HIGH, HIGH, HIGH], verifications: [NONE, NONE, NONE] }));

  assert.match(text, /src\/Chat\.tsx:MessageList/);
  assert.match(text, /src\/base\.mjs:12/);
  const bareLine = text.split('\n').find((l) => l.includes('什么都没给'));
  assert.ok(!/:/.test(bareLine), `没有位置时不该编一个出来：${bareLine}`);
});

// 位置只用于显示，不许改变判定：加上 target 不该让同一条分叉从拦变成放行。
test('位置只用于显示，不参与判定', () => {
  const without = run([fork()], { observations: [HIGH], verifications: [NONE] });
  const withLoc = run([fork({ target: { file: 'src/Chat.tsx' } })], { observations: [HIGH], verifications: [NONE] });
  assert.equal(without.action, withLoc.action);
  assert.equal(without.metrics.interrupts, withLoc.metrics.interrupts);
});

// 0 条分叉不是"所有分叉都有证据"，两者不能共用一句话；
// 而 no_fork_reason 只校验不显示，reviewer 就看不到"这个类别为什么从不长分叉"。
test('申报无分叉：显示原因，而不是"0 条均有可回验证据"', () => {
  const withReason = render(decide([], { noForkReason: '只改了一个错别字' }));
  assert.match(withReason, /申报无分叉/);
  assert.match(withReason, /只改了一个错别字/);
  assert.doesNotMatch(withReason, /均有可回验证据/, '0 条分叉不该说"均有证据"');

  const bare = render(decide([]));
  assert.match(bare, /没写原因/);
});
