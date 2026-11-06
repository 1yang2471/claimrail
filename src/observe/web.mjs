import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { runChecks } from './geometry.mjs';

// 在页面里执行，只采数不判断。某一类元素没采到就少给一类数据，
// 判定层会返回 null（不作数）——采集失败永远不能变成绿。
//
// 已知降级：hasVisibleFocus 一律 null。程序化 focus() 不保证触发 :focus-visible，
// 用它判断会产生假红；真实键盘事件要等驱动层（CDP Input.dispatchKeyEvent）接上再补。
export function collectInPage() {
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const sel = (el) => {
    if (el.id) return `#${el.id}`;
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : '';
    const parent = el.parentElement ? sel(el.parentElement) : '';
    return `${parent}>${el.tagName.toLowerCase()}${cls}`;
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
      if (parts.length >= 4 && Number(parts[3]) === 0) continue;
      if (parts.length >= 3 && Number(parts[0]) + Number(parts[1]) + Number(parts[2]) >= 0) return c;
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

    if (s.position === 'fixed' || s.position === 'sticky') fixedRects.push({ selector: sel(el), rect: r });
    if (!/(auto|scroll)/.test(s.overflowY)) continue;

    const last = el.lastElementChild && shown(el.lastElementChild) ? el.lastElementChild : null;
    scrollContainers.push({
      selector: sel(el),
      rect: r,
      scrollableY: el.scrollHeight > el.clientHeight + 1,
      reservedX: Math.round(el.offsetWidth - el.clientWidth),
      lastChildRect: last ? box(last) : null,
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
    interactive.push({ selector: sel(el), rect: r, focusable, hasVisibleFocus: null });
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
export async function renderPage(page, { outDir, name, label = '' } = {}) {
  await mkdir(outDir, { recursive: true });
  const data = await page.evaluate(collectInPage);
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
    },
    checks: runChecks(data),
  };
  await writeFile(join(outDir, `${name}.report.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}
