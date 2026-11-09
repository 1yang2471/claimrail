import { apply } from './cost.mjs';

// 门。它自己不碰外部世界：代价由 cost 算好、证据由 evidence 回验好，
// 这里只做一件事——把"要不要打断人"和"在哪一刻打断"决定下来，并渲染成一屏。
//
// 四条规则：
//   高代价 + 无证据 → 人在则阻塞，人不在则硬停
//   低代价 + 无证据 → 照做，但必须进末尾汇总，不许静默
//   无证据却选了改起来更贵的候选 → 拦（"静默塌缩到众数"最直接的形状）
//   上一条算不出来 → 不当没事发生，报"规则四未启用"，让逃逸可统计
//
// optionsCosts 只能由程序算（cli 对每个候选各跑一遍 observe）。
// 台账里模型自填的 options_cost 一律不采信：约束的输入不能来自被约束的一方。

const ORDER = { proceed: 0, block: 1, halt: 2 };
const maxAction = (a, b) => (ORDER[a] >= ORDER[b] ? a : b);

const optionLabel = (o) => (typeof o === 'string' ? o : o?.label);
const optionTarget = (o) => (typeof o === 'string' ? null : o?.target ?? null);

export function enrich(ledger, { observations = [], verifications = [], optionsCosts = [] } = {}) {
  return ledger.forks.map((fork, i) => {
    const v = verifications[i] ?? { ok: false, why: '未回验' };
    return {
      fork: fork.fork,
      options: (fork.options ?? []).map(optionLabel),
      targets: (fork.options ?? []).map(optionTarget),
      picked: fork.picked,
      // 申报档位只允许往高走，程序算出来的东西说了算
      cost: apply(fork.cost_if_wrong, observations[i]),
      evidenceOk: Boolean(v.ok),
      evidenceWhy: v.why ?? '未回验',
      // 只接受程序算的那份；缺省就是没有，不做任何兜底
      optionsCost: optionsCosts[i] ?? null,
      // 可点开的位置：优先台账声明的 target，退回本条证据的 file:line。
      // 这条只用于显示，不参与任何判定——判定输入仍然只有程序算出来的那三个值。
      where: locate(fork),
    };
  });
}

// 位置只用来让人能直接跳过去看。拿不到就返回 null，不编一个出来。
function locate(fork) {
  const t = fork?.target;
  if (t?.file) return t.symbol ? `${t.file}:${t.symbol}` : String(t.file);
  const ref = fork?.evidence?.ref;
  if (typeof ref === 'string' && /^[^\s:]+:\d+/.test(ref)) return ref;
  return null;
}

function cheapestCost(optionsCost, options) {
  if (!optionsCost) return null;
  const grades = options.map((o) => optionsCost[o]);
  if (grades.some((g) => !g)) return null; // 候选档位不齐就不判这一条
  return grades.includes('low') ? 'low' : 'high';
}

export function decide(enriched, { humanPresent = true, noForkReason = null } = {}) {
  const questions = [];
  const unverified = [];
  const violations = [];
  const notEnabled = [];
  let action = 'proceed';

  const ask = () => {
    action = maxAction(action, humanPresent ? 'block' : 'halt');
  };

  // 打断数按 enriched 的下标去重，不按分叉文本：两条一字不差的分叉也是两件事
  // （PRD 用户故事 9 拿这个数当中位数指标，按文本去重会低估负担）。
  const interruptIdx = new Set();
  for (const [i, f] of enriched.entries()) {
    if (!f.evidenceOk && f.cost === 'high') {
      questions.push(f);
      interruptIdx.add(i);
      ask();
    } else if (!f.evidenceOk) {
      unverified.push(f);
    }

    if (f.evidenceOk) continue; // 有证据的贵做法是知情决定，不拦

    const cheap = cheapestCost(f.optionsCost, f.options);
    if (cheap === null) {
      // 无证据 + 算不出候选代价：这条规则本轮没起作用，必须留痕而不是静默
      notEnabled.push(f);
      continue;
    }
    if (f.optionsCost[f.picked] !== cheap) {
      violations.push({ ...f, rule: '无证据却选了改起来更贵的候选', cheap });
      interruptIdx.add(i);
      ask();
    }
  }

  const interrupts = interruptIdx.size;

  return {
    action,
    total: enriched.length,
    noForkReason,
    questions,
    unverified,
    violations,
    notEnabled,
    metrics: {
      interrupts,
      unverified: unverified.length,
      violations: violations.length,
      rule4NotEnabled: notEnabled.length,
    },
  };
}

const COST_ORDER = { low: 0, high: 1 };
const byCostDesc = (list) => [...list].sort((a, b) => COST_ORDER[b.cost] - COST_ORDER[a.cost]);

// 一屏。每条固定三行：分叉是什么、候选与已选、凭什么。
// 刻意不做成段落——台账一旦读起来像文档，就再也不会有人打开它。
export function render(decision) {
  const { questions, violations, unverified, notEnabled, total } = decision;
  const out = [];

  if (questions.length) {
    out.push(`【开工前 ${questions.length} 条 · 需你定】`);
    for (const [i, f] of byCostDesc(questions).entries()) {
      // 位置直接挂在标题后面，仍然是三行——多一行就没人读了
      out.push(`  ${i + 1}. ${f.fork}${f.where ? ` · ${f.where}` : ''}`);
      out.push(`     候选 ${f.options.join(' | ')} → 已选 ${f.picked}`);
      out.push(`     代价 ${f.cost} · 凭什么 ${f.evidenceWhy}`);
    }
  }

  if (violations.length) {
    out.push(`【被规则拦住 ${violations.length} 条】`);
    for (const [i, f] of violations.entries()) {
      out.push(`  ${i + 1}. ${f.fork}：${f.rule}（程序算出更便宜的候选是 ${f.cheap}）`);
    }
  }

  if (unverified.length) {
    out.push(`【交付末尾 ${unverified.length} 条未验证 · 均选了容易改回的做法】`);
    for (const f of unverified) out.push(`  • ${f.fork}｜已选 ${f.picked}｜${f.evidenceWhy}`);
  }

  // 逃逸要可见：算不出来不等于没问题，只是这一轮没查
  if (notEnabled.length) {
    out.push(`【规则四未启用 ${notEnabled.length} 条 · 候选代价没算出来】`);
    for (const f of notEnabled) {
      out.push(`  • ${f.fork}｜给每个候选配 target 才能比：${f.options.map((o, i) => `${o}=${f.targets[i] ? '有' : '缺'}`).join(' ')}`);
    }
  }

  // 0 条分叉是"申报无分叉"，不是"所有分叉都有证据"——两者不能共用一句话。
  // 同时把 no_fork_reason 摊出来：reviewer 抽查逃逸靠的就是这个字段（用户故事 18）。
  if (total === 0) {
    out.push(decision.noForkReason ? `【申报无分叉 · ${decision.noForkReason}】` : '【申报无分叉 · 没写原因】');
  } else if (out.length === 0) {
    out.push(`【无需打断 · ${total} 条分叉均有可回验证据】`);
  }

  return out.join('\n');
}
