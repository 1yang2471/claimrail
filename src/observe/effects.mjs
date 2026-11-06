// irreversible 的判定：扫描改动里有没有收不回来的动作。
//
// 规则表刻意做窄。不收普通的 POST / fetch 调用，因为任何业务代码都会命中，
// 而误拦一次的代价比漏拦一次高——一次误拦就教会用户无视整屏清单。
// 只收那些"看一眼就知道回不去"的命令形状。

const RULES = [
  { kind: 'recursive-delete', re: /\brm\s+-(?:[a-z]*[rf][a-z]*|r\s+-f)\b|rmdir\s+\/s|Remove-Item\b[\s\S]{0,80}-Recurse|\bshutil\.rmtree\b|fs\.rmSync\([\s\S]{0,60}recursive:\s*true|deleteDir\b/i },
  { kind: 'file-delete', re: /\bos\.remove\b|\bunlink\(|\bfs\.unlink|\.rm\(-Rf|rimraf\b/i },
  { kind: 'sql-destructive', re: /\bDROP\s+(TABLE|COLUMN|DATABASE|SCHEMA)\b|\bTRUNCATE\s+TABLE\b|\bDELETE\s+FROM\b/i },
  { kind: 'migration', re: /\bdb:migrate\b|prisma\s+migrate|alembic\s+upgrade|rails\s+db:migrate|knex\s+migrate|flyway\s+migrate/i },
  { kind: 'history-rewrite', re: /git\s+push\b[^\n]*(--force|-f\b)|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f/i },
  { kind: 'publish', re: /npm\s+publish|pnpm\s+publish|cargo\s+publish|twine\s+upload|docker\s+push|gh\s+release\s+create/i },
  { kind: 'deploy', re: /vercel\s+--prod|wrangler\s+deploy|netlify\s+deploy|kubectl\s+apply|terraform\s+apply|helm\s+upgrade|rsync\b[^\n]*--delete/i },
];

export function scanEffects(text) {
  if (typeof text !== 'string' || text === '') return [];
  const kinds = [];
  for (const rule of RULES) {
    if (rule.re.test(text)) kinds.push(rule.kind);
  }
  return kinds;
}

// 扫描对象必须是"真正会被执行的新增行"。扫全文会把自己扫出来：规则表和测试数据里
// 的 rm -rf 样例都是文本，不是动作——那种扫描任何改动都会判 high，门第一天就失灵。
const SELF_IGNORE = [
  /(^|\/)tests?(\/|$)/,
  /(^|\/)fixtures(\/|$)/,
  /(^|\/)docs(\/|$)/,
  /\.test\.[cm]?js$/,
  /(^|\/)src\/observe\/effects\.mjs$/,
];

export function addedCode(diffText, ignore = SELF_IGNORE) {
  if (typeof diffText !== 'string' || diffText === '') return '';

  const kept = [];
  let current = null;
  let skipping = false;

  for (const line of diffText.split(/\r?\n/)) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      const paths = [header[1], header[2]];
      skipping = paths.some((p) => ignore.some((re) => re.test(p)));
      current = skipping ? null : { path: header[2], lines: [] };
      if (current) kept.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) current.lines.push(line.slice(1));
  }

  return kept.map((f) => `${f.path}\n${f.lines.join('\n')}`).join('\n\n');
}


// 供文档与错误信息使用；不是判断逻辑
export const EFFECT_KINDS = RULES.map((r) => r.kind);
