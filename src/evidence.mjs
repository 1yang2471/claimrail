// 证据回验。这一层就是整个产品的主张所在：模型说"我验证过了"，只有这里能判断真假。
// 所以每个 kind 都必须按"调用方在试图蒙混过关"来写，而不是按"调用方会老实填"。
//
// 五种编造方式，各自要有各自的拦法：
//   repo      引用本次刚写下的代码，冒充"仓库里本来就有这个做法"
//   memory    引用一条不存在（或已错位）的否决记录
//   render    手写一张报告冒充判过；或拿旧图充新检查
//   precedent 编"业界都这么做"：条数凑够但同域转载、引文那页上根本没有、采纳度张口就来
//   web       编一个 URL，或编一个"好评率高"这种没有量纲的数字

import { CHECK_IDS as RENDER_CHECK_IDS } from './observe/check-ids.mjs';

export { RENDER_CHECK_IDS };

const MIN_ASSERT = 3; // 单字符断言等于没断言：整文件里总能找到它
const MAX_REPO_SPAN = 40; // 跨几十行就不是"那一处的做法"，是"这文件里出现过"

const includesAll = (text, asserts = []) =>
  asserts.every((a) => text.toLowerCase().includes(a.toLowerCase()));

function assertShape(asserts) {
  if (!Array.isArray(asserts) || asserts.length === 0) return '没写声称要点，无从回验';
  const weak = asserts.filter((a) => typeof a !== 'string' || a.trim().length < MIN_ASSERT);
  if (weak.length) return `要点太短，出现过任何三个字符都算命中：${weak.join('、')}`;
  return null;
}

function parseRepoRef(ref) {
  const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(ref);
  if (!m) return null;
  const from = Number(m[2]);
  const to = m[3] === undefined ? from : Number(m[3]);
  // 第 0 行会让 slice(-1) 返回文件末尾——曾经能凭它凑出一条不存在的证据
  if (!Number.isFinite(from) || from < 1 || !Number.isFinite(to) || to < from) return null;
  if (to - from + 1 > MAX_REPO_SPAN) return null;
  return { file: m[1], from, to };
}

const basename = (ref) => String(ref).split(/[\\/]/).pop().replace(/\.png$/i, '');

// 业界收敛（precedent）。这一档存在理由是产品的核心主张：AI 不该把"自己见得最多的做法"
// 当成"人类最喜欢的设计"。但它不能靠模型口头宣称——所以两个可核查条件：
//   1. ≥MIN_SOURCES 个独立域名，每个都要回访 200 且原文里真的出现那句引文
//   2. 可选采纳度：GitHub API 的 stargazers_count 是程序读来的数字，不是转述
// 同一篇文章被三个博客转载不算三个来源：按注册域去重。
const MIN_SOURCES = 3;
const MIN_QUOTE = 12;

// 按注册域去重的同一份实现：bench 的"同域转载不算三票"判定也用它，
// 两处各写一份迟早会漂（一处认 www、一处不认，判定就对不上）。
export const registrableDomain = (url) => {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    const parts = host.split('.');
    if (parts.length <= 2) return host;
    // 两段公共后缀（co.uk / com.cn 之类）取三段，粗但够用
    const tail = parts.slice(-2).join('.');
    const twoLevel = ['co.uk', 'com.cn', 'co.jp', 'com.br', 'com.au', 'org.uk', 'ac.cn', 'ne.jp'];
    return twoLevel.includes(tail) ? parts.slice(-3).join('.') : tail;
  } catch {
    return null;
  }
};

const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();

// 引文要对照"页面上看得见的正文"，不是传输字节。真网络实测（2026-11-06，24 个公开设计文档）：
// 能选出引文的 17 个源里 8 个句子被行内标签切开（<abbr>/<strong>/<code>、块级边界），原始 HTML
// 匹配不上；反过来按原始 HTML 匹配，`<script>` 里的字符串也算"页面说过这句话"——那是假绿。
// 两个方向同一个修法：去脚本样式、去标签、解实体。实体解码单独能救的是 0 个，留在这里是为了
// 不把 `&amp;` 当成引文的一部分。
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', middot: '·', times: '×', deg: '°' };
export function visibleText(html) {
  const stripped = String(html)
    .replace(/<(script|style|noscript|template)\b[\s\S]*?(?:<\/\1>|$)/gi, ' ')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<[^>]*>/g, ' ');
  return norm(
    stripped
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
      .replace(/&([a-z]+);/gi, (m, k) => ENTITIES[k.toLowerCase()] ?? m),
  );
}

// 页面到底有没有正文可读。实测 m3.material.io 返回 200 + 62KB HTML，正文只剩 15 字符；
// developer.apple.com 同理只剩 38 字符——设计系统站普遍是 SPA。阈值取 50：真实文档页正文
// 以千字符计，连 50 个字符都没有的"页面"没有可引用的正文。
const VISIBLE_MIN = 50;

async function verifyPrecedent(evidence, ctx) {
  const sources = Array.isArray(evidence.sources) ? evidence.sources : [];
  if (sources.length < MIN_SOURCES) return { ok: false, why: `业界收敛需要 ≥${MIN_SOURCES} 个独立来源，给了 ${sources.length} 个` };

  const hosts = new Set();
  const confirmed = [];
  const problems = [];

  for (const s of sources) {
    const host = registrableDomain(s.url);
    if (!host) {
      problems.push(`URL 不合法：${s.url}`);
      continue;
    }
    hosts.add(host);

    let res = null;
    try {
      res = await ctx.fetch(s.url);
    } catch (err) {
      problems.push(`${s.url} 回访失败：${err.message}`);
      continue;
    }
    if (!res || res.status !== 200) {
      problems.push(`${s.url} 回访 ${res?.status ?? '无响应'}`);
      continue;
    }
    const seen = visibleText(res.text ?? '');
    const needle = norm(s.quote);
    if (needle.length < MIN_QUOTE) {
      problems.push(`${s.url} 的引文太短，不足以证明它真的在说这件事`);
      continue;
    }
    if (!seen.includes(needle)) {
      problems.push(
        seen.length < VISIBLE_MIN
          ? `${s.url} 正文读不到（200 但可见正文只剩 ${seen.length} 字符，多半是 JS 渲染的壳页）——不算编造，这一票不成立`
          : `${s.url} 里找不到那句引文`,
      );
      continue;
    }
    confirmed.push({ host, url: s.url });
  }

  const distinct = new Set(confirmed.map((c) => c.host));
  if (distinct.size < MIN_SOURCES) {
    return { ok: false, why: `只有 ${distinct.size} 个独立域名确认了该说法（需 ≥${MIN_SOURCES}）；问题：${problems.slice(0, 2).join('；') || '其余来源互相同域'}` };
  }

  if (evidence.adoption) {
    const { repo, minStars } = evidence.adoption;
    let res = null;
    try {
      res = await ctx.fetch(`https://api.github.com/repos/${String(repo).replace(/^\/+/, '')}`);
    } catch (err) {
      return { ok: false, why: `采纳度读不到（${repo}）：${err.message}` };
    }
    if (!res || res.status !== 200) return { ok: false, why: `采纳度读不到（${repo} → ${res?.status ?? '无响应'}）` };
    let info;
    try {
      info = JSON.parse(res.text);
    } catch {
      return { ok: false, why: `采纳度返回的不是 JSON（${repo}）` };
    }
    const stars = Number(info?.stargazers_count);
    if (!Number.isFinite(stars)) return { ok: false, why: `${repo} 没有 stargazers_count 字段，采纳度无从核实` };
    if (stars < Number(minStars)) {
      return { ok: false, why: `采纳度不达标：${repo} 实际 ${stars} star，声称门槛 ${minStars}` };
    }
    return { ok: true, why: `${distinct.size} 个独立域名引文核实 + ${repo} 实测 ${stars} star` };
  }

  return { ok: true, why: `${distinct.size} 个独立域名引文核实：${[...distinct].slice(0, 4).join('、')}` };
}

export async function verify(evidence, ctx) {
  if (!evidence) return { ok: false, why: 'evidence 为空' };

  const { kind, ref, asserts = [] } = evidence;

  if (kind === 'precedent') {
    if (!ctx.allowNet) return { ok: false, why: '未获同意，不得外发查询' };
    if (!ctx.fetch) return { ok: false, why: '缺少回访能力，precedent 档无法核实' };
    return verifyPrecedent(evidence, ctx);
  }

  if (kind === 'repo') {
    const weak = assertShape(asserts);
    if (weak) return { ok: false, why: `repo 档${weak}` };

    const loc = parseRepoRef(ref);
    if (!loc) return { ok: false, why: `ref 不可用：${ref}（要 file:line 或 file:from-to，且不超过 ${MAX_REPO_SPAN} 行）` };

    // 先干后证：引用自己这次写的行，不能算"仓库里本来就这么做"
    if (ctx.isChanged && (await ctx.isChanged(loc.file, loc.from, loc.to))) {
      return { ok: false, why: `${ref} 是本次改动新增/修改的行，不是既有做法` };
    }

    const text = await ctx.readRange(loc.file, loc.from, loc.to);
    if (text === null || text === undefined) {
      return { ok: false, why: `${ref} 读不到，文件不存在或行号越界` };
    }
    if (!includesAll(text, asserts)) {
      const miss = asserts.filter((a) => !text.toLowerCase().includes(a.toLowerCase()));
      return { ok: false, why: `${ref} 里没有声称的要点：${miss.join('、')}` };
    }
    return { ok: true, why: `${ref} 已重读确认` };
  }

  if (kind === 'memory') {
    // 只认 log#n：规则的真身份是 r:key，不是行号，接受 rules#n 就等于回验到 log 行
    if (!/^log#\d+$/.test(String(ref))) {
      return { ok: false, why: `memory 档只接受 log#n；规则用 r:key，且它是缓存不是可引用的一次记录` };
    }
    const entry = await ctx.logEntry(ref);
    if (!entry) return { ok: false, why: `${ref} 不存在于 log` };
    const weak = assertShape(asserts);
    if (weak) return { ok: false, why: `memory 档${weak}` };
    if (!includesAll(String(entry), asserts)) return { ok: false, why: `${ref} 内容与声称不符` };
    return { ok: true, why: `${ref} 命中偏好记录` };
  }

  if (kind === 'render') {
    const weak = assertShape(asserts);
    if (weak) return { ok: false, why: `render 档${weak}——只有截图没有断言项，等于说"我看过了"` };

    const st = await ctx.statFile(ref);
    if (!st) return { ok: false, why: `截图不存在：${ref}` };
    if (typeof st.mtimeMs !== 'number') return { ok: false, why: '截图时间戳取不到，无法判断新旧' };
    if (typeof ctx.lastChangeMs !== 'number') {
      return { ok: false, why: '缺少代码改动时间，无法确认截图是新的' };
    }
    if (st.mtimeMs < ctx.lastChangeMs) {
      return { ok: false, why: `截图比代码旧（${st.mtimeMs} < ${ctx.lastChangeMs}）` };
    }

    const report = ctx.readReport ? await ctx.readReport(String(ref).replace(/\.png$/, '.report.json')) : null;
    if (!report || !Array.isArray(report.checks)) return { ok: false, why: '有截图但没有度量报告' };
    if (report.report_schema !== 1) return { ok: false, why: `度量报告版本不对（report_schema=${report.report_schema}）` };
    // name 必须有且必须对得上：缺 name 就当没写——工具自己的产物永远带 name，
    // 所以"没写"只可能是手写报告在绕开这道检查。
    if (report.name !== basename(ref)) {
      return { ok: false, why: `报告 name "${report.name}" 与截图 "${basename(ref)}" 不是同一次采集` };
    }

    // 落盘链的最后一环：报告必须写明它测的是哪张图，截图本体的哈希要能对上。
    // 只靠文件名 + mtime 不够——把同名旧报告换回来、或换一张图，检查照样过。
    if (!report.shot_sha256) {
      return { ok: false, why: '报告没有绑定截图（缺 shot_sha256）：报告与截图不是同一次采集' };
    }
    const actualShot = ctx.shotHash ? await ctx.shotHash(ref) : null;
    if (actualShot !== report.shot_sha256) {
      return { ok: false, why: `截图与报告不是同一次采集（哈希对不上：报告 ${String(report.shot_sha256).slice(0, 12)}，截图 ${String(actualShot).slice(0, 12)}）` };
    }

    const ids = report.checks.map((c) => c.id);
    const bogus = ids.filter((id) => !RENDER_CHECK_IDS.includes(id));
    if (bogus.length) return { ok: false, why: `报告里有未知检查项：${bogus.join('、')}` };
    const missing = RENDER_CHECK_IDS.filter((id) => !ids.includes(id));
    if (missing.length) return { ok: false, why: `报告缺了 ${missing.length} 项检查：${missing.join('、')}` };

    for (const id of asserts) {
      // 台账里写了个不存在的检查项名：这是申报错误，不是"检查没跑完"。
      // 以前这里直接读 c.ok，TypeError 会掉进 check 的兜底 catch，用户看到的是一句
      // 源码级异常，分不清"台账写错了"和"工具坏了"。
      const c = report.checks.find((x) => x.id === id);
      if (!c) return { ok: false, why: `未知检查项「${id}」：报告里没有这一项（可用：${RENDER_CHECK_IDS.join('、')}）` };
      if (c.ok === false) return { ok: false, why: `${id} 判红：${c.detail}` };
      // null 是"未采到/未判"，不许冒充"没问题"
      if (c.ok !== true) return { ok: false, why: `${id} 不作数：${c.detail}` };
    }
    return { ok: true, why: `${ref} 为新增，${asserts.length} 项断言全绿` };
  }

  if (kind === 'web') {
    const weak = assertShape(asserts);
    if (weak) return { ok: false, why: `web 档${weak}` };
    if (!ctx.allowNet) return { ok: false, why: '未获同意，不得外发查询' };
    let res = null;
    try {
      res = await ctx.fetch(ref);
    } catch (err) {
      return { ok: false, why: `回访失败：${err.message}` };
    }
    if (!res || res.status !== 200) return { ok: false, why: `回访失败：${res?.status ?? '无响应'}` };
    const seen = visibleText(res.text ?? '');
    if (!includesAll(seen, asserts)) {
      return { ok: false, why: seen.length < VISIBLE_MIN ? `回访 200 但可见正文只剩 ${seen.length} 字符（多半是 JS 渲染的壳页），要点无从核对` : '来源里没有声称的要点' };
    }
    return { ok: true, why: `${ref} 可回访且含声称要点` };
  }

  return { ok: false, why: `未知 kind：${kind}` };
}

export async function verifyAll(ledger, ctx) {
  const out = [];
  for (const fork of ledger?.forks ?? []) {
    out.push(fork.evidence === null ? { ok: false, why: 'evidence: null' } : await verify(fork.evidence, ctx));
  }
  return out;
}
