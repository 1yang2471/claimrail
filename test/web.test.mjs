import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderPage, reportPathFor } from '../src/observe/web.mjs';
import { verify } from '../src/evidence.mjs';

// 一个"代码全合规、人看着难受"的聊天页采到的数据：覆盖式滚动条压右对齐气泡、
// 最后一条消息落在固定输入框下面、发送按钮 28px。
const defectData = {
  viewport: { w: 400, h: 780 },
  scrollContainers: [
    {
      selector: 'body>div>.msg-list',
      rect: { x: 0, y: 0, w: 400, h: 600 },
      scrollableY: true,
      reservedX: 0,
      lastChildRect: { x: 0, y: 700, w: 400, h: 40 },
    },
  ],
  texts: [
    { selector: '.bubble.me', rect: { x: 210, y: 500, w: 180, h: 40 }, color: 'rgb(17, 17, 17)', background: 'rgb(255, 255, 255)', fontSize: 15 },
  ],
  interactive: [{ selector: '#send', rect: { x: 0, y: 0, w: 28, h: 28 }, focusable: true, hasVisibleFocus: null }],
  fixedRects: [{ selector: '#composer', rect: { x: 0, y: 720, w: 400, h: 60 } }],
};

const fakePage = (data) => ({
  evaluate: async () => data,
  screenshot: async ({ path }) => writeFile(path, 'PNG-bytes'),
});

const withDir = async (fn) => {
  const dir = await mkdtemp(join(tmpdir(), 'forklight-web-'));
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
    assert.match(byId['scrollbar-clears-text'].detail, /覆盖式滚动条压住 1 处文本/);
    assert.equal(byId['bottom-not-covered'].ok, false);
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
    fixed.scrollContainers[0].lastChildRect = { x: 0, y: 600, w: 400, h: 40 };
    fixed.interactive[0].rect = { x: 0, y: 0, w: 44, h: 44 };

    await renderPage(fakePage(fixed), { outDir: dir, name: 'chat-fixed' });
    const ctx = {
      lastChangeMs: Date.now() - 1000,
      statFile: async (p) => ({ mtimeMs: (await stat(join(dir, p))).mtimeMs }),
      readReport: async (p) => JSON.parse(await readFile(join(dir, p), 'utf8')),
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
    };
    const r = await verify({ kind: 'render', ref: 'blank.png' }, ctx);
    assert.equal(r.ok, false);
    assert.match(r.why, /没有一项真的判过/);
  });
});

test('报告路径由截图名派生，避免两处手写不一致', () => {
  assert.equal(reportPathFor('shots/chat@2x.png'), 'shots/chat@2x.report.json');
  assert.equal(reportPathFor('shots/chat.txt'), 'shots/chat.txt');
});
