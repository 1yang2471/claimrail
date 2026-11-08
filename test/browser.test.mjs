import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { launchBrowser, openPage } from '../src/observe/driver.mjs';
import { playwrightBroken } from './helpers.mjs';
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

// storageState（--state）的代码路径此前一次没实测过（HANDOFF 已知未修第 4 条）。
// 用本地 http server 验证注入真的发生：cookie 与 localStorage 都要出现在页面里。
// 页面没有登录门的项目（如 Shinsekai）不需要它，但需要它的项目不能再零覆盖。
test('真浏览器：--state 登录态把 cookie 与 localStorage 注入上下文', async (t) => {
  if (!chromiumOk) return t.skip('没装 Playwright，跳过真浏览器层');
  const { createServer } = await import('node:http');
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><html><body><main><h1>probe</h1><p id="probe">pending</p></main>' +
      '<script>document.getElementById("probe").textContent = "cookie=" + document.cookie + " ls=" + localStorage.getItem("fk-state-probe");</script>',
    );
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const dir = await mkdtemp(join(tmpdir(), 'fk-state-'));
  try {
    const state = {
      cookies: [{ name: 'fkprobe', value: 'from-state', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }],
      origins: [{ origin: `http://127.0.0.1:${srv.address().port}`, localStorage: [{ name: 'fk-state-probe', value: 'from-localstorage' }] }],
    };
    const statePath = join(dir, 'state.json');
    await (await import('node:fs/promises')).writeFile(statePath, JSON.stringify(state));
    await withBrowser(async (browser) => {
      const session = await openPage(browser, { url: `http://127.0.0.1:${srv.address().port}/`, state: statePath });
      const probe = await session.page.textContent('#probe');
      assert.match(probe, /cookie=.*fkprobe=from-state/, 'storageState 的 cookie 没进上下文');
      assert.match(probe, /ls=from-localstorage/, 'storageState 的 localStorage 没进上下文');
      await session.context.close();
    });
  } finally {
    srv.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// v2：渐变/图片背景上 CSS 采不到色值，旧实现整项"未判"（真站 104/111 处）。
// 现在读截图像素补上——但只补能确认的，采样不可信时仍留 null。
test('渐变背景：CSS 采不到底色时，靠截图像素判出对比度不足', async (t) => {
  if (!chromiumOk) return t.skip('没装 Playwright，跳过真浏览器层');
  const dir = await mkdtemp(join(tmpdir(), 'fk-pixel-'));
  try {
    await withBrowser(async (browser) => {
      const session = await openPage(browser, { url: 'about:blank', viewport: '400x200' });
      await session.page.setContent(
        '<body style="margin:0;background:linear-gradient(90deg,#ffffff,#f2f2f2)">' +
          '<p style="margin:40px;font:16px/2 system-ui;color:#c8c8c8">浅灰文字压在渐变上</p></body>',
      );
      const report = await renderPage(session.page, { outDir: dir, name: 'gradient' });
      await session.context.close();

      assert.ok(report.pixelBackgrounds, '报告里没有像素采样统计');
      assert.equal(report.pixelBackgrounds.filled, 1, '这一处应当靠像素补上');
      const c = report.checks.find((x) => x.id === 'contrast-ok');
      assert.equal(c.ok, false, `渐变上的浅灰字应当判红，实得 ${c.ok}：${c.detail}`);
      assert.match(c.detail, /不足 4\.5:1/);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('像素采样失败不制造假绿：截图解不了就退回未判', async (t) => {
  if (!chromiumOk) return t.skip('没装 Playwright，跳过真浏览器层');
  const dir = await mkdtemp(join(tmpdir(), 'fk-pixel-off-'));
  try {
    await withBrowser(async (browser) => {
      const session = await openPage(browser, { url: 'about:blank', viewport: '400x200' });
      await session.page.setContent(
        '<body style="margin:0;background:linear-gradient(90deg,#ffffff,#f2f2f2)">' +
          '<p style="margin:40px;font:16px/2 system-ui;color:#c8c8c8">浅灰文字压在渐变上</p></body>',
      );
      const report = await renderPage(session.page, { outDir: dir, name: 'gradient', pixel: false });
      await session.context.close();

      assert.equal(report.pixelBackgrounds, undefined, '关掉像素采样后不该有统计');
      const c = report.checks.find((x) => x.id === 'contrast-ok');
      assert.equal(c.ok, null, '采不到底色时必须判未判，不许当合格');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// v2 的核心主张：磨砂卡片 + 渐变背景上，CSS 只能判少数文本，像素能判全部。
// 这条同时钉住"覆盖率提升"和"提升之后抓到的是真缺陷"，而不只是"没报错"。
test('磨砂+渐变页：像素采样把覆盖率从少数拉到全部，并抓到真实的浅字', async (t) => {
  if (!chromiumOk) return t.skip('没装 Playwright，跳过真浏览器层');
  const { createServer } = await import('node:http');
  const html =
    '<!doctype html><html><head><style>' +
    'body{margin:0;font:16px/1.6 system-ui;background:linear-gradient(135deg,#e8f0ff,#fdf2f8 40%,#ecfdf5)}' +
    '.card{background:rgba(255,255,255,.55);backdrop-filter:blur(12px);padding:20px;margin:16px}' +
    '.card p{color:#4b5563}.card .dim{color:#9ca3af}' +
    '.solid{background:#fff;padding:20px;margin:16px}.solid p{color:#374151}' +
    '</style></head><body>' +
    '<div class="card"><p>正常对比度</p><p class="dim">偏浅的文字</p></div>' +
    '<div class="solid"><p>纯色卡片</p></div>' +
    '<div class="card"><p>渐变上的正文</p></div></body></html>';
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const dir = await mkdtemp(join(tmpdir(), 'cr-cov-'));
  try {
    await withBrowser(async (browser) => {
      const url = `http://127.0.0.1:${srv.address().port}/`;

      const off = await openPage(browser, { url, viewport: '1280x800' });
      const noPixel = await renderPage(off.page, { outDir: dir, name: 'off', pixel: false });
      await off.context.close();

      const on = await openPage(browser, { url, viewport: '1280x800' });
      const withPixel = await renderPage(on.page, { outDir: dir, name: 'on' });
      await on.context.close();

      const offDetail = noPixel.checks.find((c) => c.id === 'contrast-ok').detail;
      const onDetail = withPixel.checks.find((c) => c.id === 'contrast-ok').detail;

      // 关掉像素：有文本判不了（这正是不开 v2 时的假绿来源）
      assert.match(offDetail, /另有 \d+ 处未判（底色或色值采不到/, `关像素时应当有未判项，实得：${offDetail}`);
      // 开像素：全部判上，且补的处数等于刚才未判的处数
      assert.equal(withPixel.pixelBackgrounds.inkSuspected, 0);
      assert.ok(withPixel.pixelBackgrounds.filled >= 3, `补的处数太少：${JSON.stringify(withPixel.pixelBackgrounds)}`);
      assert.doesNotMatch(onDetail, /处未判（底色/, `开像素后仍有未判：${onDetail}`);
      // 补上之后必须抓到真实的浅字，而不是"全部合格"
      assert.match(onDetail, /对比度不足 4\.5:1/, `浅灰字没被抓到：${onDetail}`);
    });
  } finally {
    srv.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// 真实站点上 networkidle 可能永远不到：实测 saucedemo.com 挂着两个永不完成的遥测
// fetch（events.backtrace.io），一页完全正常的页面因此整页跑不起来——工具对这类站点
// 等于全盲。所以"等网络静默"只能尽力而为：文档落地了就继续采集。
test('真浏览器：有请求永不结束时也要出报告，不许整页跑不起来', async (t) => {
  if (!chromiumOk) return t.skip('没装 Playwright，跳过真浏览器层');
  const { createServer } = await import('node:http');
  const srv = createServer((req, res) => {
    if (req.url.startsWith('/beacon')) return; // 永不响应：模拟挂住的遥测
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><body><main><h1>正文落地了</h1>' +
        '<p style="color:#111">挂住的 beacon 不该拖垮整页</p></main>' +
        '<script>fetch("/beacon");</script></body>',
    );
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const dir = await mkdtemp(join(tmpdir(), 'cr-idle-'));
  try {
    await withBrowser(async (browser) => {
      const session = await openPage(browser, { url: `http://127.0.0.1:${srv.address().port}/`, viewport: '400x200', timeoutMs: 1500 });
      const report = await renderPage(session.page, { outDir: dir, name: 'idle' });
      await session.context.close();
      assert.ok(report.counts.texts >= 2, `正文没采到：${JSON.stringify(report.counts)}`);
    });
  } finally {
    srv.closeAllConnections?.();
    srv.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// 真实受保护页面的闭环：没有登录态被踢到 /login，带 --state 才能落到真实内容并采集。
// 之前只验证过"cookie/localStorage 注入进去了"，没验证"注入之后真的能看到受保护内容"。
test('受保护页面：无登录态被踢到登录页，--state 才拿到真实内容', async (t) => {
  if (!chromiumOk) return t.skip('没装 Playwright，跳过真浏览器层');
  const { createServer } = await import('node:http');
  // /login 本身永远可达——否则未登录访问 /dashboard 会无限重定向，那是夹具的 bug
  const srv = createServer((req, res) => {
    const authed = /session=ok/.test(req.headers.cookie || '');
    if (req.url.startsWith('/login')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><body><h1>请登录</h1><form><input><button>登录</button></form></body>');
    }
    if (!authed) {
      res.writeHead(302, { location: '/login' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><body><main><h1>私密仪表盘</h1><p>只有登录后才能看到的内容</p><button>导出</button></main></body>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const dir = await mkdtemp(join(tmpdir(), 'cr-login-'));
  try {
    const statePath = join(dir, 'state.json');
    await (await import('node:fs/promises')).writeFile(
      statePath,
      JSON.stringify({ cookies: [{ name: 'session', value: 'ok', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] }),
    );
    const url = `http://127.0.0.1:${port}/dashboard`;

    await withBrowser(async (browser) => {
      const anon = await openPage(browser, { url, viewport: '1280x800' });
      const anonBody = await anon.page.textContent('body');
      assert.ok(anon.page.url().endsWith('/login'), `匿名访问没被踢到登录页：${anon.page.url()}`);
      assert.ok(!anonBody.includes('私密仪表盘'), '匿名访问看到了受保护内容');
      await anon.context.close();

      const authed = await openPage(browser, { url, state: statePath, viewport: '1280x800' });
      const authedBody = await authed.page.textContent('body');
      assert.ok(authed.page.url().endsWith('/dashboard'), `带登录态仍被踢走：${authed.page.url()}`);
      assert.ok(authedBody.includes('私密仪表盘'), '带登录态没看到受保护内容');

      const report = await renderPage(authed.page, { outDir: dir, name: 'dash' });
      await authed.context.close();
      assert.ok(report.counts.texts >= 3, `受保护页采集到的文本太少：${report.counts.texts}`);
      assert.ok(report.counts.interactive >= 1, '受保护页没采到可交互元素');
    });
  } finally {
    srv.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// 装了 playwright 却 import 不进来 = 坏安装，不是"这台机器没装"。
// 这种情况下整层静默跳过、整套测试全绿——那是假绿，必须响。
test('浏览器层不许因为坏安装而整层静默跳过', (t) => {
  if (playwrightBroken) t.fail('node_modules 里装着 playwright，却 import 不进来：这是坏安装，整层跳过会变成假绿');
});
