import test from 'node:test';
import assert from 'node:assert/strict';
import { verify, verifyAll } from '../src/evidence.mjs';

// 外部世界全部注入：不碰网络、不碰磁盘、不碰浏览器，时间也由外部给。
const passingReport = { checks: [{ id: 'scrollbar-clears-text', ok: true, detail: '' }] };

const ctx = (over = {}) => ({
  readRange: async () => null,
  logEntry: async () => null,
  statFile: async () => null,
  readReport: async () => passingReport,
  fetch: async () => null,
  lastChangeMs: 1000,
  allowNet: false,
  ...over,
});

test('evidence 为空不是失败，是一个待答的问题', async () => {
  assert.deepEqual(await verify(null, ctx()), { ok: false, why: 'evidence 为空' });
});

test('repo：引用读得到且含要点才算过', async () => {
  const good = { kind: 'repo', ref: 'src/Chat.tsx:88', asserts: ['scrollbar-gutter'] };
  assert.equal((await verify(good, ctx({ readRange: async () => '  scrollbar-gutter: stable;' }))).ok, true);
});

test('repo：给不出行号位置的引用直接拒', async () => {
  assert.equal((await verify({ kind: 'repo', ref: '整个仓库', asserts: ['x'] }, ctx())).ok, false);
});

test('repo：行号越界或文件不存在，不能算"参考了现有代码"', async () => {
  const r = await verify({ kind: 'repo', ref: 'src/Gone.tsx:12', asserts: ['x'] }, ctx());
  assert.equal(r.ok, false);
  assert.match(r.why, /读不到/);
});

test('repo：位置对了但那里说的不是这件事', async () => {
  const r = await verify({ kind: 'repo', ref: 'src/Chat.tsx:88', asserts: ['scrollbar-gutter'] }, ctx({ readRange: async () => 'overflow: hidden' }));
  assert.equal(r.ok, false);
  assert.match(r.why, /scrollbar-gutter/);
});

test('memory：引用一条不存在的否决记录 = 编造', async () => {
  assert.equal((await verify({ kind: 'memory', ref: 'log#7' }, ctx())).ok, false);
});

test('memory：记录在、内容也对得上', async () => {
  const c = ctx({ logEntry: async () => '卡片上下间距 8px 太挤 → 要 16px' });
  assert.equal((await verify({ kind: 'memory', ref: 'log#2', asserts: ['16px'] }, c)).ok, true);
});

test('render：截图不存在', async () => {
  assert.equal((await verify({ kind: 'render', ref: 'shots/chat.png' }, ctx())).ok, false);
});

test('render：拿旧图充新检查，必须被时间戳抓住', async () => {
  const c = ctx({ statFile: async () => ({ mtimeMs: 900 }) });
  const r = await verify({ kind: 'render', ref: 'shots/chat@2x.png' }, c);
  assert.equal(r.ok, false);
  assert.match(r.why, /截图比代码旧/);
});

test('render：比最后一次改动新就通过', async () => {
  const c = ctx({ statFile: async () => ({ mtimeMs: 1001 }) });
  assert.equal((await verify({ kind: 'render', ref: 'shots/chat.png' }, c)).ok, true);
});

test('render：拿不到代码改动时间就不许声称验证过', async () => {
  const c = ctx({ statFile: async () => ({ mtimeMs: 1 }), lastChangeMs: undefined });
  assert.equal((await verify({ kind: 'render', ref: 'shots/chat.png' }, c)).ok, false);
});

test('web：未获同意不外发，这一档默认关闭', async () => {
  const r = await verify({ kind: 'web', ref: 'https://x.dev', asserts: ['a'] }, ctx());
  assert.equal(r.ok, false);
  assert.match(r.why, /不得外发/);
});

test('web：回访不到 200 就是编造来源', async () => {
  const c = ctx({ allowNet: true, fetch: async () => ({ status: 404, text: '' }) });
  assert.equal((await verify({ kind: 'web', ref: 'https://x.dev/a', asserts: ['a'] }, c)).ok, false);
});

test('web：200 但页面上没那句话，也不算证据', async () => {
  const c = ctx({ allowNet: true, fetch: async () => ({ status: 200, text: ' totally unrelated ' }) });
  assert.equal((await verify({ kind: 'web', ref: 'https://x.dev/a', asserts: ['composer spacing'] }, c)).ok, false);
});

test('web：回访成功且含要点', async () => {
  const c = ctx({ allowNet: true, fetch: async () => ({ status: 200, text: 'the composer uses tighter spacing' }) });
  assert.equal((await verify({ kind: 'web', ref: 'https://x.dev/a', asserts: ['composer', 'spacing'] }, c)).ok, true);
});

test('render：只有截图、没有度量报告 = 看了图但没判过', async () => {
  const c = ctx({ statFile: async () => ({ mtimeMs: 2000 }), readReport: async () => null });
  const r = await verify({ kind: 'render', ref: 'shots/chat.png' }, c);
  assert.equal(r.ok, false);
  assert.match(r.why, /没有度量报告/);
});

test('render：报告里五项全是 null，一项都不许当作证据', async () => {
  const c = ctx({
    statFile: async () => ({ mtimeMs: 2000 }),
    readReport: async () => ({ checks: ['scrollbar-clears-text', 'contrast-ok'].map((id) => ({ id, ok: null })) }),
  });
  const r = await verify({ kind: 'render', ref: 'shots/chat.png' }, c);
  assert.equal(r.ok, false);
  assert.match(r.why, /没有一项真的判过/);
});

test('render：断言的检查项判红，证据不成立且要说清红在哪', async () => {
  const c = ctx({
    statFile: async () => ({ mtimeMs: 2000 }),
    readReport: async () => ({ checks: [{ id: 'scrollbar-clears-text', ok: false, detail: '覆盖式滚动条压住 3 处文本' }] }),
  });
  const r = await verify({ kind: 'render', ref: 'shots/chat.png', asserts: ['scrollbar-clears-text'] }, c);
  assert.equal(r.ok, false);
  assert.match(r.why, /压住 3 处文本/);
});

test('render：断言项是 null 也不能蒙过去', async () => {
  const c = ctx({
    statFile: async () => ({ mtimeMs: 2000 }),
    readReport: async () => ({ checks: [{ id: 'focus-visible-ok', ok: null, detail: '未采到' }] }),
  });
  assert.equal((await verify({ kind: 'render', ref: 'shots/chat.png', asserts: ['focus-visible-ok'] }, c)).ok, false);
});

test('render：断言的项报告里根本没有，等于换了个说法吹牛', async () => {
  const c = ctx({ statFile: async () => ({ mtimeMs: 2000 }) });
  const r = await verify({ kind: 'render', ref: 'shots/chat.png', asserts: ['nonexistent-check'] }, c);
  assert.equal(r.ok, false);
  assert.match(r.why, /没有 nonexistent-check/);
});

test('render：断言项全绿，证据成立', async () => {
  const c = ctx({
    statFile: async () => ({ mtimeMs: 2000 }),
    readReport: async () => ({ checks: [{ id: 'scrollbar-clears-text', ok: true }, { id: 'contrast-ok', ok: true }] }),
  });
  const r = await verify({ kind: 'render', ref: 'shots/chat.png', asserts: ['scrollbar-clears-text', 'contrast-ok'] }, c);
  assert.equal(r.ok, true);
  assert.match(r.why, /2 项断言全绿/);
});

test('未知 kind 不调用任何外部能力', async () => {  assert.equal((await verify({ kind: 'vibe', ref: 'x' }, ctx())).ok, false);
});

test('verifyAll 按分叉顺序返回，null 证据不需要外部访问', async () => {
  const out = await verifyAll({ forks: [{ evidence: null }, { evidence: { kind: 'memory', ref: 'log#1' } }] }, ctx({ logEntry: async () => 'ok' }));
  assert.equal(out.length, 2);
  assert.equal(out[0].ok, false);
  assert.equal(out[1].ok, true);
});
