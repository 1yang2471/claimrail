import test from 'node:test';
import assert from 'node:assert/strict';
import { verify } from '../src/evidence.mjs';
import { validateLedger, DESIGN_CLASSES, SCHEMA_VERSION } from '../src/schema.mjs';

// precedent 档存在的理由：AI 不该把自己见得最多的做法当成人类最喜欢的设计。
// 但它不能靠嘴说——来源要逐个回访、按域名去重，采纳度要读 GitHub API 的实测数字。

const src = (host, quote = 'recommended pattern for this') => ({ url: `https://${host}/guide`, quote });
const three = () => [src('alpha.dev'), src('beta.design'), src('gamma.io')];

const ctx = (pages, over = {}) => ({
  allowNet: true,
  fetch: async (url) => (url in pages ? { status: 200, text: pages[url] } : { status: 404, text: '' }),
  ...over,
});

const okPages = () => ({
  'https://alpha.dev/guide': 'Our Recommended Pattern For This is documented here.',
  'https://beta.design/guide': 'text before recommended pattern for this text after',
  'https://gamma.io/guide': 'recommended pattern for this',
});

test('三个独立域名都引文核实 → 成立', async () => {
  const r = await verify({ kind: 'precedent', sources: three() }, ctx(okPages()));
  assert.equal(r.ok, true, r.why);
  assert.match(r.why, /3 个独立域名/);
});

test('三个来源里两个同域（转载同一篇）不算收敛', async () => {
  const sources = [src('alpha.dev'), src('www.alpha.dev'), src('alpha.dev', 'another quote here')];
  const r = await verify({ kind: 'precedent', sources }, ctx(okPages()));
  assert.equal(r.ok, false);
  assert.match(r.why, /只有 1 个独立域名/);
});

test('引文在那页上找不到，就是编造', async () => {
  const pages = { ...okPages(), 'https://gamma.io/guide': 'totally unrelated content' };
  const r = await verify({ kind: 'precedent', sources: three() }, ctx(pages));
  assert.equal(r.ok, false);
  assert.match(r.why, /找不到/);
});

test('回访失败与 404 分别说清，不许合并成一句"核实不了"', async () => {
  const r = await verify({ kind: 'precedent', sources: three() }, ctx({ 'https://alpha.dev/guide': 'recommended pattern for this' }, { fetch: async (u) => (u.includes('alpha') ? { status: 200, text: 'recommended pattern for this' } : { status: 403, text: '' }) }));
  assert.equal(r.ok, false);
  assert.match(r.why, /403/);

  const boom = await verify({ kind: 'precedent', sources: three() }, ctx({}, { fetch: async () => { throw new Error('ENOTFOUND'); } }));
  assert.equal(boom.ok, false);
  assert.match(boom.why, /ENOTFOUND/);
});

test('采纳度读 GitHub API 实测值，不读转述', async () => {
  const pages = {
    ...okPages(),
    'https://api.github.com/repos/primer/css': JSON.stringify({ stargazers_count: 5100 }),
  };
  const good = await verify({ kind: 'precedent', sources: three(), adoption: { repo: 'primer/css', minStars: 5000 } }, ctx(pages));
  assert.equal(good.ok, true, good.why);
  assert.match(good.why, /实测 5100 star/);

  const low = await verify({ kind: 'precedent', sources: three(), adoption: { repo: 'primer/css', minStars: 90000 } }, ctx(pages));
  assert.equal(low.ok, false);
  assert.match(low.why, /实际 5100 star，声称门槛 90000/);

  const broken = await verify({ kind: 'precedent', sources: three(), adoption: { repo: 'ghost/ghost', minStars: 1 } }, ctx(okPages()));
  assert.equal(broken.ok, false);
  assert.match(broken.why, /采纳度读不到/);

  const notJson = await verify(
    { kind: 'precedent', sources: three(), adoption: { repo: 'x/y', minStars: 1 } },
    ctx({ ...okPages(), 'https://api.github.com/repos/x/y': '<html>rate limited</html>' }),
  );
  assert.equal(notJson.ok, false);
  assert.match(notJson.why, /不是 JSON/);
});

test('未获同意不外发；缺 fetch 能力直接判不了', async () => {
  const r = await verify({ kind: 'precedent', sources: three() }, { allowNet: false });
  assert.equal(r.ok, false);
  assert.match(r.why, /未获同意/);
  assert.match((await verify({ kind: 'precedent', sources: three() }, { allowNet: true })).why, /缺少回访能力/);
});

// ---- schema 侧 ----

const ledger = (task_class, forks) => ({ schema: SCHEMA_VERSION, task_class, forks });
const fork = (evidence) => ({
  fork: '列表项密度',
  options: ['紧凑', '宽松'],
  picked: '宽松',
  evidence,
  cost_if_wrong: 'low',
  verified: evidence === null ? false : true,
});

test('设计类任务不许用单一网页转述收场', () => {
  for (const tc of DESIGN_CLASSES) {
    const r = validateLedger(ledger(tc, [fork({ kind: 'web', ref: 'https://beta.design/guide', asserts: ['recommended pattern'] })]));
    assert.equal(r.ok, false, tc);
    assert.ok(r.errors.some((e) => e.rule === 'evidence.design-needs-precedent'), tc);
  }
  // 非设计类仍可走 web 档
  assert.equal(validateLedger(ledger('refactor', [fork({ kind: 'web', ref: 'https://beta.design/guide', asserts: ['recommended pattern'] })])).ok, true);
});

test('precedent 的形状必须自己就站得住', () => {
  assert.equal(validateLedger(ledger('ui-new', [fork({ kind: 'precedent', sources: three() })])).ok, true);

  const tooFew = validateLedger(ledger('ui-new', [fork({ kind: 'precedent', sources: [src('a.dev')] })]));
  assert.ok(tooFew.errors.some((e) => e.rule === 'precedent.sources'));

  const weakQuote = validateLedger(ledger('ui-new', [fork({ kind: 'precedent', sources: [src('a.dev', '短'), ...three().slice(1)] })]));
  assert.ok(weakQuote.errors.some((e) => /引文少于 12 字符/.test(e.msg)), JSON.stringify(weakQuote.errors));

  const badUrl = validateLedger(ledger('ui-new', [fork({ kind: 'precedent', sources: [{ url: 'beta.design 说的', quote: 'recommended pattern for this' }, ...three().slice(1)] })]));
  assert.ok(badUrl.errors.some((e) => e.rule === 'precedent.sources[0].url'));

  const badAdoption = validateLedger(ledger('ui-new', [fork({ kind: 'precedent', sources: three(), adoption: { repo: 'primer/css', minStars: 0 } })]));
  assert.ok(badAdoption.errors.some((e) => e.rule === 'precedent.adoption.minStars'));

  const selfServing = validateLedger(ledger('ui-new', [fork({ kind: 'precedent', sources: three(), confidence: 0.9 })]));
  assert.ok(selfServing.errors.some((e) => e.rule === 'evidence.field.unknown'));
});

// 真网络只在显式开启时跑：默认 CI 不该依赖外网，也不该把仓库名发出去。
const netOn = process.env.FK_NET === '1';
test('真网络烟测（FK_NET=1 才跑）：GitHub API 的 star 数确实读得到', async (t) => {
  if (!netOn) return t.skip('设 FK_NET=1 才跑，默认不外发');
  const res = await globalThis.fetch('https://api.github.com/repos/primer/css', { signal: AbortSignal.timeout(8000) });
  const info = await res.json();
  assert.equal(res.status, 200);
  assert.ok(Number.isFinite(info.stargazers_count) && info.stargazers_count > 1000, JSON.stringify(info).slice(0, 120));
});
