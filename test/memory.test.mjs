import test from 'node:test';
import assert from 'node:assert/strict';
import { append, rules, hits, invalidate, anchors, rejections, formatRules, PROMOTE_HITS } from '../src/memory.mjs';

const E = (over) => ({ key: 'card-gap', what: '卡片上下间距至少 16px', ...over });

test('log 只追加，不改动已有内容', () => {
  const a = [];
  const b = append(a, E({}));
  const c = append(b, E({ what: '卡片上下间距还是挤，要 16px' }));
  assert.equal(a.length, 0);
  assert.equal(b.length, 1);
  assert.equal(c.length, 2);
});

test('每条记录带一个稳定的 log#n 位置，供规则回溯出处', () => {
  let log = [];
  log = append(log, E({ key: 'a' }));
  log = append(log, E({ key: 'b' }));
  assert.deepEqual(log.map((e) => e.at), [1, 2]);
});

test('没有 key 的否决无法统计命中，直接拒收', () => {
  assert.throws(() => append([], { what: '丑' }), /key/);
  assert.throws(() => append([], { key: 'x' }), /what/);
});

test('命中一次不升格：随口一句吐槽不该被永久固化', () => {
  assert.deepEqual(rules(append([], E({}))), []);
  assert.equal(PROMOTE_HITS, 2);
});

test('命中两次才升格，且带全部出处指针', () => {
  let log = [];
  log = append(log, E({ what: '卡片间距 8px 太挤' }));
  log = append(log, E({ key: 'other', what: '滚动条别压气泡' }));
  log = append(log, E({ what: '卡片间距 10px 还是挤' }));

  const r = rules(log);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].sources, ['log#1', 'log#3']);
  assert.equal(r[0].key, 'card-gap');
});

test('规则文本取最近一次措辞', () => {
  let log = [];
  log = append(log, E({ what: '太挤' }));
  log = append(log, E({ what: '卡片上下间距至少 16px' }));
  assert.equal(rules(log)[0].rule, '卡片上下间距至少 16px');
});

test('命中三次，出处也留三条', () => {
  let log = [];
  for (const w of ['a', 'b', 'c']) log = append(log, E({ what: w }));
  assert.deepEqual(rules(log)[0].sources, ['log#1', 'log#2', 'log#3']);
});

test('hits 直接查某类否决发生过几次', () => {
  let log = [];
  log = append(log, E({}));
  log = append(log, E({ key: 'scroll' }));
  assert.deepEqual(hits(log, 'card-gap'), ['log#1']);
  assert.deepEqual(hits(log, 'nope'), []);
});

test('废规则按 key 或按 id 都认——人只会说"那条关于滚动条的别要了"', () => {
  let log = [];
  log = append(log, E({}));
  log = append(log, E({}));
  const r = rules(log);
  assert.equal(invalidate(r, ['card-gap']).length, 0);
  assert.equal(invalidate(r, ['r:card-gap']).length, 0);
  assert.equal(invalidate(r, []).length, 1);
});

test('废掉之后可以重新升格：原始 log 还在，规则只是缓存', () => {
  let log = [];
  log = append(log, E({}));
  log = append(log, E({}));
  assert.equal(invalidate(rules(log), ['card-gap']).length, 0);
  assert.equal(rules(log).length, 1);
});

test('正向参照物不混进规则里', () => {
  let log = append([], E({}));
  log = append(log, E({}));
  log = Object.freeze([...log, Object.freeze({ kind: 'anchor', key: 'chat-composer', what: '按 Linear composer 的间距', at: 3 })]);

  assert.equal(rules(log).length, 1);
  assert.equal(rejections(log).length, 2);
  assert.deepEqual(anchors(log).map((a) => a.key), ['chat-composer']);
});

test('规则输出必须带得出处的指针，没有出处的规则不可推翻', () => {
  let log = [];
  log = append(log, E({}));
  log = append(log, E({}));
  assert.match(formatRules(rules(log)), /\[来源: log#1,log#2]/);
});

test('规则按 key 排序，台账 diff 才稳定', () => {
  let log = [];
  for (const key of ['zeta', 'alpha']) {
    log = append(log, E({ key }));
    log = append(log, E({ key }));
  }
  assert.deepEqual(rules(log).map((r) => r.key), ['alpha', 'zeta']);
});
