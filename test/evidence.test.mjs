import test from 'node:test';
import assert from 'node:assert/strict';
import { verify, verifyAll, RENDER_CHECK_IDS } from '../src/evidence.mjs';

// 这一层的测试默认立场是"调用方在骗我"。上一版这里全是老实 ctx 的用例，
// 结果 trouble-maker 当场复现出三条伪造路径（编报告 id、引用自己刚写的代码、
// 单字符断言）——测的是正常请求，没测核心主张。

const passing = (over = {}) => ({
  report_schema: 1,
  name: 'chat',
  checks: RENDER_CHECK_IDS.map((id) => ({ id, ok: true, detail: '' })),
  ...over,
});

const renderCtx = (over = {}) => ({
  lastChangeMs: 1000,
  statFile: async () => ({ mtimeMs: 2000 }),
  readReport: async () => passing(),
  ...over,
});

const goodAsserts = ['scrollbar-clears-text', 'contrast-ok'];

test('五种 kind 的合法形状都能通过', async () => {
  assert.equal((await verify(null, renderCtx())).ok, false);

  const repo = await verify({ kind: 'repo', ref: 'src/Chat.tsx:88', asserts: ['scrollbar-gutter'] }, { readRange: async () => '  scrollbar-gutter: stable;' });
  assert.equal(repo.ok, true);

  const mem = await verify({ kind: 'memory', ref: 'log#2', asserts: ['16px'] }, { logEntry: async () => '卡片上下间距至少 16px' });
  assert.equal(mem.ok, true);

  assert.equal((await verify({ kind: 'render', ref: 'shots/chat.png', asserts: goodAsserts }, renderCtx())).ok, true);

  const web = await verify({ kind: 'web', ref: 'https://x.dev/a', asserts: ['composer spacing'] }, { allowNet: true, fetch: async () => ({ status: 200, text: 'the composer spacing is tight' }) });
  assert.equal(web.ok, true);
});

// web 档回验的是"页面上有没有这句话"，不是"传输字节里有没有这串字"。与 precedent 档同源：
// 真网络实测 17 个可引源里 8 个的句子被行内标签切开；反过来按原始 HTML 匹配，<script> 里的
// 字符串也能冒充页面正文。
test('web 档按可见正文回验：被标签切开算说过，只在脚本里出现不算', async () => {
  const split = { allowNet: true, fetch: async () => ({ status: 200, text: 'the <strong>composer spacing</strong> is <em>tight</em>' }) };
  const claim = { kind: 'web', ref: 'https://x.dev/a', asserts: ['composer spacing is tight'] };
  assert.equal((await verify(claim, split)).ok, true);

  const prose = 'prose a real documentation page would contain about layout, motion and color contrast';
  const scripted = { allowNet: true, fetch: async () => ({ status: 200, text: `<script>var s="composer spacing is tight";</script><p>${prose}</p>` }) };
  assert.equal((await verify(claim, scripted)).ok, false);
});

// ---- render 档：伪造报告 ----

test('伪造：报告里写一个不存在的检查项 id，不认', async () => {
  const r = await verify({ kind: 'render', ref: 'shots/chat.png', asserts: ['anything-i-made-up'] }, renderCtx({ readReport: async () => passing({ checks: [{ id: 'anything-i-made-up', ok: true }] }) }));
  assert.equal(r.ok, false);
  assert.match(r.why, /未知检查项/);
});

test('伪造：只交一项绿的、其余四项根本不写，不认', async () => {
  const r = await verify({ kind: 'render', ref: 'shots/chat.png', asserts: ['contrast-ok'] }, renderCtx({ readReport: async () => passing({ checks: [{ id: 'contrast-ok', ok: true }] }) }));
  assert.equal(r.ok, false);
  assert.match(r.why, /报告缺了 4 项检查/);
});

test('伪造：五项全交但有一项 null，不许冒充判过', async () => {
  const checks = RENDER_CHECK_IDS.map((id) => ({ id, ok: id === 'focus-visible-ok' ? null : true, detail: '未采到' }));
  const r = await verify({ kind: 'render', ref: 'shots/chat.png', asserts: ['focus-visible-ok'] }, renderCtx({ readReport: async () => passing({ checks }) }));
  assert.equal(r.ok, false);
  assert.match(r.why, /不作数/);
});

test('伪造：报告是别次采集的（name 对不上截图名），不认', async () => {
  const r = await verify({ kind: 'render', ref: 'shots/chat.png', asserts: goodAsserts }, renderCtx({ readReport: async () => passing({ name: 'other-page' }) }));
  assert.equal(r.ok, false);
  assert.match(r.why, /不是同一次采集/);
});

test('伪造：没有版本字段的旧报告不认', async () => {
  const r = await verify({ kind: 'render', ref: 'shots/chat.png', asserts: goodAsserts }, renderCtx({ readReport: async () => ({ checks: passing().checks }) }));
  assert.equal(r.ok, false);
  assert.match(r.why, /版本不对/);
});

test('render 不给断言项 = "我看过了"，不是证据', async () => {
  const r = await verify({ kind: 'render', ref: 'shots/chat.png' }, renderCtx());
  assert.equal(r.ok, false);
  assert.match(r.why, /只有截图没有断言项/);
});

test('statFile 缺 mtimeMs 字段不许当成"比代码新"', async () => {
  const r = await verify({ kind: 'render', ref: 'shots/chat.png', asserts: goodAsserts }, renderCtx({ statFile: async () => ({ size: 1 }) }));
  assert.equal(r.ok, false);
  assert.match(r.why, /时间戳取不到/);
});

test('旧截图仍然被时间戳抓住', async () => {
  const r = await verify({ kind: 'render', ref: 'shots/chat.png', asserts: goodAsserts }, renderCtx({ statFile: async () => ({ mtimeMs: 999 }) }));
  assert.equal(r.ok, false);
  assert.match(r.why, /截图比代码旧/);
});

// ---- repo 档：先干后证与弱断言 ----

test('引用本次刚写的代码冒充"既有做法"，不认', async () => {
  const ctx = { readRange: async () => 'scrollbar-gutter: stable;', isChanged: async () => true };
  const r = await verify({ kind: 'repo', ref: 'src/New.tsx:12', asserts: ['scrollbar-gutter'] }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.why, /本次改动新增/);
});

test('引用既有代码（不在本次改动里）照常通过', async () => {
  const ctx = { readRange: async () => 'scrollbar-gutter: stable;', isChanged: async () => false };
  assert.equal((await verify({ kind: 'repo', ref: 'src/Chat.tsx:88', asserts: ['scrollbar-gutter'] }, ctx)).ok, true);
});

test('单字符断言不认：整文件里总能凑出一个字符', async () => {
  const r = await verify({ kind: 'repo', ref: 'src/a.tsx:10', asserts: ['a'] }, { readRange: async () => 'anything' });
  assert.equal(r.ok, false);
  assert.match(r.why, /要点太短/);
});

test('断言为空不认（schema 之外的第二道，bench 与红队会直接调 verify）', async () => {
  assert.equal((await verify({ kind: 'repo', ref: 'src/a.tsx:10', asserts: [] }, { readRange: async () => 'x' })).ok, false);
  assert.equal((await verify({ kind: 'web', ref: 'https://x.dev', asserts: [] }, { allowNet: true, fetch: async () => ({ status: 200, text: 'a' }) })).ok, false);
});

test('引用跨整文件（超过 40 行）不认：那不是"那一处的做法"', async () => {
  const r = await verify({ kind: 'repo', ref: 'src/a.tsx:1-10000', asserts: ['scrollbar'] }, { readRange: async () => 'scrollbar-gutter' });
  assert.equal(r.ok, false);
  assert.match(r.why, /不可用/);
});

test('第 0 行不认——slice(-1) 会返回文件末尾，凭它能凑出一条不存在的证据', async () => {
  assert.equal((await verify({ kind: 'repo', ref: 'src/a.tsx:0', asserts: ['scrollbar'] }, { readRange: async () => 'scrollbar-gutter' })).ok, false);
  assert.equal((await verify({ kind: 'repo', ref: 'src/a.tsx:9-3', asserts: ['scrollbar'] }, { readRange: async () => 'scrollbar-gutter' })).ok, false);
});

// ---- memory 档：引用坐标系 ----

test('rules#1 / anchor#1 不再被当成 log 行号', async () => {
  let touched = false;
  const ctx = { logEntry: async () => { touched = true; return '卡片上下间距至少 16px'; } };
  for (const ref of ['rules#1', 'anchor#1', 'log-1']) {
    const r = await verify({ kind: 'memory', ref, asserts: ['16px'] }, ctx);
    assert.equal(r.ok, false, ref);
    assert.match(r.why, /只接受 log#n/, ref);
  }
  assert.equal(touched, false, '不该去读 log');
});

// ---- web 档 ----

test('回访抛错只让这条证据失败，不炸掉整份检查', async () => {
  const ctx = { allowNet: true, fetch: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND x.dev'), { name: 'TypeError' }); } };
  const r = await verify({ kind: 'web', ref: 'https://x.dev/a', asserts: ['composer'] }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.why, /回访失败/);
});

test('未同意不外发；3xx/403 一律算失败并写明状态码', async () => {
  assert.match((await verify({ kind: 'web', ref: 'https://x.dev', asserts: ['abc'] }, { fetch: async () => ({ status: 200, text: 'abc' }) })).why, /未获同意/);
  assert.match((await verify({ kind: 'web', ref: 'https://x.dev', asserts: ['abc'] }, { allowNet: true, fetch: async () => ({ status: 403, text: 'blocked' }) })).why, /403/);
});

test('未知 kind 不调用任何外部能力', async () => {
  assert.equal((await verify({ kind: 'vibe', ref: 'x', asserts: ['abc'] }, renderCtx())).ok, false);
});

test('verifyAll 保持顺序，null 证据不做外部访问', async () => {
  let calls = 0;
  const ctx = renderCtx({ readReport: async () => { calls++; return passing(); }, logEntry: async () => '要 16px' });
  const out = await verifyAll({ forks: [{ evidence: null }, { evidence: { kind: 'memory', ref: 'log#1', asserts: ['16px'] } }] }, ctx);
  assert.equal(out.length, 2);
  assert.equal(out[0].ok, false);
  assert.equal(out[1].ok, true);
  assert.equal(calls, 0);
});

test('evidence 与 geometry 的检查项集合必须一致（两处写两遍的代价由测试兜住）', async () => {
  const { CHECK_IDS } = await import('../src/observe/geometry.mjs');
  assert.deepEqual(RENDER_CHECK_IDS, CHECK_IDS);
});

test('evidence 与 web 的报告路径派生必须一致', async () => {
  const { reportPathFor } = await import('../src/observe/web.mjs');
  for (const ref of ['shots/chat.png', '.forklight/shots/chat@390x700.png']) {
    assert.equal(String(ref).replace(/\.png$/, '.report.json'), reportPathFor(ref), ref);
  }
});
