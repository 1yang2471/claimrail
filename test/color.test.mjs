import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { launchBrowser, openPage } from '../src/observe/driver.mjs';
import { renderPage } from '../src/observe/web.mjs';
import { playwrightBroken } from './helpers.mjs';

// 真 Chromium 层的色值换算切片。单独一个文件是因为 browser.test.mjs 已经贴着
// pre-commit 的大小上限；拆文件而不是抬阈值。
// 没装 Playwright 时整文件 skip，不伪绿。

let chromiumOk = true;
try {
  await import('playwright');
} catch {
  chromiumOk = false;
}

const withBrowser = async (fn) => {
  if (!chromiumOk) return;
  const browser = await launchBrowser();
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
};

// 真站实测（2026-11-08，iana.org/help/example-domains）：49 处文本里 40 处的文字色是
// oklch()，parseRgba 不认识 → 整处漏判。而漏判在报告里长得跟"没问题"几乎一样，
// 所以这既是覆盖率问题也是诚实问题：一页真实的浅色文字缺陷被漏掉了。
//
// 换算必须问浏览器本人：实测 fillStyle 与注册 <color> 属性都会把 oklch()/lab() 原样
// 回显（Chrome 保留色空间），只有真画一个像素再读回来才拿得到 sRGB。
test('oklch() 的文字色与底色都要判得上，不许整处漏判', async (t) => {
  if (!chromiumOk) return t.skip('没装 Playwright，跳过真浏览器层');
  const dir = await mkdtemp(join(tmpdir(), 'cr-oklch-'));
  try {
    await withBrowser(async (browser) => {
      const session = await openPage(browser, { url: 'about:blank', viewport: '400x300' });
      await session.page.setContent(
        '<body style="margin:0;font:16px/2 system-ui;background:#fff">' +
          '<p style="margin:20px;color:oklch(0.85 0 0)">oklch 浅灰字压在纯白底上</p>' +
          '<div style="margin:20px;padding:20px;background:oklch(0.98 0.005 250)">' +
          '<p style="color:#1f2937">深字压在 oklch 浅底上</p></div></body>',
      );
      const report = await renderPage(session.page, { outDir: dir, name: 'oklch' });
      await session.context.close();

      // 底色的解析走 CSS，不该退到像素兜底：像素只补背景，补不了文字色
      assert.equal(report.pixelBackgrounds.filled, 0, '底色应当由 CSS 采到，不该靠像素兜底');
      const c = report.checks.find((x) => x.id === 'contrast-ok');
      assert.doesNotMatch(c.detail, /采不到|未判/, `oklch 色值仍被漏判：${c.detail}`);
      assert.equal(c.ok, false, `oklch 浅灰字压白底应当判红，实得 ${c.ok}：${c.detail}`);
      assert.match(c.detail, /1\/2 处正文对比度不足/, c.detail);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 换算是"采不到"的唯一替代品，不能变成"猜"。把 oklch 这一支按回旧行为（返回 null），
// 底色就必须整处不判——跳过认不出的那层去拿祖先的颜色，是把"没看到"伪装成"看到了"。
test('认不出的底色判"未判"，不许拿祖先的颜色冒充', async (t) => {
  if (!chromiumOk) return t.skip('没装 Playwright，跳过真浏览器层');
  await withBrowser(async (browser) => {
    const session = await openPage(browser, { url: 'about:blank', viewport: '400x300' });
    await session.page.setContent(
      '<body style="margin:0;font:16px/2 system-ui;background:#fff">' +
        '<div style="background:oklch(0.2 0.1 250);padding:20px">' +
        '<p style="color:#1f2937">底色认不出来的一处</p></div></body>',
    );
    await session.page.evaluate(() => {
      const real = window.__fk.rgbaOf;
      window.__fk.rgbaOf = (css) => (String(css).includes('oklch') ? null : real(css));
    });
    const { collectInPage } = await import('../src/observe/web.mjs');
    const data = await session.page.evaluate(collectInPage);
    await session.context.close();

    const text = data.texts.find((x) => String(x.selector).includes('p'));
    assert.ok(text, '没采到那一处文本');
    assert.equal(text.background, null, `拿祖先的颜色冒充了底色：${text.background}`);
  });
});

// 换算的契约。老语法必须逐位精确（半透明 alpha 不能因为过一遍 8 位像素而漂），
// 现代色空间交给浏览器本人（我们不复算，也就不会算错），认不出的老实返回 null。
test('色值换算契约：老语法精确、现代色空间走浏览器、认不出的返回 null', async (t) => {
  if (!chromiumOk) return t.skip('没装 Playwright，跳过真浏览器层');
  await withBrowser(async (browser) => {
    const session = await openPage(browser, { url: 'about:blank', viewport: '400x300' });
    const got = await session.page.evaluate(() => {
      const f = window.__fk.rgbaOf;
      return {
        hex: f('#010203'),
        legacy: f('rgb(240, 240, 240)'),
        semi: f('rgba(10, 20, 30, 0.5)'),
        pct: f('rgb(100% 0% 0%)'),
        oklch: f('oklch(0.371 0 0)'),
        p3: f('color(display-p3 0 1 0)'),
        mixed: f('color-mix(in oklch, red, blue)'),
        alpha: f('oklch(0.371 0 0 / 50%)'),
        none: f('transparent'),
        bogus: f('不是颜色'),
        empty: f(''),
      };
    });
    await session.context.close();

    assert.deepEqual(got.hex, { rgb: [1, 2, 3], a: 1 });
    assert.deepEqual(got.legacy, { rgb: [240, 240, 240], a: 1 });
    assert.deepEqual(got.semi, { rgb: [10, 20, 30], a: 0.5 });
    assert.deepEqual(got.pct, { rgb: [255, 0, 0], a: 1 });
    assert.deepEqual(got.p3, { rgb: [0, 255, 0], a: 1 });
    assert.equal(got.none.a, 0, JSON.stringify(got.none));
    assert.equal(got.bogus, null);
    assert.equal(got.empty, null);
    // oklch 的 sRGB 值由浏览器算，我们不抄一份：只钉"是灰阶且落在该落的地方"、alpha 保住了
    assert.ok(got.oklch && got.oklch.a === 1 && got.oklch.rgb.every((v) => Math.abs(v - 64) <= 2), JSON.stringify(got.oklch));
    assert.ok(Math.abs(got.alpha.a - 0.5) < 0.01, JSON.stringify(got.alpha));
    assert.ok(got.mixed && got.mixed.rgb[0] > 150 && got.mixed.rgb[2] > 150, JSON.stringify(got.mixed));
  });
});

// 装了 playwright 却 import 不进来 = 坏安装，不是"这台机器没装"。
// 这种情况下整层静默跳过、整套测试全绿——那是假绿，必须响。
test('浏览器层不许因为坏安装而整层静默跳过', (t) => {
  if (playwrightBroken) t.fail('node_modules 里装着 playwright，却 import 不进来：这是坏安装，整层跳过会变成假绿');
});
