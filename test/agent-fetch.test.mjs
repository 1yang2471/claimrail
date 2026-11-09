import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTools, execFetch } from '../bench/agent.mjs';

// fetch_url 的契约必须和 check 的回访同一口径：模型看到的正文 = 程序之后回验的正文。
// 没有这个工具之前，precedent 引文全靠模型背——背对了过回访，背错了被拦（AUDIT-2026-11-09）。

const HTML =
  '<html><head><script>var leak="navigation bars should be 80dp in height";</script>' +
  '<style>a{}</style></head><body><h1>Navigation bar</h1><p>The navigation bar is 80dp tall.</p></body></html>';

test('fetch_url 交可见正文，剥掉 script/style——和 evidence 回访同一管线', async () => {
  const r = await execFetch('https://m3.example/specs', {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => HTML }),
  });
  assert.match(r, /the navigation bar is 80dp tall/);
  assert.doesNotMatch(r, /var leak=/);
});

test('fetch_url 拒非 http(s)、拒带凭据的 URL', async () => {
  const fake = async () => ({ ok: true, status: 200, text: async () => 'x' });
  await assert.rejects(() => execFetch('file:///etc/passwd', { fetchImpl: fake }), /只允许 http/);
  await assert.rejects(() => execFetch('https://usr@example.com/', { fetchImpl: fake }), /凭据/);
});

test('fetch_url 按字节封顶并明说截断', async () => {
  const big = async () => ({ ok: true, status: 200, text: async () => 'word '.repeat(100_000) });
  const r = await execFetch('https://a.example', { fetchImpl: big, maxBytes: 500 });
  assert.ok(r.length < 2000, `r.length=${r.length}`);
  assert.match(r, /截断/);
});

test('fetch_url 只在 allowNet 时进工具表', () => {
  assert.equal(buildTools(false).some((t) => t.name === 'fetch_url'), false);
  assert.equal(buildTools(true).some((t) => t.name === 'fetch_url'), true);
  assert.equal(buildTools(true).some((t) => t.name === 'run_shell'), true);
});
