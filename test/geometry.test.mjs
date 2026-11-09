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

test('滚动容器正好停在条之上 → 不重叠就是绿', () => {
  const page = {
    scrollContainers: [container({ rect: { x: 0, y: 0, w: 400, h: 720 } })],
    fixedRects: [{ selector: '.composer', rect: { x: 0, y: 720, w: 400, h: 60 } }],
  };
  assert.equal(bottomNotCovered(page).ok, true);
});

// ---- 底部被遮 ----

test('三种"其实没有条带压在内容上"的情况都不该判红', () => {
  const page = (over) => ({ scrollContainers: [container(over)], texts: [rightBubble()] });
  assert.equal(scrollbarClearsText(page({ reservedX: 15 })).ok, true, '经典滚动条占了布局宽度');
  assert.equal(scrollbarClearsText(page({ scrollbarStyle: 'none' })).ok, true, 'scrollbar-width: none 根本不画条');
  assert.equal(scrollbarClearsText(page({ gutter: 'stable' })).ok, true, 'scrollbar-gutter: stable 已预留位');
});

test('覆盖式滚动条 + 默认样式仍然是红——豁免不能把主例子一起豁免掉', () => {
  assert.equal(scrollbarClearsText({ scrollContainers: [container({ scrollbarStyle: 'auto' })], texts: [rightBubble()] }).ok, false);
});

test('滚动容器自己的 sticky 子元素不算遮挡', () => {
  const page = {
    scrollContainers: [container({ rect: { x: 0, y: 0, w: 400, h: 780 } })],
    fixedRects: [{ selector: '.day', rect: { x: 0, y: 0, w: 400, h: 28 }, inside: '.msg-list' }],
  };
  assert.equal(bottomNotCovered(page).ok, true);
});

test('不属于该容器的贴底条照样判红', () => {
  const page = {
    scrollContainers: [container({ rect: { x: 0, y: 0, w: 400, h: 780 } })],
    fixedRects: [{ selector: '.composer', rect: { x: 0, y: 720, w: 400, h: 60 }, inside: 'body>div>.other' }],
  };
  assert.equal(bottomNotCovered(page).ok, false);
});

test('滚动区域伸进固定输入框底下 → 红（结构性，与滚到哪无关）', () => {
  const page = {
    scrollContainers: [container({ rect: { x: 0, y: 0, w: 400, h: 780 } })],
    fixedRects: [{ selector: '.composer', rect: { x: 0, y: 720, w: 400, h: 60 } }],
  };
  const r = bottomNotCovered(page);
  assert.equal(r.ok, false);
  assert.match(r.detail, /滚动区域被贴底的固定条压住/);
});

test('内容比可视框长不是判据——贴底的条才是', () => {
  // 旧用例把容器矩形写成 2000 高，那是内容高度；滚动容器的 rect 是可视框。
  // 现在按真实几何：可视框 700 高，条贴在 640..700。
  const page = {
    scrollContainers: [container({ rect: { x: 0, y: 0, w: 400, h: 700 } })],
    fixedRects: [{ selector: '.composer', rect: { x: 0, y: 640, w: 400, h: 60 } }],
  };
  assert.equal(bottomNotCovered(page).ok, false);
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

test('别的容器里的文本坐标撞上也不算压住', () => {
  const page = {
    scrollContainers: [container()],
    texts: [rightBubble({ container: 'body>div>.sidebar' })],
  };
  assert.equal(scrollbarClearsText(page).ok, true);
});

test('同一容器内的文本才算数', () => {
  const page = { scrollContainers: [container()], texts: [rightBubble({ container: '.msg-list' })] };
  assert.equal(scrollbarClearsText(page).ok, false);
});

test('采集被截断改判"不作数"，不许拿半截数据宣布全绿', () => {
  const page = { scrollContainers: [container()], texts: [rightBubble()], raw: { texts: 613, interactive: 5, scrollContainers: 1, fixedRects: 1 } };
  const r = scrollbarClearsText(page);
  assert.equal(r.ok, null);
  assert.match(r.detail, /截断/);
  assert.equal(contrastOk({ texts: [{ selector: '.a', color: '#111', background: '#fff' }], raw: { texts: 401 } }).ok, null);
  assert.equal(touchTargetsOk({ interactive: [{ selector: '.b', rect: { w: 44, h: 44 } }], raw: { interactive: 121 } }).ok, null);
});

test('悬浮在滚动区中间的浮标与圆形 FAB 不算遮挡', () => {
  const page = {
    scrollContainers: [container({ rect: { x: 0, y: 0, w: 400, h: 780 } })],
    fixedRects: [
      { selector: '.toast', rect: { x: 120, y: 600, w: 160, h: 32 } },
      { selector: '.fab', rect: { x: 340, y: 700, w: 56, h: 56 } },
    ],
  };
  assert.equal(bottomNotCovered(page).ok, true);
});

test('贴底且覆盖宽度足够的条才算遮挡', () => {
  const page = {
    scrollContainers: [container({ rect: { x: 0, y: 0, w: 400, h: 780 } })],
    fixedRects: [{ selector: '.composer', rect: { x: 0, y: 720, w: 400, h: 60 } }],
  };
  const r = bottomNotCovered(page);
  assert.equal(r.ok, false);
  assert.match(r.detail, /贴底的固定条/);
});

test('很窄但贴底的条不算遮挡（比如 2px 分隔线）', () => {
  const page = {
    scrollContainers: [container({ rect: { x: 0, y: 0, w: 400, h: 780 } })],
    fixedRects: [{ selector: '.rule', rect: { x: 0, y: 778, w: 60, h: 2 } }],
  };
  assert.equal(bottomNotCovered(page).ok, true);
});

test('焦点只探到一部分时判"不作数"，覆盖率不足不是全绿', () => {
  const r = focusVisibleOk({
    interactive: [
      { selector: '.a', focusable: true, hasVisibleFocus: true },
      { selector: '.b', focusable: true, hasVisibleFocus: null },
    ],
  });
  assert.equal(r.ok, null);
  assert.match(r.detail, /只覆盖 1\/2/);
});

test('采不到实色背景（渐变/图片）就未判，绝不许产生红', () => {
  // 真站实测教训：白字药丸标签的可见底色来自 background-image，
  // 采样 backgroundColor 得到透明，旧实现兜底成白色 → 83 处 1.00 假红
  const allUnknown = { texts: [{ selector: '.pill', color: '#ffffff', background: null }] };
  assert.equal(contrastOk(allUnknown).ok, null);
  assert.match(contrastOk(allUnknown).detail, /底色或色值采不到/);

  const mixed = {
    texts: [
      { selector: '.a', color: '#111111', background: '#ffffff' },
      { selector: '.b', color: '#111111', background: '#ffffff' },
      { selector: '.pill', color: '#ffffff', background: null },
    ],
  };
  assert.match(contrastOk(mixed).detail, /已核 2 处，另有 1 处未判（底色或色值采不到/);

  const oneBad = {
    texts: [
      { selector: '.a', color: '#888888', background: '#ffffff', fontSize: 13 },
      { selector: '.pill', color: '#ffffff', background: null },
    ],
  };
  const r = contrastOk(oneBad);
  assert.equal(r.ok, false);
  assert.match(r.detail, /1\/1 处/);
});

test('正文里的行内链接不按控件标准考核', () => {
  // 真站实测教训：语言切换与正文链接被算成"触摸目标过小"，一次造出十几个假红
  const page = {
    interactive: [
      { selector: '.doc-link', rect: { w: 60, h: 18 }, inline: true },
      { selector: '.lang-zh', rect: { w: 34, h: 20 }, inline: true },
      { selector: '#send', rect: { w: 44, h: 44 } },
    ],
  };
  const r = touchTargetsOk(page);
  assert.equal(r.ok, true);
  assert.match(r.detail, /已核 1 个控件/);

  const onlyInline = { interactive: [{ selector: '.link', rect: { w: 40, h: 16 }, inline: true }] };
  assert.equal(touchTargetsOk(onlyInline).ok, null);
});
test('半透明必须合成后再算，不许把 5% 黑当成纯黑', () => {
  // 真站实测的假红形状：code 元素背景 rgba(0,0,0,.05) 铺在白卡上
  const composited = 'rgb(242, 242, 242)';
  assert.ok(contrastRatio('rgb(28, 28, 28)', composited) > 12);
  assert.equal(contrastRatio('rgb(28, 28, 28)', 'rgba(0, 0, 0, 0.05)'), null, '背景自己半透明 → 未知，不许硬算');

  // 50% 黑压在白上 = rgb(128,128,128) → 约 3.95，确实不足 4.5，该判红
  const r = contrastOk({ texts: [{ selector: '.ghost', color: 'rgba(0,0,0,0.5)', background: 'rgb(255,255,255)', fontSize: 14 }] });
  assert.equal(r.ok, false);
  assert.match(r.detail, /3\.9\d/);

  // #767676 带 alpha 0x80（=128/255）压白 → 合成值要按算式给，别写死
  const half = 0x80 / 255;
  const comp = Math.round(half * 0x76 + (1 - half) * 255);
  assert.ok(Math.abs(contrastRatio('#76767680', '#ffffff') - contrastRatio(`rgb(${comp},${comp},${comp})`, '#ffffff')) < 1e-9);
  assert.notEqual(contrastRatio('#76767680', '#ffffff'), contrastRatio('#767676', '#ffffff'), '忽略 alpha 就会算出这个错值');
});

test('百分号色值不作数，不按 0-255 硬算', () => {
  assert.equal(contrastRatio('rgb(50%, 0%, 0%)', '#fff'), null);
  assert.equal(contrastOk({ texts: [{ selector: '.x', color: 'rgb(50%, 0%, 0%)', background: 'rgb(255,255,255)' }] }).ok, null);
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

// 审查抓到的假绿：截断判断只在 texts / interactive 上做了，scrollContainers 与 fixedRects
// 被静默丢掉——固定元素超过 40 个在真实页面上很常见（每个 sticky 表头都算），
// 第 41 个之后固定条压内容永远查不到，而报告写的是"已核 40 个固定元素"。
test('滚动容器/固定条被截断时也要改判"不作数"', () => {
  const containers = Array.from({ length: 60 }, (_, i) => ({
    selector: `#c${i}`,
    rect: { x: 0, y: 0, w: 100, h: 100 },
    scrollableY: true,
    reservedX: 0,
    scrollbarStyle: 'auto',
    gutter: '',
  }));
  const s = scrollbarClearsText({ scrollContainers: containers, texts: [], raw: { scrollContainers: 61 } });
  assert.equal(s.ok, null, `滚动区被截断却报了 ${s.ok}：${s.detail}`);
  assert.match(s.detail, /截断/);

  const bars = Array.from({ length: 40 }, (_, i) => ({ selector: `#f${i}`, rect: { x: 0, y: 990, w: 300, h: 10 } }));
  const b = bottomNotCovered({
    scrollContainers: [{ selector: '#sc', rect: { x: 0, y: 0, w: 300, h: 1000 }, scrollableY: true }],
    fixedRects: bars,
    raw: { fixedRects: 41 },
  });
  assert.equal(b.ok, null, `固定条被截断却报了 ${b.ok}：${b.detail}`);
  assert.match(b.detail, /截断/);
});

// 审查补上的最后两类截断守卫：focusVisibleOk 没查 interactive、bottomNotCovered 没查
// scrollContainers。四类采集必须一个不漏——截断的报告出 true 还能被 render 证据引用成"已验证"。
test('交互元素/滚动容器被截断时，焦点与遮挡检查同样改判"不作数"', () => {
  const f = focusVisibleOk({
    interactive: Array.from({ length: 120 }, (_, i) => ({
      selector: `#i${i}`,
      rect: { x: 0, y: 0, w: 44, h: 44 },
      focusable: true,
      hasVisibleFocus: true,
    })),
    raw: { interactive: 121 },
  });
  assert.equal(f.ok, null, `交互元素被截断却报了 ${f.ok}：${f.detail}`);
  assert.match(f.detail, /截断/);

  const b = bottomNotCovered({
    scrollContainers: [{ selector: '#sc', rect: { x: 0, y: 0, w: 300, h: 1000 }, scrollableY: true }],
    fixedRects: [{ selector: '.rule', rect: { x: 0, y: 990, w: 60, h: 2 } }],
    raw: { scrollContainers: 61 },
  });
  assert.equal(b.ok, null, `滚动容器被截断却报了 ${b.ok}：${b.detail}`);
  assert.match(b.detail, /截断/);
});

// 透明文字（sr-only、图标字体）没有对比度可言：把 rgba(0,0,0,0) 合成到底色上得到 1.00，
// 报"对比度不足"是纯假红——真站上这类元素能一次性造一排红。
test('透明文字不算"对比度不足"，也不冒充"已核"', () => {
  const only = contrastOk({ texts: [{ selector: '.sr-only', color: 'rgba(0, 0, 0, 0)', background: 'rgb(255, 255, 255)', fontSize: 16 }] });
  assert.equal(only.ok, null, `透明文字被判成 ${only.ok}：${only.detail}`);

  const mixed = contrastOk({
    texts: [
      { selector: '.a', color: '#111111', background: '#ffffff', fontSize: 16 },
      { selector: '.sr-only', color: 'rgba(0, 0, 0, 0)', background: '#ffffff', fontSize: 16 },
    ],
  });
  assert.equal(mixed.ok, true, mixed.detail);
  assert.match(mixed.detail, /已核 1 处/, mixed.detail);
});
