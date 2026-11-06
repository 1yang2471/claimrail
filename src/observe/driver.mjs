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
  window.__fk = { sel, styleSig, scrollOwner };
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
    await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
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
