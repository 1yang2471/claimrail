import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { launchBrowser, openPage } from '../src/observe/driver.mjs';
import { renderPage } from '../src/observe/web.mjs';
import { verify } from '../src/evidence.mjs';

// 这一层是审查点名的结构性缺口：前面两百个测试都用假 page，
// collectInPage 里那一百多行 DOM 代码（selector、容器归属、截断计数、TreeWalker）
// 一行都没被执行过。Playwright 在就真跑，不在就整文件跳过——不许伪绿。

let chromiumOk = true;
try {
  await import('playwright');
} catch {
  chromiumOk = false;
}
const here = dirname(fileURLToPath(import.meta.url));
const page = (name) => pathToFileURL(join(here, 'fixtures', 'pages', `${name}.html`)).href;

const withBrowser = async (fn) => {
  if (!chromiumOk) return;
  const browser = await launchBrowser();
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
};

const shot = async (browser, url, viewport) => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-browser-'));
  try {
    const session = await openPage(browser, { url, viewport });
    const report = await renderPage(session.page, { outDir: dir, name: 'p', focusProbe: session.focusProbe });
    const onDisk = JSON.parse(await readFile(join(dir, 'p.report.json'), 'utf8'));
    return { report, onDisk, dir };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('真浏览器：坏页的动机缺陷被逐条点名', async (t) => {
  if (!chromiumOk) return t.skip('没装 Playwright，跳过真浏览器层');
  await withBrowser(async (browser) => {
    const { report } = await shot(browser, page('chat-bad'), '390x700');
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));

    assert.equal(byId['scrollbar-clears-text'].ok, false, byId['scrollbar-clears-text'].detail);
    assert.match(byId['scrollbar-clears-text'].detail, /压住 \d+ 处文本/);
    assert.equal(byId['bottom-not-covered'].ok, false, byId['bottom-not-covered'].detail);
    assert.equal(byId['touch-targets-ok'].ok, false, byId['touch-targets-ok'].detail);
    assert.equal(byId['contrast-ok'].ok, false, byId['contrast-ok'].detail);
    // 真实 Tab 走到的元素必须大于 0，否则焦点项就该是"不作数"而不是绿
    assert.ok(report.counts.focusProbed > 0, '焦点探针一个元素都没走到');
    assert.equal(byId['focus-visible-ok'].ok, false, byId['focus-visible-ok'].detail);
  });
});

test('真浏览器：selector 在同级同 class 的兄弟之间必须唯一', async (t) => {
  if (!chromiumOk) return t.skip('没装 Playwright');
  await withBrowser(async (browser) => {
    const { report } = await shot(browser, page('chat-bad'), '390x700');
    // 兄弟气泡很多，若 selector 碰撞，容器与文本的归属关系就会错乱
    const selectors = report.counts.texts;
    assert.ok(selectors > 10, `文本采集过少：${selectors}`);

    const probes = await (async () => {
      const session = await openPage(browser, { url: page('chat-bad'), viewport: '390x700' });
      try {
        return await session.focusProbe();
      } finally {
        await session.context.close();
      }
    })();
    assert.equal(new Set(probes.map((p) => p.selector)).size, probes.length, 'Tab 采样里出现重复 selector，说明兄弟元素撞名');
  });
});

test('真浏览器：文本带所属容器，容器归属必须能对上', async (t) => {
  if (!chromiumOk) return t.skip('没装 Playwright');
  await withBrowser(async (browser) => {
    const session = await openPage(browser, { url: page('chat-bad'), viewport: '390x700' });
    const { collectInPage } = await import('../src/observe/web.mjs');
    const data = await session.page.evaluate(collectInPage);
    await session.context.close();

    const owners = new Set(data.scrollContainers.map((c) => c.selector));
    const withOwner = data.texts.filter((x) => x.container);
    assert.ok(withOwner.length > 0, '没有任何文本带上容器归属');
    for (const t of withOwner) assert.ok(owners.has(t.container), `容器归属对不上：${t.container}`);
    assert.ok(data.raw.texts >= data.texts.length, 'raw 计数不得小于实际收录数');
  });
});

test('真浏览器：修好的页面不再报那四条红', async (t) => {
  if (!chromiumOk) return t.skip('没装 Playwright');
  await withBrowser(async (browser) => {
    const { report } = await shot(browser, page('chat-good'), '390x700');
    const reds = report.checks.filter((c) => c.ok === false).map((c) => `${c.id}: ${c.detail}`);
    assert.deepEqual(reds, [], '好页仍报红');
    assert.ok(report.checks.some((c) => c.id === 'bottom-not-covered' && c.ok === true), '好页的贴底条应判过为绿');
  });
});

test('真浏览器：报告能被 evidence 层当真凭实据认下来（好页），坏页认不下来', async (t) => {
  if (!chromiumOk) return t.skip('没装 Playwright');
  await withBrowser(async (browser) => {
    const mkdtemp = async () => (await import('node:fs/promises')).mkdtemp(join(tmpdir(), 'fk-ev-'));
    const { writeFile, stat } = await import('node:fs/promises');

    for (const [name, expectOk] of [
      ['chat-good', true],
      ['chat-bad', false],
    ]) {
      const dir = await mkdtemp();
      try {
        const session = await openPage(browser, { url: page(name), viewport: '390x700' });
        await renderPage(session.page, { outDir: dir, name: 'p', focusProbe: session.focusProbe });
        await session.context.close();

        const ids = ['scrollbar-clears-text', 'touch-targets-ok', 'contrast-ok', 'focus-visible-ok', 'bottom-not-covered'];
        const ctx = {
          lastChangeMs: 1,
          statFile: async () => ({ mtimeMs: (await stat(join(dir, 'p.png'))).mtimeMs }),
          readReport: async () => JSON.parse(await readFile(join(dir, 'p.report.json'), 'utf8')),
        };
        const r = await verify({ kind: 'render', ref: 'p.png', asserts: ids }, ctx);
        assert.equal(r.ok, expectOk, `${name}：${r.why}`);
        if (!expectOk) assert.match(r.why, /判红/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
});

test('真浏览器：viewport 参数错了要说清，不能悄悄按默认跑', async (t) => {
  if (!chromiumOk) return t.skip('没装 Playwright');
  await withBrowser(async (browser) => {
    await assert.rejects(() => openPage(browser, { url: page('chat-good'), viewport: '宽屏' }), /1280x800/);
  });
});
