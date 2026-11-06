import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFocusProbe, focusProbeCoverage } from '../src/observe/focus.mjs';

const el = (over = {}) => ({ selector: '#send', rect: { w: 44, h: 44 }, focusable: true, baseStyle: 'none|medium|rgb(0,0,0)|none|rgb(0,0,0)|none', ...over });

test('真实 Tab 走到且样式变了 → 焦点可见', () => {
  const out = applyFocusProbe([el()], [{ selector: '#send', style: 'solid|2px|rgb(0,120,215)|none|rgb(0,0,0)|none' }]);
  assert.equal(out[0].hasVisibleFocus, true);
});

test('走到但样式毫无变化 → 焦点不可见，这是 outline:none 的形状', () => {
  const one = el();
  const out = applyFocusProbe([one], [{ selector: '#send', style: one.baseStyle }]);
  assert.equal(out[0].hasVisibleFocus, false);
});

test('Tab 没走到的元素留 null，不许猜它有或没有焦点环', () => {
  const out = applyFocusProbe([el({ selector: '#skipped' })], [{ selector: '#other', style: 'x' }]);
  assert.equal(out[0].hasVisibleFocus, null);
});

test('没有 baseStyle 就不作数——采集残缺不能被解释成结论', () => {
  const out = applyFocusProbe([el({ baseStyle: undefined })], [{ selector: '#send', style: 'solid' }]);
  assert.equal(out[0].hasVisibleFocus, null);
});

test('不可聚焦元素不参与，也不占用探针名额', () => {
  const out = applyFocusProbe([el({ focusable: false })], []);
  assert.equal(out[0].hasVisibleFocus, null);
});

test('探针结果为 null 时不改动其它字段', () => {
  const out = applyFocusProbe([el({ tag: '保留' })], null);
  assert.deepEqual(out, [{ selector: '#send', rect: { w: 44, h: 44 }, focusable: true, baseStyle: 'none|medium|rgb(0,0,0)|none|rgb(0,0,0)|none', tag: '保留', hasVisibleFocus: null }]);
});

test('覆盖率把探到几个、其中几个不可见分开报', () => {
  const interactive = [el({ selector: '#a' }), el({ selector: '#b' }), el({ selector: '#c' })];
  const samples = [
    { selector: '#a', style: '变了' },
    { selector: '#b', style: 'none|medium|rgb(0,0,0)|none|rgb(0,0,0)|none' },
  ];
  assert.deepEqual(focusProbeCoverage(interactive, samples), { probed: 2, invisible: 1 });
});

test('完全没有样本时覆盖率为零，而不是"全都不可见"', () => {
  assert.deepEqual(focusProbeCoverage([el()], []), { probed: 0, invisible: 0 });
});
