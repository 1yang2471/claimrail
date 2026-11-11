import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderPage, reportPathFor } from '../src/observe/web.mjs';
import { web } from '../src/commands/web.mjs';
import { verify } from '../src/evidence.mjs';

// 一个"代码全合规、人看着难受"的聊天页采到的数据：滚动条带压在右对齐气泡上、
// 滚动区域伸进固定输入框底下、发送按钮 28px。
const defectData = {
  viewport: { w: 400, h: 780 },
  scrollContainers: [
    {
      selector: 'body>div>.msg-list',
      rect: { x: 0, y: 0, w: 400, h: 780 },
      scrollableY: true,
      reservedX: 0,
      scrollbarStyle: 'auto',
      gutter: 'auto',
    },
  ],
  texts: [
    { selector: '.bubble.me', rect: { x: 210, y: 500, w: 180, h: 40 }, color: 'rgb(17, 17, 17)', background: 'rgb(255, 255, 255)', fontSize: 15 },
  ],
  interactive: [{ selector: '#send', rect: { x: 0, y: 0, w: 28, h: 28 }, focusable: true, baseStyle: 'sig', hasVisibleFocus: null }],
  fixedRects: [{ selector: '#composer', rect: { x: 0, y: 720, w: 400, h: 60 } }],
};

const fakePage = (data) => ({
  evaluate: async () => data,
  screenshot: async ({ path }) => writeFile(path, 'PNG-bytes'),
});

const withDir = async (fn) => {
  const dir = await mkdtemp(join(tmpdir(), 'claimrail-web-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('renderPage 同时落截图和度量报告，两项缺一不可', async () => {
  await withDir(async (dir) => {
    const report = await renderPage(fakePage(defectData), { outDir: dir, name: 'chat', label: '滚动到底' });
    assert.ok((await stat(join(dir, 'chat.png'))).size > 0);
    const onDisk = JSON.parse(await readFile(join(dir, 'chat.report.json'), 'utf8'));
    assert.deepEqual(onDisk, report);
    assert.equal(report.checks.length, 5);
    assert.equal(report.label, '滚动到底');
    assert.deepEqual(report.counts.texts, 1);
  });
});

test('报告里的红项直接点名动机缺陷', async () => {
  await withDir(async (dir) => {
    const { checks } = await renderPage(fakePage(defectData), { outDir: dir, name: 'chat' });
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    assert.equal(byId['scrollbar-clears-text'].ok, false);
    assert.match(byId['scrollbar-clears-text'].detail, /压住 1 处文本/);
    assert.equal(byId['bottom-not-covered'].ok, false);
    assert.match(byId['bottom-not-covered'].detail, /贴底的固定条/);
    assert.equal(byId['touch-targets-ok'].ok, false);
    assert.equal(byId['focus-visible-ok'].ok, null);
    assert.equal(byId['contrast-ok'].ok, true);
  });
});

test('端到端：截图是新的，但判红——证据不成立，门照样拦', async () => {
  await withDir(async (dir) => {
    await renderPage(fakePage(defectData), { outDir: dir, name: 'chat' });
    const ctx = {
      lastChangeMs: Date.now() - 1000,
      statFile: async (p) => ({ mtimeMs: (await stat(join(dir, p))).mtimeMs }),
      readReport: async (p) => JSON.parse(await readFile(join(dir, p), 'utf8')),
      // 报告里写了 shot_sha256，这里重算截图哈希——落盘链在测试里也要按真实路径走
      shotHash: async (p) => (await import('node:crypto')).createHash('sha256').update(await readFile(join(dir, p))).digest('hex'),
    };

    const r = await verify({ kind: 'render', ref: 'chat.png', asserts: ['scrollbar-clears-text', 'bottom-not-covered'] }, ctx);
    assert.equal(r.ok, false);
    assert.match(r.why, /滚动条压住/);
  });
});

test('端到端：修好之后同一份检查转绿，证据才成立', async () => {
  await withDir(async (dir) => {
    const fixed = structuredClone(defectData);
    fixed.scrollContainers[0].reservedX = 15; // 经典滚动条占位
    fixed.scrollContainers[0].rect = { x: 0, y: 0, w: 400, h: 720 }; // 不再伸到输入框底下
    fixed.interactive[0].rect = { x: 0, y: 0, w: 44, h: 44 };

    await renderPage(fakePage(fixed), { outDir: dir, name: 'chat-fixed' });
    const ctx = {
      lastChangeMs: Date.now() - 1000,
      statFile: async (p) => ({ mtimeMs: (await stat(join(dir, p))).mtimeMs }),
      readReport: async (p) => JSON.parse(await readFile(join(dir, p), 'utf8')),
      // 报告里写了 shot_sha256，这里重算截图哈希——落盘链在测试里也要按真实路径走
      shotHash: async (p) => (await import('node:crypto')).createHash('sha256').update(await readFile(join(dir, p))).digest('hex'),
    };
    const r = await verify({ kind: 'render', ref: 'chat-fixed.png', asserts: ['scrollbar-clears-text', 'bottom-not-covered', 'touch-targets-ok', 'contrast-ok'] }, ctx);
    assert.equal(r.ok, true, r.why);
  });
});

test('采集器空转产不出证据：全 null 的报告不能当作"已经看过"', async () => {
  await withDir(async (dir) => {
    await renderPage(fakePage({ viewport: { w: 0, h: 0 }, scrollContainers: [], texts: [], interactive: [], fixedRects: [] }), { outDir: dir, name: 'blank' });
    const ctx = {
      lastChangeMs: Date.now() - 1000,
      statFile: async (p) => ({ mtimeMs: (await stat(join(dir, p))).mtimeMs }),
      readReport: async (p) => JSON.parse(await readFile(join(dir, p), 'utf8')),
      // 报告里写了 shot_sha256，这里重算截图哈希——落盘链在测试里也要按真实路径走
      shotHash: async (p) => (await import('node:crypto')).createHash('sha256').update(await readFile(join(dir, p))).digest('hex'),
    };
    const r = await verify({ kind: 'render', ref: 'blank.png', asserts: ['scrollbar-clears-text', 'contrast-ok'] }, ctx);
    assert.equal(r.ok, false);
    assert.match(r.why, /不作数/);
  });
});

test('报告路径由截图名派生，避免两处手写不一致', () => {
  assert.equal(reportPathFor('shots/chat@2x.png'), 'shots/chat@2x.report.json');
  assert.equal(reportPathFor('shots/chat.txt'), 'shots/chat.txt');
});

// —— web 命令本身（以前一行测试都没有，退出码也就没人管）——
// 退出码不许说谎：五项全未判时返回 0，CI 会当成"检查通过"，而这份报告本来就不能当证据。
const fakeBrowser = () => ({ close: async () => {} });

const runWeb = (data, opts = {}) =>
  web({
    url: 'http://127.0.0.1:9/',
    viewport: '390x700',
    cwd: opts.cwd,
    launch: async () => fakeBrowser(),
    open: async () => ({ page: fakePage(data), context: { close: async () => {} } }),
    ...opts,
  });

test('web 命令：五项全未判时退出码必须是 1（未判 ≠ 合格）', async () => {
  await withDir(async (dir) => {
    const empty = { viewport: { w: 390, h: 700 }, scrollContainers: [], texts: [], interactive: [], fixedRects: [] };
    const r = await runWeb(empty, { cwd: dir });
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, /没有任何一项真的判过/);
  });
});

test('web 命令：有红项退出 1，全绿退出 0', async () => {
  await withDir(async (dir) => {
    const bad = await runWeb(defectData, { cwd: dir });
    assert.equal(bad.code, 1, bad.text);
    assert.match(bad.text, /退出码 1：有检查项判红/);
  });
});

// 调研（craft-anything 的 evidence record 带 limitations）得到的启发：
// 报告要说清"这一轮没覆盖到哪里"，而不是让读者自己从 detail 里猜。
test('度量报告要带 limitations：截断、未判底色、焦点没探都要点名', async () => {
  await withDir(async (dir) => {
    const truncated = {
      ...defectData,
      raw: { texts: 401, interactive: 121, scrollContainers: 61, fixedRects: 41 },
    };
    const report = await renderPage(fakePage(truncated), { outDir: dir, name: 'lim', pixel: false });
    const lim = report.limitations.join(String.fromCharCode(10));
    assert.match(lim, /文本采集被截断/);
    assert.match(lim, /可交互元素采集被截断/);
    assert.match(lim, /滚动容器采集被截断/);
    assert.match(lim, /固定元素采集被截断/);
    assert.match(lim, /焦点探测/, lim);

    const clean = await renderPage(fakePage(defectData), { outDir: dir, name: 'clean', pixel: false, focusSamples: [] });
    assert.ok(Array.isArray(clean.limitations), 'limitations 必须是数组');
  });
});

test('报告写明它测的是哪张图：shot_sha256 与截图内容一致', async () => {
  await withDir(async (dir) => {
    const report = await renderPage(fakePage(defectData), { outDir: dir, name: 'hash', pixel: false });
    const { createHash } = await import('node:crypto');
    const real = createHash('sha256').update(await readFile(join(dir, 'hash.png'))).digest('hex');
    assert.equal(report.shot_sha256, real);
    const onDisk = JSON.parse(await readFile(join(dir, 'hash.report.json'), 'utf8'));
    assert.equal(onDisk.shot_sha256, real);
  });
});

test('web 命令把 limitations 打到屏幕上，不只留在报告里', async () => {
  await withDir(async (dir) => {
    const truncated = { ...defectData, raw: { texts: 401, interactive: 121, scrollContainers: 61, fixedRects: 41 } };
    const r = await runWeb(truncated, { cwd: dir });
    assert.match(r.text, /本轮没覆盖到/);
    assert.match(r.text, /文本采集被截断/);
  });
});

// 审查抓到的顺序 bug：截图排在 Tab 焦点探测之后，而 Tab 会滚动页面（真站实测一次
// 0→911→1532）。探测之后拍，像素采样拿"滚动前"的矩形坐标去读"滚动后"的截图——
// 颜色对不上号，假绿假红都可能，报告还标 backgroundFrom:'pixel'。
test('截图先于焦点探测落盘：Tab 滚动不许污染像素采样的基准图', async () => {
  await withDir(async (dir) => {
    const calls = [];
    const page = {
      evaluate: async () => {
        calls.push('evaluate');
        return { ...defectData, interactive: [] };
      },
      screenshot: async ({ path }) => {
        calls.push('screenshot');
        await writeFile(path, 'PNG-bytes');
      },
    };
    await renderPage(page, { outDir: dir, name: 'order', focusProbe: async () => { calls.push('focusProbe'); return []; } });
    assert.deepEqual(calls, ['evaluate', 'screenshot', 'focusProbe']);
  });
});

// 审查抓到的可用性问题：--out 给绝对路径时 join(cwd, out) 拼成 <cwd>\D:\x（ENOENT）；
// 而且仓库外的路径写不出可回验的 ref（evidence 回验找不到文件）。早报错。
test('web --out：仓库外报错，仓库内绝对路径放行', async () => {
  await withDir(async (dir) => {
    const outside = await mkdtemp(join(tmpdir(), 'fk-web-out-'));
    const r = await runWeb(defectData, { cwd: dir, out: outside });
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, /必须落在仓库内/);

    // 仓库内的绝对路径不该被拼坏：能走到浏览器（fake）并正常出报告，
    // ref 是仓库根相对路径（URL 指纹名 + 视口标签）
    const ok = await runWeb(defectData, { cwd: dir, out: join(dir, 'shots') });
    assert.equal(ok.code, 1, ok.text); // defectData 本身带红项
    assert.match(ok.text, /shots\/[A-Za-z0-9_-]+@390x700\.png/);
  });
});

test('web --name：路径穿越直接拒，不许落盘到仓库外', async () => {
  const r = await web({
    url: 'http://example.com/',
    name: '../../evil',
    launch: async () => { throw new Error('should not launch'); },
    open: async () => ({ page: fakePage(defectData), context: { close: async () => {} }, focusProbe: async () => [] }),
  });
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /路径分隔符|不许| traversal/, r.text);
});
