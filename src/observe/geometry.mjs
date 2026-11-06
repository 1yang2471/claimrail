// 渲染后检查的判定逻辑。纯函数：进来的是一页里采到的矩形与颜色，出去的是红绿和一句话说明。
//
// 这一层刻意不含任何浏览器调用。它应该能用手写的矩形数据测透——
// 也只有这样，"滚动条压在右对齐气泡上"才是可复现的断言，而不是又一次"我看着没问题"。

const OVERLAY_BAR = 15; // 覆盖式滚动条的常见宽度；经典滚动条会占布局，那种情况不遮内容
const TOUCH_MIN = 44;
const CONTRAST_NORMAL = 4.5;
const CONTRAST_LARGE = 3;
const LARGE_PX = 24;
const LARGE_BOLD_PX = 18.66;

export const CHECK_IDS = [
  'scrollbar-clears-text',
  'touch-targets-ok',
  'contrast-ok',
  'focus-visible-ok',
  'bottom-not-covered',
];

function parseColor(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const rgb = /rgba?\(([^)]+)\)/.exec(s);
  if (!rgb) return null;
  const parts = rgb[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
  return parts.slice(0, 3);
}

const relLum = ([r, g, b]) => {
  const f = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

export function contrastRatio(fg, bg) {
  const a = parseColor(fg);
  const b = parseColor(bg);
  if (!a || !b) return null;
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const rect = (r) => ({ x: r.x, y: r.y, w: r.w ?? r.width ?? 0, h: r.h ?? r.height ?? 0 });
const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

// 条带只在"确实会画一条盖在内容上"时才存在。三种情况没有条带：
// 经典滚动条占了布局宽度、scrollbar-width: none 根本不画、scrollbar-gutter: stable 预留了位。
// 少判一种就漏掉用户的原始例子，多判一种就是假红——所以三种都要显式承认。
function overlayStrip(container) {
  const c = rect(container.rect);
  if (!container.scrollableY || c.w <= 0 || c.h <= 0) return null;
  if ((container.reservedX ?? 0) > 0) return null;
  if (container.scrollbarStyle === 'none') return null;
  if (String(container.gutter ?? '').includes('stable')) return null;
  return { x: c.x + c.w - OVERLAY_BAR, y: c.y, w: OVERLAY_BAR, h: c.h };
}

const fail = (id, detail) => ({ id, ok: false, detail });
const pass = (id, detail = '') => ({ id, ok: true, detail });
// 第三态是必须的：采集器没拿到数据时判绿，等于允许"我没看见"冒充"没问题"。
// 证据回验只认 ok === true，null 与 false 都过不去。
const skip = (id, detail = '未采到可判定的数据，不作数') => ({ id, ok: null, detail });

const nonEmpty = (list) => Array.isArray(list) && list.length > 0;

const list = (items) => items.slice(0, 3).map((i) => i.selector || i.tag).join('、') + (items.length > 3 ? ` 等 ${items.length} 处` : '');

export function scrollbarClearsText(page) {
  if (!nonEmpty(page.scrollContainers)) return skip('scrollbar-clears-text', '页面里没有纵向滚动容器可查');

  const hit = [];
  for (const container of page.scrollContainers ?? []) {
    const strip = overlayStrip(container);
    if (!strip) continue;
    for (const text of page.texts ?? []) {
      if (overlaps(strip, rect(text.rect))) hit.push({ ...text, container: container.selector });
    }
  }
  if (!hit.length) return pass('scrollbar-clears-text');
  return fail('scrollbar-clears-text', `覆盖式滚动条压住 ${hit.length} 处文本，首个：${hit[0].selector}（容器 ${hit[0].container}）`);
}

export function touchTargetsOk(page) {
  if (!nonEmpty(page.interactive)) return skip('touch-targets-ok', '没采到可交互元素');

  const small = (page.interactive ?? []).filter((el) => {
    const r = rect(el.rect);
    if (r.w <= 0 || r.h <= 0) return false;
    return Math.min(r.w, r.h) < TOUCH_MIN;
  });
  if (!small.length) return pass('touch-targets-ok');
  return fail('touch-targets-ok', `${small.length} 个可点元素短边不足 ${TOUCH_MIN}px：${list(small)}`);
}

export function contrastOk(page) {
  const bad = [];
  let measured = 0;
  for (const t of page.texts ?? []) {
    const ratio = contrastRatio(t.color, t.background);
    if (ratio === null) continue;
    measured += 1;
    const large = (t.fontSize ?? 16) >= LARGE_PX || ((t.fontSize ?? 16) >= LARGE_BOLD_PX && Boolean(t.bold));
    if (ratio < (large ? CONTRAST_LARGE : CONTRAST_NORMAL)) bad.push({ ...t, ratio });
  }
  if (measured === 0) return skip('contrast-ok', '没有可解析的正文颜色对');
  if (!bad.length) return pass('contrast-ok', `已核 ${measured} 处`);
  const worst = bad.reduce((a, b) => (b.ratio < a.ratio ? b : a));
  return fail('contrast-ok', `${bad.length} 处正文对比度不足 4.5:1，最低 ${worst.ratio.toFixed(2)}（${worst.selector}）`);
}

export function focusVisibleOk(page) {
  const focusables = (page.interactive ?? []).filter((el) => el.focusable !== false);
  if (!focusables.length) return skip('focus-visible-ok', '没有可聚焦元素可查');

  // hasVisibleFocus === null 表示探针没跑（当前驱动无法产生真实键盘焦点）。
  // 这种降级必须留在"不作数"里：判绿就等于宣称看过焦点环。
  const measured = focusables.filter((el) => el.hasVisibleFocus === true || el.hasVisibleFocus === false);
  if (!measured.length) return skip('focus-visible-ok', `未做焦点探测（${focusables.length} 个可聚焦元素待真实键盘事件）`);

  const dark = measured.filter((el) => el.hasVisibleFocus === false);
  if (!dark.length) return pass('focus-visible-ok', `已核 ${measured.length} 个`);
  return fail('focus-visible-ok', `${dark.length} 个可聚焦元素聚焦时看不出变化：${list(dark)}`);
}

export function bottomNotCovered(page) {
  // 信号是结构性的：滚动容器自己的矩形伸进了固定/粘性条底下。
  // 曾经用"最后一个内容项"来比，结果漏判——列表一溢出末项就在屏幕外，
  // 永远不相交，而那恰恰是最典型的一种盖住。跟滚动到哪无关。
  const containers = (page.scrollContainers ?? []).map((c) => ({ selector: c.selector, rect: rect(c.rect) }));
  const fixed = (page.fixedRects ?? [])
    .map((f) => ({ selector: f.selector, inside: f.inside, rect: rect(f?.rect ?? f) }))
    .filter((f) => f.rect.w > 0 && f.rect.h > 0);
  if (!fixed.length || !containers.length) return skip('bottom-not-covered', '缺少固定条或滚动容器，未判');

  const hit = [];
  for (const c of containers) {
    for (const f of fixed) {
      // 容器自己的 sticky 子元素（日期分隔条那种）必然与容器重叠，那不是遮挡
      if (f.inside && f.inside === c.selector) continue;
      if (overlaps(c.rect, f.rect)) hit.push(f.selector ?? c.selector);
    }
  }
  if (!hit.length) return pass('bottom-not-covered');
  return fail('bottom-not-covered', `滚动区域与固定条重叠，内容会被盖住：${[...new Set(hit)].join('、')}`);
}

export function runChecks(page) {
  return [
    scrollbarClearsText(page),
    touchTargetsOk(page),
    contrastOk(page),
    focusVisibleOk(page),
    bottomNotCovered(page),
  ];
}
