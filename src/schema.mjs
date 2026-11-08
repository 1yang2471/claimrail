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

export const EVIDENCE_KINDS = ['repo', 'memory', 'render', 'precedent', 'web'];

// 允许空格与中文路径——"聊天 页面.tsx"这类文件真实存在，正则拒了它等于逼模型
// 写一条假 ref 来凑数，那比误拦更糟。但禁止以 ./ 或 ../ 开头：render 的 ref 会被
// join 到 cwd 之外，配上伪造的 .png + .report.json 就能躲到仓库外面去。
const PATH_BODY = String.raw`(?!\.\.?[\\/])[^:\r\n]+`;

const REF_PATTERNS = {
  repo: new RegExp(`^${PATH_BODY}:\\d+(-\\d+)?$`),
  // 只认 log#n。规则的真身份是 r:key，不是行号；接受 rules#1 的话回验实现只能按
  // 数字去取 log 行——"引用一条规则"就变成了假的。
  memory: /^log#\d+$/,
  render: new RegExp(`^${PATH_BODY}\\.png$`),
  web: /^https?:\/\/\S+$/,
};

// 三档都必须写明声称要点：不给行号、不给出处、只有截图没有断言项，
// 是三种最省事的编造方式——最后一种以前不要求，等于允许"我看过了"当证据。
const ASSERTS_REQUIRED = ['repo', 'render', 'web'];

const MAX_TEXT = 120; // 一屏清单要三秒读完；800 字符的单行"清单"没人读

// 设计类任务：产出形态由人的偏好决定，"最常见"不等于"最好"。
// 这几类不允许用单一网页转述收场（见 checkFork 里的 design-needs-precedent）。
export const DESIGN_CLASSES = ['ui-new', 'docs-new', 'api-design'];

function badText(value) {
  if (typeof value !== 'string' || value.trim() === '') return '必须是非空单行文本';
  if (value.includes('```')) return '禁止内联代码块';
  if (/[\n\r]/.test(value)) return '禁止多行文本';
  if (value.length > MAX_TEXT) return `单行不得超过 ${MAX_TEXT} 字符（长说明写进 PR，不要塞进台账）`;
  return null;
}

// 业界收敛的形状校验。真正能不能算"收敛"由 evidence.verify 回访决定，
// 这里只保证申报本身是可核查的：≥3 个来源、每条带引文、采纳度给门槛。
function checkPrecedent(evidence) {
  const errs = [];
  const sources = evidence.sources;
  if (!Array.isArray(sources) || sources.length < 3) {
    errs.push(['precedent.sources', `precedent 需要 ≥3 个来源（程序会按域名去重后核实），给了 ${Array.isArray(sources) ? sources.length : '无'}`]);
    return errs;
  }
  for (const [i, s] of sources.entries()) {
    if (typeof s !== 'object' || s === null) {
      errs.push([`precedent.sources[${i}]`, '来源必须是 { url, quote }']);
      continue;
    }
    if (!/^https?:\/\/\S+$/.test(String(s.url ?? ''))) errs.push([`precedent.sources[${i}].url`, '来源 URL 不合法']);
    if (typeof s.quote !== 'string' || s.quote.trim().length < 12) {
      errs.push([`precedent.sources[${i}].quote`, '引文少于 12 字符，无法证明那页真的在说这件事']);
    }
  }
  if (evidence.adoption !== undefined) {
    const a = evidence.adoption;
    if (typeof a !== 'object' || a === null || typeof a.repo !== 'string' || !Number.isFinite(Number(a.minStars))) {
      errs.push(['precedent.adoption', 'adoption 需要 { repo: "owner/name", minStars: 数字 }，star 数由 GitHub API 实测']);
    } else if (Number(a.minStars) < 1) {
      errs.push(['precedent.adoption.minStars', '门槛必须 ≥1，填 0 等于没核实']);
    }
  }
  return errs;
}

function checkFork(fork, i, taskClass) {
  const errors = [];
  const at = (rule, msg) => errors.push({ path: `forks[${i}]`, rule, msg });

  if (typeof fork !== 'object' || fork === null) return (at('shape', '必须是对象'), errors);

  const forkErr = badText(fork.fork);
  if (forkErr) at('fork.text', forkErr);

  if (!Array.isArray(fork.options) || fork.options.length < 2) {
    at('options.min', '分叉必须有至少 2 个候选；只有 1 个说明它不是分叉');
  } else {
    // 候选可以是字符串，也可以是 { label, target }——带 target 才能逐候选算代价，
    // 让"无证据却选了更贵的做法"这条规则用程序的数据而不是模型自填的数据判定。
    const labels = [];
    for (const [n, opt] of fork.options.entries()) {
      if (typeof opt === 'string') {
        const err = badText(opt);
        if (err) at(`options[${n}]`, err);
        else labels.push(opt);
        continue;
      }
      if (typeof opt !== 'object' || opt === null) {
        at(`options[${n}].shape`, '候选只能是字符串或 { label, target }');
        continue;
      }
      const err = badText(opt.label ?? '');
      if (err) at(`options[${n}].label`, err);
      else labels.push(opt.label);
      if ('target' in opt) {
        const t = opt.target;
        if (typeof t !== 'object' || t === null || !t.file) {
          at(`options[${n}].target`, 'target 必须是 { file, symbol }');
        } else {
          const te = badText(t.file);
          if (te) at(`options[${n}].target.file`, te);
        }
      }
    }
    if (new Set(labels).size !== labels.length) at('options.distinct', '候选不能重复');
    if (!labels.includes(fork.picked)) at('picked.in-options', 'picked 必须在 options 里');
  }

  if (fork.cost_if_wrong !== 'low' && fork.cost_if_wrong !== 'high') {
    at('cost.two-grade', 'cost_if_wrong 只能 low 或 high');
  }

  // verified 是唯一被接受的自供字段，但它只是申报：程序不读它，判定只看 evidence
  // 的回验结果（test/verified.test.mjs 钉住这条不变量）。这里唯一的约束是
  // "无证据不得声称已验证"——拦的是自相矛盾的台账，不是采信 self-report。
  if (typeof fork.verified !== 'boolean') at('verified.bool', 'verified 必须是布尔');

  const { evidence } = fork;
  if (evidence === null) {
    if (fork.verified === true) at('evidence.null-vs-verified', '无证据不得声称已验证');
  } else if (typeof evidence !== 'object' || evidence === null) {
    at('evidence.shape', 'evidence 必须是 null 或对象');
  } else {
    const ALLOWED_EV = new Set(['kind', 'ref', 'asserts', 'sources', 'adoption']);
    for (const key of Object.keys(evidence)) {
      if (!ALLOWED_EV.has(key)) at('evidence.field.unknown', `evidence 里的未知字段 "${key}" 不被接受：只认 kind/ref/asserts/sources/adoption`);
    }
    // 设计类分叉不许靠单一网页转述收场。这一条是产品主张的直接落实：
    // "业界公认的好做法"必须是多来源收敛，而不是"我搜到一篇文章这么说"。
    if (DESIGN_CLASSES.includes(taskClass) && evidence.kind === 'web') {
      at('evidence.design-needs-precedent', `${taskClass} 是设计类任务：单一网页转述不算依据，要么给仓库既有做法（repo），要么给业界收敛（precedent，≥3 独立域名）`);
    }
    if (!EVIDENCE_KINDS.includes(evidence.kind)) {
      at('evidence.kind', `kind 必须是 ${EVIDENCE_KINDS.join('|')}`);
    } else if (evidence.kind === 'precedent') {
      const errs = checkPrecedent(evidence);
      for (const [rule, msg] of errs) at(rule, msg);
    } else if (!REF_PATTERNS[evidence.kind].test(String(evidence.ref ?? ''))) {
      at('evidence.ref', `${evidence.kind} 的 ref 格式不符：${evidence.ref ?? '(空)'}`);
    }
    if (evidence.kind !== 'precedent') {
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
  }

  // 白名单而不是黑名单：任何"模型自供、程序采信"的字段都是免检通道。
  // options_cost 以前就在这里——第四条门规则的输入居然由被约束的一方填。
  const ALLOWED = new Set(['fork', 'options', 'picked', 'evidence', 'target', 'cost_if_wrong', 'verified']);
  for (const key of Object.keys(fork)) {
    if (!ALLOWED.has(key)) at('field.unknown', `未知字段 "${key}" 不被接受：台账里只许申报下面这些字段，代价与证据都由程序算`);
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

  for (const [i, fork] of ledger.forks.entries()) errors.push(...checkFork(fork, i, ledger.task_class));

  return { ok: errors.length === 0, errors };
}
