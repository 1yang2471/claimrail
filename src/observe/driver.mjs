// 唯一碰浏览器的地方，刻意做薄：判定在 geometry、合并逻辑在 focus、采集在 web，
// 那三层都已有测试。驱动只负责把页面开起来、把真实键盘事件发出去。

import { createHash } from 'node:crypto';

let cached;

export async function loadPlaywright() {
  if (cached) return cached;
  try {
    cached = await import('playwright');
    return cached;
  } catch {
    throw new Error(
      '视觉档证据需要 Playwright：npm i -D playwright && npx playwright install chromium\n（repo / memory 两档证据不依赖它，协议其余部分照常可用）',
    );
  }
}

// 采集器与焦点探针必须共用同一个 selector 函数，否则 Tab 探到的元素
// 会因为两边算法不同而被判成"没探到"。所以它注入页面，而不是各写一份。
//
// 浏览器侧的助手都挂在这里：selector、样式签名、色值换算。判定层仍然是纯的。
//
// sel 必须带兄弟序号：同 class 的兄弟气泡（聊天页一屏全是 .bubble）如果算出同一个
// 字符串，focusSamples 的 Map 会互相覆盖——第一个探到、第二个跟着被判"焦点可见"，
// 那是纯假绿；tabSamples 也会因为重名提前 break，少探一整片。
export function installHelpers() {
  const sel = (el) => {
    if (el.id) return `#${el.id}`;
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : '';
    const parent = el.parentElement ? sel(el.parentElement) : '';
    const tag = el.tagName.toLowerCase() + cls;
    const same = el.parentElement ? [...el.parentElement.children].filter((c) => c.tagName === el.tagName && selName(c) === tag) : [];
    const nth = same.length > 1 ? `:nth(${same.indexOf(el) + 1})` : '';
    return `${parent}>${tag}${nth}`;
  };
  const selName = (el) => {
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : '';
    return el.tagName.toLowerCase() + cls;
  };
  const styleSig = (el) => {
    const cs = getComputedStyle(el);
    // 按"能不能被看见"归一化，不是按"属性字符串变没变"。
    // outline-style: none 时 Chrome 聚焦仍会改 outline-color，那是看不见的变化——
    // 拼进签名就会把 a{outline:none} 这种最典型的缺陷判成"焦点可见"（实测假绿）。
    const outline =
      cs.outlineStyle === 'none' || parseFloat(cs.outlineWidth) === 0
        ? 'no-outline'
        : `${cs.outlineStyle}/${cs.outlineWidth}/${cs.outlineColor}/${cs.outlineOffset}`;
    const shadow = cs.boxShadow === 'none' ? 'no-shadow' : cs.boxShadow;
    const transform = cs.transform === 'none' ? 'no-transform' : cs.transform;
    return [outline, shadow, transform, cs.backgroundColor, cs.borderColor, cs.textDecorationLine].join('|');
  };
  const scrollOwner = (el) => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(n).overflowY)) return sel(n);
    }
    return null;
  };

  // 色值换算。真站实测（2026-11-08，iana.org/help/example-domains）：一页 49 处文本里
  // 40 处的文字色是 oklch()，判定层的老语法解析器不认识，整处漏判。
  //
  // 换算必须问浏览器本人，而且是问像素：实测 fillStyle 与注册的 <color> 属性都会把
  // oklch()/lab()/color() 原样回显（Chrome 保留色空间），只有真画一个像素再读回来
  // 才拿得到 sRGB。这样 color-mix()、相对颜色这些新写法也一并跟上，且不用我们抄一份
  // 色彩科学（抄错比不做更糟）。
  //
  // 老语法仍走精确解析：过一遍 8 位像素会把半透明量化到 1/255，实测能让同一处的
  // 对比度比值漂 0.047（rgba(10,20,30,.5)：3.483 → 3.529），够贴近阈值时翻转判定。
  const legacy = (css) => {
    const s = String(css).trim().toLowerCase();
    if (s === 'transparent') return { rgb: [0, 0, 0], a: 0 };
    const m = /^rgba?\(([^)]+)\)$/.exec(s);
    if (!m || m[1].includes('%')) return null; // 百分号色值不硬算，交给下面的像素
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (p.length < 3 || p.slice(0, 3).some(Number.isNaN)) return null;
    return { rgb: p.slice(0, 3), a: p.length >= 4 ? p[3] : 1 };
  };
  const cache = new Map();
  let canvas = null;
  const rgbaOf = (css) => {
    const key = String(css);
    if (cache.has(key)) return cache.get(key);
    const out = legacy(key) ?? fromPixel(key);
    cache.set(key, out);
    return out;
  };
  const fromPixel = (css) => {
    // 无效值 canvas 不抛错，只是保留上一次的颜色（实测会因此报出 rgb(0,0,0) 这种
    // 凭空造出来的色值），所以先问支持性。null/undefined 问进去也只是 false，不会抛。
    if (!CSS.supports('color', css)) return null;
    const cv = (canvas ??= document.createElement('canvas'));
    cv.width = 1;
    cv.height = 1;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return { rgb: [d[0], d[1], d[2]], a: d[3] / 255 };
  };

  window.__fk = { sel, styleSig, scrollOwner, rgbaOf };
}

// 真实键盘 Tab 走一圈：这是 :focus-visible 唯一会被触发的路径。
// 回到已走过的元素就停——再走下去只是在原地打转。
export async function tabSamples(page, maxTabs = 40) {
  const seen = [];
  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press('Tab');
    const sample = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;
      return { selector: window.__fk.sel(el), style: window.__fk.styleSig(el) };
    });
    if (!sample) break;
    if (seen.some((s) => s.selector === sample.selector)) break;
    seen.push(sample);
  }
  return seen;
}

export async function launchBrowser() {
  const { chromium } = await loadPlaywright();
  return chromium.launch();
}

export const parseViewports = (spec) => String(spec).split(/[,;\s]+/).filter(Boolean);

// 一个视口一个 context。多视口不是可选：覆盖式条带压内容这类缺陷只在窄屏出现，
// 只跑 1280 宽会一路判绿。
export async function openPage(browser, { url, state, viewport = '1280x800', timeoutMs = 20000, tabMax = 40 } = {}) {
  const [width, height] = String(viewport).split(/[x×]/).map(Number);
  if (!(width > 0 && height > 0)) throw new Error(`viewport 需要形如 1280x800，收到 "${viewport}"`);

  const context = await browser.newContext({ viewport: { width, height }, ...(state ? { storageState: state } : {}) });
  try {
    await context.addInitScript(installHelpers);
    const page = await context.newPage();
    // 真实站点上"等页面静默"两条路都会失败：实测 saucedemo.com 挂着永不完成的遥测
    // fetch（events.backtrace.io），networkidle 永远不到；它的登录页连 load 都等不到
    // （有资源一直不返回）。这两种情况下工具曾经整页跑不起来 = 对该站点全盲。
    // 所以只有"文档解析完"是可信信号，样式/图片与 SPA 渲染都尽力等一会儿，等不到就按
    // 当前 DOM 采集，不抛错。超时预算按 timeoutMs 缩放，免得慢站把整轮拖太久。
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const settle = Math.min(timeoutMs, 5000);
    await page.waitForLoadState('load', { timeout: settle }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: settle }).catch(() => {});
    // 探针以回调交出：调用方必须先采未聚焦基线、再走 Tab。顺序反了（曾经就是这样）
    // 会让基线带着焦点，焦点检查于是永远判绿。
    return { page, context, viewport: `${width}x${height}`, focusProbe: () => tabSamples(page, tabMax) };
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  }
}

// 名字必须带 URL 指纹。曾经只取末段：/chat、/chat/、/chat.html 以及不同目录下的同名
// index.html 全收敛成同一个文件名——多页跑一次就互相覆盖，前一份证据被后一份偷换。
// 这不是洁癖问题：覆盖掉的报告仍然能被台账引用。
export const nameFromUrl = (url) => {
  const tail = String(url).split(/[?#]/)[0].split(/[\\/]/).filter(Boolean).pop() ?? 'page';
  const slug = tail.replace(/\.[a-z0-9]+$/i, '').replace(/[^-\w]/g, '_') || 'page';
  const digest = createHash('sha1').update(String(url)).digest('base64url').slice(0, 8);
  return `${slug}-${digest}`;
};
