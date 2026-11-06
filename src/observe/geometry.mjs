// 渲染后检查的判定逻辑。纯函数：进来的是一页里采到的矩形与颜色，出去的是红/绿/不作数。
//
// 这一层不含任何浏览器调用，所以能用手写矩形测透。
//
// 三条纪律，都是被实测教出来的：
//   - 只在同一容器内比较。悬浮在右侧的浮标文字、别的容器里的 sticky 标题，
//     都不该因为坐标撞上就算"滚动条压住了本页内容"。
//   - 采集被截断时改判"不作数"，不许拿半截数据宣布全绿。
//   - "遮挡"只认贴底、够宽的条。32px 高的 toast 和 FAB 浮在滚动区上不藏内容。

const OVERLAY_BAR = 15;
const TOUCH_MIN = 44;
const CONTRAST_NORMAL = 4.5;
const CONTRAST_LARGE = 3;
const LARGE_PX = 24;
const LARGE_BOLD_PX = 18.66;
const BAR_MIN_WIDTH_RATIO = 0.3; // 覆盖容器宽度不足三成的浮层不算"条"

export const CHECK_IDS = [
  'scrollbar-clears-text',
  'touch-targets-ok',
  'contrast-ok',
  'focus-visible-ok',
  'bottom-not-covered',
];

// 返回 { rgb:[r,g,b], a } 而不是丢掉了 alpha：
// 半透明的前景或背景都必须先合成再算比值，否则 rgba(0,0,0,.05) 会被当成纯黑。
function parseRgba(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  if (s.includes('%')) return null; // 百分号色值不硬算，宁可不作数
  if (s === 'transparent') return { rgb: [0, 0, 0], a: 0 };
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = [...h].map((c) => c + c).join('') + 'ff';
    if (h.length === 6) h += 'ff';
    return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)), a: parseInt(h.slice(6, 8), 16) / 255 };
  }
  const rgb = /rgba?\(([^)]+)\)/.exec(s);
  if (!rgb) return null;
  const parts = rgb[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
  return { rgb: parts.slice(0, 3), a: parts.length >= 4 ? parts[3] : 1 };
}

const over = (fg, bg) => [0, 1, 2].map((k) => Math.round(fg.a * fg.rgb[k] + (1 - fg.a) * bg.rgb[k]));

const relLum = ([r, g, b]) => {
  const f = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

export function contrastRatio(fg, bg) {
  const f = parseRgba(fg);
  const b = parseRgba(bg);
  if (!f || !b) return null;
  if (b.a < 1) return null; // 背景本身还不透明，真实底色未知
  const solid = f.a < 1 ? { rgb: over(f, b), a: 1 } : f;
  const [hi, lo] = [relLum(solid.rgb), relLum(b.rgb)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const box = (r) => ({ x: r.x, y: r.y, w: r.w ?? r.width ?? 0, h: r.h ?? r.height ?? 0 });
const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

const fail = (id, detail) => ({ id, ok: false, detail });
const pass = (id, detail = '') => ({ id, ok: true, detail });
// 第三态是必须的：采集器没拿到那一类数据时判绿，等于允许"我没看见"冒充"没问题"。
const skip = (id, detail = '未采到可判定的数据，不作数') => ({ id, ok: null, detail });

const nonEmpty = (list) => Array.isArray(list) && list.length > 0;
const list = (items) => items.slice(0, 3).map((i) => i.selector ?? i.tag).join('、') + (items.length > 3 ? ` 等 ${items.length} 处` : '');

// 采集截断必须显式承认：cap 掉的数据不参与判定，判了就报"不作数"
function truncated(page, key) {
  const raw = page.raw?.[key];
  const got = page[key]?.length ?? 0;
  return typeof raw === 'number' && raw > got;
}

function overlayStrip(container) {
  const c = box(container.rect);
  if (!container.scrollableY || c.w <= 0 || c.h <= 0) return null;
  if ((container.reservedX ?? 0) > 0) return null; // 经典滚动条挤走布局宽度，不遮
  if (container.scrollbarStyle === 'none') return null; // 根本不画条
  if (String(container.gutter ?? '').includes('stable')) return null; // 已预留位
  return { x: c.x + c.w - OVERLAY_BAR, y: c.y, w: OVERLAY_BAR, h: c.h, container: container.selector };
}

export function scrollbarClearsText(page) {
  if (!nonEmpty(page.scrollContainers)) return skip('scrollbar-clears-text', '页面里没有纵向滚动容器可查');
  if (truncated(page, 'texts')) return skip('scrollbar-clears-text', `文本采集被截断（${page.raw.texts} > ${page.texts.length}），判不了`);

  const hit = [];
  for (const container of page.scrollContainers) {
    const strip = overlayStrip(container);
    if (!strip) continue;
    for (const text of page.texts ?? []) {
      // 只比该容器自己的文本：右侧浮标、别的容器里的 sticky 标题都不算
      if (text.container && text.container !== container.selector) continue;
      if (overlaps(strip, box(text.rect))) hit.push({ ...text, container: container.selector });
    }
  }
  if (!hit.length) {
    // 报"看过几个滚动区"，不是"有几个条带"——后者在经典滚动条/gutter 预留时为 0，
    // 读起来像什么都没查，而实际结论是"看过，没有压在内容上的条带"
    return pass('scrollbar-clears-text', `已核 ${(page.scrollContainers ?? []).length} 个滚动区，无压在内容上的条带`);
  }
  return fail('scrollbar-clears-text', `覆盖式滚动条压住 ${hit.length} 处文本，首个：${hit[0].selector}（容器 ${hit[0].container}）`);
}

export function touchTargetsOk(page) {
  // 行内文字链接不参与：这条标准是给控件的，不是给正文里的 a 标签的
  const controls = (page.interactive ?? []).filter((el) => !el.inline);
  if (!controls.length) return skip('touch-targets-ok', '没采到可交互控件（行内链接不参与本项）');
  if (truncated(page, 'interactive')) return skip('touch-targets-ok', `可交互元素采集被截断（${page.raw.interactive} > ${page.interactive.length}），判不了`);

  const small = controls.filter((el) => {
    const r = box(el.rect);
    if (r.w <= 0 || r.h <= 0) return false;
    return Math.min(r.w, r.h) < TOUCH_MIN;
  });
  if (!small.length) return pass('touch-targets-ok', `已核 ${controls.length} 个控件`);
  return fail('touch-targets-ok', `${small.length} 个可点控件短边不足 ${TOUCH_MIN}px：${list(small)}`);
}

export function contrastOk(page) {
  if (truncated(page, 'texts')) return skip('contrast-ok', `文本采集被截断（${page.raw.texts} > ${page.texts.length}），判不了`);
  const bad = [];
  let measured = 0;
  let unmeasurable = 0;
  for (const t of page.texts ?? []) {
    const ratio = contrastRatio(t.color, t.background);
    if (ratio === null) {
      // 背景来自渐变/图片，或色值写法不认识：这一处没判过，既不算绿也不算红
      unmeasurable += 1;
      continue;
    }
    measured += 1;
    const size = t.fontSize ?? 16;
    const large = size >= LARGE_PX || (size >= LARGE_BOLD_PX && Boolean(t.bold));
    if (ratio < (large ? CONTRAST_LARGE : CONTRAST_NORMAL)) bad.push({ ...t, ratio });
  }
  if (measured === 0) return skip('contrast-ok', `${unmeasurable} 处文本采不到实色背景（渐变或图片），判不了`);
  const note = unmeasurable ? `，另有 ${unmeasurable} 处采不到实色背景未判` : '';
  if (!bad.length) return pass('contrast-ok', `已核 ${measured} 处${note}`);
  const worst = bad.reduce((a, b) => (b.ratio < a.ratio ? b : a));
  return fail('contrast-ok', `${bad.length}/${measured} 处正文对比度不足 4.5:1，最低 ${worst.ratio.toFixed(2)}（${worst.selector}）${note}`);
}

export function focusVisibleOk(page) {
  const focusables = (page.interactive ?? []).filter((el) => el.focusable !== false);
  if (!focusables.length) return skip('focus-visible-ok', '没有可聚焦元素可查');

  // hasVisibleFocus === null 表示探针没跑或 Tab 没走到：不许冒充看过焦点环
  const measured = focusables.filter((el) => el.hasVisibleFocus === true || el.hasVisibleFocus === false);
  if (!measured.length) return skip('focus-visible-ok', `未做焦点探测（${focusables.length} 个可聚焦元素待真实键盘事件）`);
  if (measured.length < focusables.length) {
    return skip('focus-visible-ok', `焦点探测只覆盖 ${measured.length}/${focusables.length} 个，判不了`);
  }

  const dark = measured.filter((el) => el.hasVisibleFocus === false);
  if (!dark.length) return pass('focus-visible-ok', `已核 ${measured.length} 个`);
  return fail('focus-visible-ok', `${dark.length} 个可聚焦元素聚焦时看不出变化：${list(dark)}`);
}

// "遮挡"的定义：贴容器底边、且横向覆盖够宽的一条。
// 浮在滚动区中间的 toast、56px 的圆形 FAB、未读气泡都不藏内容，判红就是假红。
function isBottomBar(bar, containerRect) {
  const touchesBottom = bar.y + bar.h >= containerRect.y + containerRect.h - 1 && bar.y < containerRect.y + containerRect.h;
  const wideEnough = bar.w >= containerRect.w * BAR_MIN_WIDTH_RATIO;
  return touchesBottom && wideEnough;
}

export function bottomNotCovered(page) {
  const containers = (page.scrollContainers ?? []).map((c) => ({ selector: c.selector, rect: box(c.rect) })).filter((c) => c.rect.w > 0 && c.rect.h > 0);
  const bars = (page.fixedRects ?? [])
    .map((f) => ({ selector: f.selector, inside: f.inside, rect: box(f?.rect ?? f) }))
    .filter((f) => f.rect.w > 0 && f.rect.h > 0);
  if (!bars.length || !containers.length) return skip('bottom-not-covered', '缺少固定条或滚动容器，未判');

  const hit = [];
  for (const c of containers) {
    for (const f of bars) {
      if (f.inside && f.inside === c.selector) continue; // 容器自己的 sticky 子元素（日期分隔条）不算遮挡
      if (!isBottomBar(f.rect, c.rect)) continue;
      if (overlaps(c.rect, f.rect)) hit.push(f.selector ?? c.selector);
    }
  }
  if (!hit.length) return pass('bottom-not-covered', `已核 ${bars.length} 个固定元素`);
  return fail('bottom-not-covered', `滚动区域被贴底的固定条压住：${[...new Set(hit)].join('、')}`);
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
