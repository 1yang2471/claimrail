// 唯一碰浏览器的地方，刻意做薄：判定在 geometry、合并逻辑在 focus、采集在 web，
// 那三层都已有测试。驱动只负责把页面开起来、把真实键盘事件发出去。

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
export function installHelpers() {
  const sel = (el) => {
    if (el.id) return `#${el.id}`;
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : '';
    const parent = el.parentElement ? sel(el.parentElement) : '';
    return `${parent}>${el.tagName.toLowerCase()}${cls}`;
  };
  const styleSig = (el) => {
    const cs = getComputedStyle(el);
    return [cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.boxShadow, cs.backgroundColor, cs.borderColor, cs.textDecorationLine].join('|');
  };
  window.__fk = { sel, styleSig };
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
    const focusSamples = await tabSamples(page, tabMax);
    return { page, focusSamples, context, viewport: `${width}x${height}` };
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  }
}

export const nameFromUrl = (url) => {
  const tail = String(url).split(/[?#]/)[0].split(/[\\/]/).filter(Boolean).pop() ?? 'page';
  return tail.replace(/\.[a-z0-9]+$/i, '').replace(/[^-\w]/g, '_') || 'page';
};
