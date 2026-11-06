// 证据回验。这一层就是整个产品的主张所在：模型说"我验证过了"，只有这里能判断真假。
// 所以每个 kind 都必须按"调用方在试图蒙混过关"来写，而不是按"调用方会老实填"。
//
// 四种编造方式，各自要有各自的拦法：
//   repo   引用本次刚写下的代码，冒充"仓库里本来就有这个做法"
//   memory 引用一条不存在（或已错位）的否决记录
//   render 手写一张报告冒充判过；或拿旧图充新检查
//   web    编一个 URL，或编一个"好评率高"这种没有量纲的数字

// 与 observe/geometry.mjs 的 CHECK_IDS 同集合。写两遍是有意的：evidence 不该依赖
// 浏览器层，否则纯逻辑测试要拖进 Playwright。test/redteam.test.mjs 钉住两边一致。
export const RENDER_CHECK_IDS = [
  'scrollbar-clears-text',
  'touch-targets-ok',
  'contrast-ok',
  'focus-visible-ok',
  'bottom-not-covered',
];

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

export async function verify(evidence, ctx) {
  if (!evidence) return { ok: false, why: 'evidence 为空' };

  const { kind, ref, asserts = [] } = evidence;

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
    if (report.name !== undefined && report.name !== basename(ref)) {
      return { ok: false, why: `报告 name "${report.name}" 与截图 "${basename(ref)}" 不是同一次采集` };
    }

    const ids = report.checks.map((c) => c.id);
    const bogus = ids.filter((id) => !RENDER_CHECK_IDS.includes(id));
    if (bogus.length) return { ok: false, why: `报告里有未知检查项：${bogus.join('、')}` };
    const missing = RENDER_CHECK_IDS.filter((id) => !ids.includes(id));
    if (missing.length) return { ok: false, why: `报告缺了 ${missing.length} 项检查：${missing.join('、')}` };

    for (const id of asserts) {
      const c = report.checks.find((x) => x.id === id);
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
    if (!includesAll(String(res.text ?? ''), asserts)) {
      return { ok: false, why: '来源里没有声称的要点' };
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
