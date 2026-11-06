// 台账格式。校验器只查结构，不查内容质量——"该不该有更严的约束"由 PRD 决定，
// 这里只保证申报过的东西齐不齐、引用的东西格式对不对得上。
//
// 两条规则是从失败模式反推的，不是从美观反推的：
//   - 两档制，没有 medium：门是二值的，第三档只会变成讨价还价的地方。
//   - 禁止内联代码与多行文本：台账要进 git，而且长说明会让整屏清单没人读。

export const SCHEMA_VERSION = 1;

export const TASK_CLASSES = [
  'ui-new',
  'docs-new',
  'api-design',
  'refactor',
  'bugfix-known-cause',
  'typo',
  'rename',
];

export const EVIDENCE_KINDS = ['repo', 'memory', 'render', 'web'];

const REF_PATTERNS = {
  repo: /^[\w./\\-]+:\d+(-\d+)?$/,
  memory: /^(log|rules|anchor)#\d+$/,
  // 允许 @ 和方括号：截图文件名里 viewport@2x 这种写法太常见，卡掉它只会逼人改名
  render: /^[\w.\-/\\[\]@]+\.png$/,
  web: /^https?:\/\/\S+$/,
};

// 这两档必须去查：声称"参考了现有代码"却不给行号、声称"高分好评"却不给出处，
// 是最省事的两种编造方式。
const ASSERTS_REQUIRED = ['repo', 'web'];

function badText(value) {
  if (typeof value !== 'string' || value.trim() === '') return '必须是非空单行文本';
  if (value.includes('```')) return '禁止内联代码块';
  if (/[\n\r]/.test(value)) return '禁止多行文本';
  return null;
}

function checkFork(fork, i) {
  const errors = [];
  const at = (rule, msg) => errors.push({ path: `forks[${i}]`, rule, msg });

  if (typeof fork !== 'object' || fork === null) return (at('shape', '必须是对象'), errors);

  const forkErr = badText(fork.fork);
  if (forkErr) at('fork.text', forkErr);

  if (!Array.isArray(fork.options) || fork.options.length < 2) {
    at('options.min', '分叉必须有至少 2 个候选；只有 1 个说明它不是分叉');
  } else {
    for (const [n, opt] of fork.options.entries()) {
      const err = badText(opt);
      if (err) at(`options[${n}]`, err);
    }
    if (!fork.options.includes(fork.picked)) at('picked.in-options', 'picked 必须在 options 里');
  }

  if (fork.cost_if_wrong !== 'low' && fork.cost_if_wrong !== 'high') {
    at('cost.two-grade', 'cost_if_wrong 只能 low 或 high');
  }

  if (typeof fork.verified !== 'boolean') at('verified.bool', 'verified 必须是布尔');

  const { evidence } = fork;
  if (evidence === null) {
    if (fork.verified === true) at('evidence.null-vs-verified', '无证据不得声称已验证');
  } else if (typeof evidence !== 'object' || evidence === null) {
    at('evidence.shape', 'evidence 必须是 null 或对象');
  } else {
    if (!EVIDENCE_KINDS.includes(evidence.kind)) {
      at('evidence.kind', `kind 必须是 ${EVIDENCE_KINDS.join('|')}`);
    } else if (!REF_PATTERNS[evidence.kind].test(String(evidence.ref ?? ''))) {
      at('evidence.ref', `${evidence.kind} 的 ref 格式不符：${evidence.ref ?? '(空)'}`);
    }
    const need = ASSERTS_REQUIRED.includes(evidence.kind);
    if (!Array.isArray(evidence.asserts) || evidence.asserts.length === 0) {
      if (need) at('evidence.asserts', `${evidence.kind} 证据必须写明声称要点，否则无从回验`);
    } else {
      for (const [n, a] of evidence.asserts.entries()) {
        const err = badText(a);
        if (err) at(`evidence.asserts[${n}]`, err);
      }
    }
  }

  // 测量对象可缺省。缺省时 fanIn 必然取不到，cost 会判 high——
  // 于是"没有依据的审美分叉"自然会来问人，这正是我们要的行为。
  if ('target' in fork && fork.target !== null && fork.target !== undefined) {
    if (typeof fork.target !== 'object' || Array.isArray(fork.target)) {
      at('target.shape', 'target 必须是 { file, symbol }');
    } else {
      const err = badText(fork.target.file ?? '');
      if (err) at('target.file', `target.file ${err}`);
      if ('symbol' in fork.target) {
        const e2 = badText(fork.target.symbol);
        if (e2) at('target.symbol', `target.symbol ${e2}`);
      }
    }
  }

  if ('options_cost' in fork) {
    const oc = fork.options_cost;
    if (typeof oc !== 'object' || oc === null) at('options_cost.shape', '必须是候选到档位的映射');
    else {
      for (const [opt, grade] of Object.entries(oc)) {
        if (grade !== 'low' && grade !== 'high') at(`options_cost.${opt}`, '档位只能 low 或 high');
      }
    }
  }

  return errors;
}

export function validateLedger(ledger) {
  const errors = [];
  const top = (rule, msg) => errors.push({ path: rule, rule, msg });

  if (typeof ledger !== 'object' || ledger === null) return { ok: false, errors: [{ path: 'ledger', rule: 'shape', msg: '必须是对象' }] };

  if (ledger.schema !== SCHEMA_VERSION) top('schema', `版本必须是 ${SCHEMA_VERSION}，旧台账不得被静默判过`);
  if (!TASK_CLASSES.includes(ledger.task_class)) top('task_class', `必须是 ${TASK_CLASSES.join('|')} 之一`);

  if (!Array.isArray(ledger.forks)) return { ok: false, errors: [...errors, { path: 'forks', rule: 'shape', msg: '必须是数组' }] };

  // 空申报允许，但必须留话——不禁止逃逸，只让逃逸可统计。
  if (ledger.forks.length === 0) {
    const err = badText(ledger.no_fork_reason);
    if (err) top('no_fork_reason', `申报无分叉时必须写明原因：${err ?? ''}`);
  }

  for (const [i, fork] of ledger.forks.entries()) errors.push(...checkFork(fork, i));

  return { ok: errors.length === 0, errors };
}
