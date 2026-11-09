import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { runChecks } from './geometry.mjs';
import { applyFocusProbe } from './focus.mjs';
import { decodePng } from './png.mjs';
import { applyPixelBackgrounds } from './pixel.mjs';

// 在页面里执行，只采数不判断。某一类元素没采到就少给一类数据，
// 判定层会返回 null（不作数）——采集失败永远不能变成绿。
//
// 选择器与样式签名由驱动层通过 addInitScript 注入的 window.__fk 提供，
// 采集器和焦点探针必须用同一个函数，否则两边算出的 selector 对不上、
// Tab 探到的元素会被当成"没探到"。缺注入就直接抛错，不做静默兜底。
export function collectInPage() {
  const fk = window.__fk;
  if (!fk) throw new Error('未注入 __fk 辅助函数：请经 claimrail web（驱动层 addInitScript）打开页面');
  const sel = fk.sel;
  const scrollOwner = fk.scrollOwner;

  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const shown = (el) => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) !== 0;
  };
  // 背景要按层合成，不能只取第一个非透明值。
  // 真站实测教训：`code` 用 rgba(0,0,0,.05) 铺在灰底上，旧实现把 5% 透明当成纯黑，
  // 于是 103 处文本里 76 处报对比度不足，最低 1.53——全是假红。
  // 另外两条纪律：碰到 background-image/渐变就返回 null（图片无法采样），
  // 最底层仍半透明也返回 null（真实背景未知，不许兜底成白色）。
  // 第三堂课的教训（2026-11-08，iana.org）：认不出的色值必须整处不判。
  // 旧实现在这里 continue 掉认不出的那层，于是拿祖先的颜色当成了这一层的底色——
  // 把"没看到"伪装成"看到了"。
  const bgOf = (el) => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
      const c = fk.rgbaOf(cs.backgroundColor);
      if (!c) return null;
      if (c.a === 0) continue;
      layers.push(c);
      if (c.a === 1) break; // 已经不透明，下面再有什么都看不见
    }
    if (!layers.length) return null;
    const bottom = layers[layers.length - 1];
    if (bottom.a < 1) return null;

    let acc = bottom.rgb;
    for (let i = layers.length - 2; i >= 0; i--) {
      const L = layers[i];
      acc = [0, 1, 2].map((k) => Math.round(L.a * L.rgb[k] + (1 - L.a) * acc[k]));
    }
    return `rgb(${acc[0]}, ${acc[1]}, ${acc[2]})`;
  };

  // 交给判定层的色值统一是老语法（唯一可能判不了的是 null = 认不出来）。
  // 文字色以前是原样透传的，所以文字色写成 oklch() 时判定层的老语法解析器就整处漏判。
  const legacyCss = (c) => (c ? (c.a < 1 ? `rgba(${c.rgb.join(', ')}, ${c.a})` : `rgb(${c.rgb.join(', ')})`) : null);

  const scrollContainers = [];
  const fixedRects = [];
  let containerTotal = 0;
  let fixedTotal = 0;
  for (const el of document.querySelectorAll('*')) {
    if (!shown(el)) continue;
    const s = getComputedStyle(el);
    const r = box(el);
    if (r.w <= 0 || r.h <= 0) continue;

    if (s.position === 'fixed' || s.position === 'sticky') {
      fixedTotal += 1;
      // inside 记录它归属的滚动容器：容器自己的 sticky 子元素（日期分隔条那种）
      // 必然与容器矩形重叠，不标出来就会被当成"内容被固定条盖住"的假红。
      fixedRects.push({ selector: sel(el), rect: r, inside: scrollOwner(el) });
    }
    if (!/(auto|scroll)/.test(s.overflowY)) continue;

    containerTotal += 1;
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
  let textTotal = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (!node.nodeValue || !node.nodeValue.trim()) continue;
    const parent = node.parentElement;
    if (!parent || !shown(parent)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const s = getComputedStyle(parent);
    const fs = parseFloat(s.fontSize) || 16;
    const owner = scrollOwner(parent);
    for (const r of range.getClientRects()) {
      if (r.width < 2 || r.height < 2) continue;
      textTotal += 1;
      if (texts.length >= 400) continue; // 只计数不收录：截断要能被判定层看见
      texts.push({
        selector: sel(parent),
        container: owner,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        color: legacyCss(fk.rgbaOf(s.color)),
        background: bgOf(parent),
        fontSize: fs,
        bold: Number(s.fontWeight) >= 600,
      });
    }
  }

  let interactiveTotal = 0;
  const interactive = [];
  for (const el of document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"],[tabindex]')) {
    if (!shown(el)) continue;
    const r = box(el);
    if (r.w <= 0 || r.h <= 0) continue;
    const s = getComputedStyle(el);
    const focusable = !el.disabled && el.tabIndex >= 0 && el.getAttribute('aria-hidden') !== 'true';
    // 行内文字链接不是控件。44px 是给按钮/输入框的标准，套在正文链接上会一次性
    // 造出十几个假红（真站上那 16 处里就有语言切换和正文链接）
    const inline = /^(inline|contents)/.test(s.display) && !['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(el.tagName);
    interactiveTotal += 1;
    if (interactive.length >= 120) continue;
    interactive.push({ selector: sel(el), rect: r, focusable, inline, baseStyle: fk.styleSig(el), hasVisibleFocus: null });
  }

  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    // raw 是截断前的总数。判定层遇到 raw > 实际条数时改判"不作数"而不是"全绿"，
    // 否则第 401 条被滚动条压住的文本会因为 cap 而永远查不到。
    raw: {
      scrollContainers: containerTotal,
      texts: textTotal,
      interactive: interactiveTotal,
      fixedRects: fixedTotal,
    },
    scrollContainers: scrollContainers.slice(0, 60),
    texts,
    interactive,
    fixedRects: fixedRects.slice(0, 40),
  };
}

export const reportPathFor = (pngRef) => String(pngRef).replace(/\.png$/, '.report.json');

// page 只需 evaluate()/screenshot() 两个方法，所以驱动可以是 Playwright、
// 也可以是裸 CDP，而这一层仍然能用手写的假页面测。
//
// focusProbe 是回调而不是现成数据：必须先采到未聚焦基线样式，再走 Tab。
// 顺序反过来（曾经就是反的）会让基线带着焦点，焦点检查一路判绿。
export async function renderPage(page, { outDir, name, label = '', focusProbe = null, focusSamples = null, pixel = true } = {}) {
  await mkdir(outDir, { recursive: true });
  const data = await page.evaluate(collectInPage);
  const png = join(outDir, `${name}.png`);
  // 截图必须在焦点探测之前：Tab 会滚动页面（实测一次真站 0→911→1532），
  // 探测之后拍，像素采样拿"滚动前"的坐标去读"滚动后"的截图，颜色对不上号
  // ——假绿假红都可能，报告还标 backgroundFrom:'pixel'。
  await page.screenshot({ path: png });
  const samples = focusProbe ? await focusProbe() : focusSamples;
  const interactive = samples ? applyFocusProbe(data.interactive, samples) : data.interactive;

  // 把截图本体读一次：既用来算"这一份报告测的是哪张图"的哈希，也用来做像素采样。
  // 哈希是落盘链的最后一环——以前只靠文件名与 mtime，换一张图或换一份报告都能混过去。
  let shotBuf = null;
  try {
    shotBuf = await readFile(png);
  } catch {
    shotBuf = null; // 读不出来就交 null：报告声明"没绑上"，回验时会被拒
  }
  const shotSha256 = shotBuf ? createHash('sha256').update(shotBuf).digest('hex') : null;

  // 对比度在渐变/图片背景上 CSS 采不到色值。截图已经落地，就顺手读像素把那一类补上——
  // 补不上的仍然留 null（未判），绝不猜。采样本身失败（截图解不了）也只是退回原样。
  let texts = data.texts;
  let pixelFill = null;
  if (pixel && data.texts?.length && shotBuf) {
    try {
      const img = decodePng(shotBuf);
      const r = applyPixelBackgrounds({ ...data, texts }, img);
      texts = r.texts;
      pixelFill = { filled: r.filled, inkSuspected: r.inkSuspected, total: r.total };
    } catch (err) {
      pixelFill = { error: err.message };
    }
  }

  // 这一轮"没覆盖到哪里"要说在明面上（调研自 craft-anything 的 evidence record 带
  // limitations）。不写的话，读者只能从每项 detail 里自己拼，或者干脆当成全查过了。
  const limitations = [];
  const raw = data.raw ?? {};
  const trunc = (key, label) => {
    const got = { scrollContainers: data.scrollContainers.length, texts: data.texts.length, interactive: data.interactive.length, fixedRects: data.fixedRects.length }[key];
    if (typeof raw[key] === 'number' && raw[key] > got) limitations.push(`${label}采集被截断（${raw[key]} > ${got}），超出部分未判`);
  };
  trunc('texts', '文本');
  trunc('interactive', '可交互元素');
  trunc('scrollContainers', '滚动容器');
  trunc('fixedRects', '固定元素');
  const noBg = texts.filter((t) => !t.background).length;
  if (noBg) limitations.push(`${noBg} 处文本没有可判定的底色，对比度未判`);
  if (pixelFill?.inkSuspected) limitations.push(`${pixelFill.inkSuspected} 处像素采样疑似压到字形，退回未判`);
  if (pixelFill?.error) limitations.push(`像素采样失败（${pixelFill.error}），图片/渐变背景未补`);
  if (!pixel) limitations.push('像素采样被关闭（--no-pixel），渐变/图片背景未补');
  if (!samples) limitations.push('焦点探测没跑（没有真实键盘事件），focus-visible 未判');
  else if (samples.length < data.interactive.filter((el) => el.focusable !== false).length) {
    limitations.push(`焦点探测只覆盖 ${samples.length} 个元素，其余未判`);
  }

  const report = {
    report_schema: 1,
    name,
    label,
    // 这份报告测的是哪张图。回验时重算截图哈希对比，换图/换报告都过不去。
    shot_sha256: shotSha256,
    viewport: data.viewport,
    counts: {
      scrollContainers: data.scrollContainers.length,
      texts: data.texts.length,
      interactive: data.interactive.length,
      fixedRects: data.fixedRects.length,
      focusProbed: samples ? samples.length : 0,
      ...(data.raw ?? {}),
    },
    ...(pixelFill ? { pixelBackgrounds: pixelFill } : {}),
    limitations,
    checks: runChecks({ ...data, texts, interactive }),
  };
  await writeFile(join(outDir, `${name}.report.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}
