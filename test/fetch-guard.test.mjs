// fetch-guard 的地址分类与回访防线。2026-11-21 审查发现这个文件整份零测试钉住——
// 违反项目自己的硬规矩 2（"从来没报过错的守卫等于没加"）。按四类形状钉：
// 点分十进制私网段、WHATWG 序列化的映射 v6、重定向变体（URL 会把 0x7f000001 这类
// 编码变体规范成点分四段）、以及 P0：三个 loopback 别名曾被算成三个"独立域名"，
// 模型自起本地服务就能凑齐 ≥3 票——现在全部归并成同一票。
import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchWithRedirects, isPrivateAddress, isPrivateHost, isPrivateRedirectTarget } from '../src/commands/fetch-guard.mjs';
import { verify, registrableDomain } from '../src/evidence.mjs';

const quote = 'This quote is long enough to be verified by the program.';

test('isPrivateAddress：私网全集与映射序列化', () => {
  const privates = [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '0.1.2.3', '169.254.169.254', '169.254.0.1',
    '::1', '::', 'fe80::1', 'fd00::1', 'fc00::1',
    '[::1]', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:10.0.0.5',
  ];
  for (const addr of privates) assert.equal(isPrivateAddress(addr), true, addr);
  const publics = ['8.8.8.8', '2001:db8::1', 'example.com', 'fc123.example.com', '::ffff:8.8.8.8'];
  for (const addr of publics) assert.equal(isPrivateAddress(addr), false, addr);
});

test('isPrivateHost 直连许可：内网文档站可以，link-local/元数据不行', () => {
  for (const h of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.10', '[::1]', 'docs.internal.corp']) {
    assert.equal(isPrivateHost(h), false, h);
  }
  for (const h of ['169.254.169.254', '0.0.0.0', '::', '[fe80::1]', '::ffff:169.254.169.254', 'metadata.google.internal', '']) {
    assert.equal(isPrivateHost(h), true, h);
  }
});

test('isPrivateRedirectTarget：重定向目标比直连严，环回/私网全拒', () => {
  for (const h of ['localhost', '127.0.0.1', '10.0.0.5', '[::1]', '[::ffff:7f00:1]', 'fd00::1', 'metadata.google.internal']) {
    assert.equal(isPrivateRedirectTarget(h), true, h);
  }
  assert.equal(isPrivateRedirectTarget('8.8.8.8'), false);
});

test('重定向变体：URL 解析器规范成点分四段后仍被拒', async () => {
  // 0x7f000001 / 2130706433 / 0177.0.0.1 会被 WHATWG URL 规范成 127.0.0.1，
  // 守卫认序列化后的形状即可；这里证明它们真的会撞上"重定向指向私网"
  const redirecting = (loc) => async (url) => {
    if (url === 'https://evil.example/start') {
      return { status: 302, headers: { get: (k) => (String(k).toLowerCase() === 'location' ? loc : null) }, text: async () => '' };
    }
    throw new Error(`不应跟随到 ${url}`);
  };
  for (const loc of ['http://0x7f000001/x', 'http://2130706433/x', 'http://0177.0.0.1/x', 'http://[::ffff:127.0.0.1]/', 'http://localhost/x']) {
    await assert.rejects(
      fetchWithRedirects('https://evil.example/start', true, redirecting(loc)),
      /重定向指向私网/,
      loc,
    );
  }
});

test('registrableDomain：loopback/内网地址归并成同一票', () => {
  for (const url of ['http://localhost:5173/a', 'http://127.0.0.1:9001/b', 'http://[::1]/c', 'http://10.0.0.5/x', 'http://192.168.1.1/', 'http://172.20.0.9/', 'http://metadata.google.internal/']) {
    assert.equal(registrableDomain(url), '(内网)', url);
  }
  assert.equal(registrableDomain('http://www.example.com/a'), 'example.com');
});

test('P0 钉住：三个 loopback 别名只算一票，凑不齐 ≥3 独立域名', async () => {
  const urls = ['http://localhost:9001/g', 'http://127.0.0.1:9001/g', 'http://[::1]:9001/g'];
  const r = await verify(
    { kind: 'precedent', sources: urls.map((url) => ({ url, quote })) },
    { allowNet: true, fetch: async (u) => ({ status: 200, text: `<p>${quote}</p>` }) },
  );
  assert.equal(r.ok, false);
  assert.match(r.why, /只有 1 个独立域名/);
});

test('P0 另一半：公网域名解析进内网段，DNS 归并成同一票', async () => {
  const domains = ['alpha.dev', 'beta.design', 'gamma.io'];
  const r = await verify(
    { kind: 'precedent', sources: domains.map((d) => ({ url: `https://${d}/guide`, quote })) },
    {
      allowNet: true,
      fetch: async () => ({ status: 200, text: `<p>${quote}</p>` }),
      // 攻击者把自己的三个域名都解析到本机：DNS 层归并后凑不齐三票
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    },
  );
  assert.equal(r.ok, false);
  assert.match(r.why, /只有 1 个独立域名/);
});

test('变异对照：lookup 解析到公网时三域照常成立', async () => {
  const domains = ['alpha.dev', 'beta.design', 'gamma.io'];
  const r = await verify(
    { kind: 'precedent', sources: domains.map((d) => ({ url: `https://${d}/guide`, quote })) },
    {
      allowNet: true,
      fetch: async () => ({ status: 200, text: `<p>${quote}</p>` }),
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    },
  );
  assert.equal(r.ok, true, r.why);
  assert.match(r.why, /3 个独立域名/);
});

