import { apply } from './cost.mjs';

// 门。它自己不碰外部世界：代价由 cost 算好、证据由 evidence 回验好，
// 这里只做一件事——把"要不要打断人"和"在哪一刻打断"决定下来，并渲染成一屏。
//
// 三条规则全部来自 PRD，不接受任何自评输入：
//   高代价 + 无证据 → 人在则阻塞，人不在则硬停
//   低代价 + 无证据 → 照做，但必须进末尾汇总，不许静默
//   无证据却选了改起来更贵的候选 → 这是"静默塌缩到众数"最典型的形状，拦住

const ORDER = { proceed: 0, block: 1, halt: 2 };
const maxAction = (a, b) => (ORDER[a] >= ORDER[b] ? a : b);

export function enrich(ledger, { observations = [], verifications = [] } = {}) {
  return ledger.forks.map((fork, i) => {
    const v = verifications[i] ?? { ok: false, why: '未回验' };
    return {
      fork: fork.fork,
      options: fork.options,
      picked: fork.picked,
      // 申报档位只允许往高走，程序算出来的东西说了算
      cost: apply(fork.cost_if_wrong, observations[i]),
      evidenceOk: Boolean(v.ok),
      evidenceWhy: v.why,
      optionsCost: fork.options_cost ?? null,
    };
  });
}

// 候选档位不齐就不判这一条——误拦一次的代价比漏拦一次高。
function cheapest(optionsCost, options) {
  if (!optionsCost) return null;
  const grades = options.map((o) => optionsCost[o]);
  if (grades.some((g) => !g)) return null;
  return grades.includes('low') ? 'low' : 'high';
}

export function decide(enriched, { humanPresent = true } = {}) {
  const questions = [];
  const unverified = [];
  const violations = [];
  let action = 'proceed';

  const ask = () => {
    action = maxAction(action, humanPresent ? 'block' : 'halt');
  };

  for (const f of enriched) {
    if (!f.evidenceOk && f.cost === 'high') {
      questions.push(f);
      ask();
    } else if (!f.evidenceOk) {
      unverified.push(f);
    }

    const cheap = cheapest(f.optionsCost, f.options);
    if (!f.evidenceOk && cheap && f.optionsCost[f.picked] !== cheap) {
      violations.push({ ...f, rule: '无证据却选了改起来更贵的候选', cheap });
      ask();
    }
  }

  const interrupts = new Set([...questions, ...violations].map((f) => f.fork)).size;

  return {
    action,
    total: enriched.length,
    questions,
    unverified,
    violations,
    metrics: { interrupts, unverified: unverified.length, violations: violations.length },
  };
}

const ORDER_COST = { low: 0, high: 1 };
const byCostDesc = (list) => [...list].sort((a, b) => ORDER_COST[b.cost] - ORDER_COST[a.cost]);

// 一屏。每条固定三行：分叉是什么、候选与已选、凭什么。
// 刻意不做成段落——台账一旦读起来像文档，就再也不会有人打开它。
export function render(decision) {
  const { questions, violations, unverified, total } = decision;
  const out = [];

  if (questions.length) {
    out.push(`【开工前 ${questions.length} 条 · 需你定】`);
    for (const [i, f] of byCostDesc(questions).entries()) {
      out.push(`  ${i + 1}. ${f.fork}`);
      out.push(`     候选 ${f.options.join(' | ')} → 已选 ${f.picked}`);
      out.push(`     代价 ${f.cost} · 凭什么 ${f.evidenceWhy}`);
    }
  }

  if (violations.length) {
    out.push(`【被规则拦住 ${violations.length} 条】`);
    for (const [i, f] of violations.entries()) {
      out.push(`  ${i + 1}. ${f.fork}：${f.rule}（更便宜的候选是 ${f.cheap}）`);
    }
  }

  if (unverified.length) {
    out.push(`【交付末尾 ${unverified.length} 条未验证 · 均选了容易改回的做法】`);
    for (const f of unverified) out.push(`  • ${f.fork}｜已选 ${f.picked}｜${f.evidenceWhy}`);
  }

  if (!out.length) out.push(`【无需打断 · ${total} 条分叉均有可回验证据】`);

  return out.join('\n');
}
