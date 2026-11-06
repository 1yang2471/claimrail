import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { runChecks } from './geometry.mjs';
import { applyFocusProbe } from './focus.mjs';

// 在页面里执行，只采数不判断。某一类元素没采到就少给一类数据，
// 判定层会返回 null（不作数）——采集失败永远不能变成绿。
//
// 选择器与样式签名由驱动层通过 addInitScript 注入的 window.__fk 提供，
// 采集器和焦点探针必须用同一个函数，否则两边算出的 selector 对不上、
// Tab 探到的元素会被当成"没探到"。缺注入就直接抛错，不做静默兜底。
export function collectInPage() {
  const fk = window.__fk;
  if (!fk) throw new Error('未注入 __fk 辅助函数：请经 forklight web（驱动层 addInitScript）打开页面');
  const sel = fk.sel;

  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const shown = (el) => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) !== 0;
  };
  const bgOf = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) continue;
      const parts = m[1].split(/[,\s/]+/).filter(Boolean);
      if (parts.length >= 4 && Number(parts[3]) === 0) continue; // 全透明层不算背景
      return c;
    }
    return 'rgb(255, 255, 255)';
  };
  const cap = (list, n) => (list.length > n ? list.slice(0, n) : list);

  const scrollContainers = [];
  const fixedRects = [];
  for (const el of document.querySelectorAll('*')) {
    if (!shown(el)) continue;
    const s = getComputedStyle(el);
    const r = box(el);
    if (r.w <= 0 || r.h <= 0) continue;

    if (s.position === 'fixed' || s.position === 'sticky') {
      // inside 记录它归属的滚动容器：容器自己的 sticky 子元素（日期分隔条那种）
      // 必然与容器矩形重叠，不标出来就会被当成"内容被固定条盖住"的假红。
      let host = null;
      for (let n = el.parentElement; n && !host; n = n.parentElement) {
        if (/(auto|scroll)/.test(getComputedStyle(n).overflowY)) host = sel(n);
      }
      fixedRects.push({ selector: sel(el), rect: r, inside: host });
    }
    if (!/(auto|scroll)/.test(s.overflowY)) continue;

    scrollContainers.push({
      selector: sel(el),
      rect: r,
      scrollableY: el.scrollHeight > el.clientHeight + 1,
      reservedX: Math.round(el.offsetWidth - el.clientWidth),
      scrollbarStyle: s.scrollbarWidth,
      gutter: s.scrollbarGutter,
    });
  }

  const texts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode()) && texts.length < 400) {
    if (!node.nodeValue || !node.nodeValue.trim()) continue;
    const parent = node.parentElement;
    if (!parent || !shown(parent)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const s = getComputedStyle(parent);
    const fs = parseFloat(s.fontSize) || 16;
    for (const r of range.getClientRects()) {
      if (r.width < 2 || r.height < 2) continue;
      texts.push({
        selector: sel(parent),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        color: s.color,
        background: bgOf(parent),
        fontSize: fs,
        bold: Number(s.fontWeight) >= 600,
      });
    }
  }

  const interactive = [];
  for (const el of document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"],[tabindex]')) {
    if (!shown(el)) continue;
    const r = box(el);
    if (r.w <= 0 || r.h <= 0) continue;
    const focusable = !el.disabled && el.tabIndex >= 0 && el.getAttribute('aria-hidden') !== 'true';
    interactive.push({ selector: sel(el), rect: r, focusable, baseStyle: fk.styleSig(el), hasVisibleFocus: null });
  }

  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    scrollContainers: cap(scrollContainers, 60),
    texts,
    interactive: cap(interactive, 120),
    fixedRects: cap(fixedRects, 40),
  };
}

export const reportPathFor = (pngRef) => String(pngRef).replace(/\.png$/, '.report.json');

// page 只需 evaluate()/screenshot() 两个方法，所以驱动可以是 Playwright、
// 也可以是裸 CDP，而这一层仍然能用手写的假页面测。
export async function renderPage(page, { outDir, name, label = '', focusSamples = null } = {}) {
  await mkdir(outDir, { recursive: true });
  const data = await page.evaluate(collectInPage);
  const interactive = focusSamples ? applyFocusProbe(data.interactive, focusSamples) : data.interactive;
  const png = join(outDir, `${name}.png`);
  await page.screenshot({ path: png });

  const report = {
    name,
    label,
    viewport: data.viewport,
    counts: {
      scrollContainers: data.scrollContainers.length,
      texts: data.texts.length,
      interactive: data.interactive.length,
      fixedRects: data.fixedRects.length,
      focusProbed: focusSamples ? focusSamples.length : 0,
    },
    checks: runChecks({ ...data, interactive }),
  };
  await writeFile(join(outDir, `${name}.report.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}
