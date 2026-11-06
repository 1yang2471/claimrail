import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runChecks,
  scrollbarClearsText,
  touchTargetsOk,
  contrastOk,
  contrastRatio,
  focusVisibleOk,
  bottomNotCovered,
  CHECK_IDS,
} from '../src/observe/geometry.mjs';

const container = (over = {}) => ({ selector: '.msg-list', rect: { x: 0, y: 0, w: 400, h: 600 }, scrollableY: true, reservedX: 0, ...over });
const rightBubble = (over = {}) => ({ selector: '.bubble.me', rect: { x: 210, y: 500, w: 180, h: 40 }, color: '#111111', background: '#ffffff', fontSize: 15, ...over });

// ---- 动机性例子：滚动条压在右对齐气泡上 ----

test('覆盖式滚动条压住右对齐消息文本 → 红', () => {
  const r = scrollbarClearsText({ scrollContainers: [container()], texts: [rightBubble()] });
  assert.equal(r.ok, false);
  assert.match(r.detail, /覆盖式滚动条压住 1 处文本/);
  assert.match(r.detail, /\.bubble\.me/);
});

test('经典滚动条占了 15px 布局宽度，同样的几何就不算遮', () => {
  assert.equal(scrollbarClearsText({ scrollContainers: [container({ reservedX: 15 })], texts: [rightBubble()] }).ok, true);
});

test('文本离右边缘足够远就不算遮', () => {
  const r = scrollbarClearsText({ scrollContainers: [container()], texts: [rightBubble({ rect: { x: 10, y: 500, w: 180, h: 40 } })] });
  assert.equal(r.ok, true);
});

test('不可纵向滚动就没有滚动条带', () => {
  assert.equal(scrollbarClearsText({ scrollContainers: [container({ scrollableY: false })], texts: [rightBubble()] }).ok, true);
});

test('多处命中只报数量与首个位置，说明必须一行读完', () => {
  const texts = [rightBubble(), rightBubble({ selector: '.bubble.me2' }), rightBubble({ selector: '.bubble.me3' })];
  const r = scrollbarClearsText({ scrollContainers: [container()], texts });
  assert.equal(r.ok, false);
  assert.match(r.detail, /3 处文本/);
  assert.doesNotMatch(r.detail, /\n/);
});

// ---- 触摸目标 ----

test('短边不足 44px 的可点元素被点名', () => {
  const r = touchTargetsOk({
    interactive: [
      { selector: '.icon-btn', rect: { x: 8, y: 8, w: 28, h: 28 } },
      { selector: '.send', rect: { x: 0, y: 0, w: 88, h: 44 } },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /\.icon-btn/);
  assert.doesNotMatch(r.detail, /\.send/);
});

test('零尺寸元素不参与判定', () => {
  assert.equal(touchTargetsOk({ interactive: [{ selector: '.hidden', rect: { x: 0, y: 0, w: 0, h: 0 } }] }).ok, true);
});

test('刚好 44px 通过', () => {
  assert.equal(touchTargetsOk({ interactive: [{ selector: '.b', rect: { w: 44, h: 44 } }] }).ok, true);
});

test('超过 3 处折叠成"等 N 处"', () => {
  const many = { interactive: Array.from({ length: 7 }, (_, i) => ({ selector: `#i${i}`, rect: { w: 20, h: 20 } })) };
  assert.match(touchTargetsOk(many).detail, /等 7 处/);
});

// ---- 对比度 ----

test('#767676 on 白是有名的 4.5 边界', () => {
  assert.equal(contrastRatio('#767676', '#ffffff') >= 4.5, true);
  assert.equal(contrastRatio('#777777', '#ffffff') < 4.5, true);
});

test('rgb() 与十六进制等价', () => {
  assert.ok(Math.abs(contrastRatio('rgb(118,118,118)', '#fff') - contrastRatio('#767676', '#ffffff')) < 1e-9);
});

test('正文对比度不足 → 报最低的一处', () => {
  const r = contrastOk({
    texts: [
      { selector: '.a', color: '#888888', background: '#ffffff', fontSize: 14 },
      { selector: '.b', color: '#aaaaaa', background: '#ffffff', fontSize: 14 },
      { selector: '.c', color: '#000000', background: '#ffffff', fontSize: 14 },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /\.b/);
  assert.match(r.detail, /2\.32/);
});

test('大字号走 3:1，小字号走 4.5:1', () => {
  const weak = { color: '#888888', background: '#ffffff' };
  assert.equal(contrastOk({ texts: [{ selector: '.h', ...weak, fontSize: 28 }] }).ok, true);
  assert.equal(contrastOk({ texts: [{ selector: '.p', ...weak, fontSize: 13 }] }).ok, false);
});

test('18.66px 以上加粗按大字号算', () => {
  const weak = { color: '#888888', background: '#ffffff', fontSize: 19 };
  assert.equal(contrastOk({ texts: [{ selector: '.b', ...weak, bold: true }] }).ok, true);
  assert.equal(contrastOk({ texts: [{ selector: '.n', ...weak, bold: false }] }).ok, false);
});

test('颜色解析不了就是"未判"，既不算绿也不算红', () => {
  assert.equal(contrastOk({ texts: [{ selector: '.x', color: 'var(--fg)', background: 'transparent' }] }).ok, null);
  assert.equal(contrastRatio('nope', '#fff'), null);
});

// ---- 焦点可见 ----

test('聚焦时看不出变化的元素被点名，这是 outline:none 的形状', () => {
  const r = focusVisibleOk({ interactive: [{ selector: '.tab', focusable: true, hasVisibleFocus: false }] });
  assert.equal(r.ok, false);
  assert.match(r.detail, /\.tab/);
});

test('不可聚焦的元素凑不进焦点检查，没得查就是不作数', () => {
  assert.equal(focusVisibleOk({ interactive: [{ selector: '.div', focusable: false, hasVisibleFocus: false }] }).ok, null);
});

test('探针没跑（hasVisibleFocus 为 null）不许冒充看过焦点环', () => {
  const r = focusVisibleOk({ interactive: [{ selector: '.tab', focusable: true, hasVisibleFocus: null }] });
  assert.equal(r.ok, null);
  assert.match(r.detail, /未做焦点探测/);
});

test('部分元素探到了就按探到的判，说明里写清核了几个', () => {
  const r = focusVisibleOk({
    interactive: [
      { selector: '.a', focusable: true, hasVisibleFocus: true },
      { selector: '.b', focusable: true, hasVisibleFocus: null },
    ],
  });
  assert.equal(r.ok, true);
  assert.match(r.detail, /已核 1 个/);
});

// ---- 底部被遮 ----

test('最后一条消息落在固定输入框范围内 → 红', () => {
  const page = {
    scrollContainers: [container({ lastChildRect: { x: 0, y: 700, w: 400, h: 40 } })],
    fixedRects: [{ selector: '.composer', rect: { x: 0, y: 720, w: 400, h: 60 } }],
  };
  assert.equal(bottomNotCovered(page).ok, false);
});

test('内容项停在输入框之上 → 绿', () => {
  const page = {
    scrollContainers: [container({ lastChildRect: { x: 0, y: 600, w: 400, h: 40 } })],
    fixedRects: [{ selector: '.composer', rect: { x: 0, y: 720, w: 400, h: 60 } }],
  };
  assert.equal(bottomNotCovered(page).ok, true);
});

test('没采到固定元素就是未判——缺数据不许冒充"没问题"', () => {
  assert.equal(bottomNotCovered({ scrollContainers: [container({ lastChildRect: { x: 0, y: 700, w: 400, h: 40 } })] }).ok, null);
});

// ---- 汇总 ----

test('一个健康的页面五项全绿', () => {
  const page = {
    scrollContainers: [container({ reservedX: 15, lastChildRect: { x: 0, y: 100, w: 380, h: 40 } })],
    texts: [{ selector: '.p', rect: { x: 10, y: 100, w: 200, h: 20 }, color: '#111111', background: '#ffffff', fontSize: 15 }],
    interactive: [{ selector: '.send', rect: { x: 0, y: 0, w: 88, h: 44 }, focusable: true, hasVisibleFocus: true }],
    fixedRects: [{ selector: '.composer', rect: { x: 0, y: 720, w: 400, h: 60 } }],
  };
  const results = runChecks(page);
  assert.deepEqual(results.map((r) => r.id), CHECK_IDS);
  assert.deepEqual(results.filter((r) => !r.ok), []);
});

test('空数据不抛错，五项都在且全部不作数——采集失败绝不能变成五个绿', () => {
  const results = runChecks({});
  assert.deepEqual(results.map((r) => r.id), CHECK_IDS);
  assert.deepEqual(results.map((r) => r.ok), [null, null, null, null, null]);
});

test('红项把绿项挤在后面也能一眼看出第一条问题', () => {
  const page = { scrollContainers: [container()], texts: [rightBubble()] };
  assert.equal(runChecks(page).find((r) => !r.ok).id, 'scrollbar-clears-text');
});
