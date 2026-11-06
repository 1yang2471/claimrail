// 证据回验。全部通过注入的 ctx 完成，所以这一层不依赖网络、文件系统或浏览器，
// 时间也由外部给出——"截图必须比代码新"这种规则才能用假时钟测。
//
// 四种 kind 分别回验，是因为它们各自的编造方式不同：
//   repo   声称"参考了现有代码"但不给行号，或给了行号但那不是这个意思
//   memory 引用一条不存在的否决记录
//   render 拿旧图充新检查
//   web    编一个 URL，或编一个"好评率高"

const includesAll = (text, asserts = []) =>
  asserts.every((a) => text.toLowerCase().includes(a.toLowerCase()));

function parseRepoRef(ref) {
  const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(ref);
  if (!m) return null;
  return { file: m[1], from: Number(m[2]), to: Number(m[3] ?? m[2]) };
}

export async function verify(evidence, ctx) {
  if (!evidence) return { ok: false, why: 'evidence 为空' };

  const { kind, ref, asserts = [] } = evidence;

  if (kind === 'repo') {
    const loc = parseRepoRef(ref);
    if (!loc) return { ok: false, why: `ref 解析失败：${ref}` };
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
    const entry = await ctx.logEntry(ref);
    if (!entry) return { ok: false, why: `${ref} 不存在于 log` };
    if (!includesAll(String(entry), asserts)) return { ok: false, why: `${ref} 内容与声称不符` };
    return { ok: true, why: `${ref} 命中偏好记录` };
  }

  if (kind === 'render') {
    const st = await ctx.statFile(ref);
    if (!st) return { ok: false, why: `截图不存在：${ref}` };
    if (typeof ctx.lastChangeMs !== 'number') {
      return { ok: false, why: '缺少代码改动时间，无法确认截图是新的' };
    }
    if (st.mtimeMs < ctx.lastChangeMs) {
      return { ok: false, why: `截图比代码旧（${st.mtimeMs} < ${ctx.lastChangeMs}）` };
    }
    return { ok: true, why: `${ref} 晚于最后一次代码改动` };
  }

  if (kind === 'web') {
    if (!ctx.allowNet) return { ok: false, why: '未获同意，不得外发查询' };
    const res = await ctx.fetch(ref);
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
