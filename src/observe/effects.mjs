// irreversible 的判定：扫描改动里有没有收不回来的动作。
//
// 规则表刻意做窄。不收普通的 POST / fetch 调用，因为任何业务代码都会命中，
// 而误拦一次的代价比漏拦一次高——一次误拦就教会用户无视整屏清单。
// 只收那些"看一眼就知道回不去"的命令形状。

const RULES = [
  { kind: 'recursive-delete', re: /(?<!git )\brm\s+-(?:[a-z]*[rf][a-z]*|r\s+-f)\b|rmdir\s+\/s|Remove-Item\b[\s\S]{0,80}-Recurse|\bshutil\.rmtree\b|fs\.rmSync\([\s\S]{0,60}recursive:\s*true|deleteDir\b/i },
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
// 台账和 memory 也在豁免之列：诚实写出"要不要 rm -rf 旧缓存"的分叉曾被扫成
// recursive-delete 强制升 high，等于惩罚申报本身。
const SELF_IGNORE = [
  /(^|\/)tests?(\/|$)/,
  /(^|\/)fixtures(\/|$)/,
  /(^|\/)docs(\/|$)/,
  /(^|\/)\.claimrail(\/|$)/,
  /(^|\/)memory(\/|$)/,
  /(^|\/)(README|AGENTS)\.md$/,
  /\.test\.[cm]?js$/,
  /(^|\/)src\/observe\/effects\.mjs$/,
  // bench/classify.mjs 里写的是"陷阱判定规则"（含删除字样），同样是规则表不是动作。
  // 2026-11-08 实测：往它加一条规则，文本里的 rm -rf 就把本次所有分叉升成 high。
  /(^|\/)bench\/classify\.mjs$/,
  // bench 的任务夹具里故意放着"要删缓存"这类分叉描述，用来测代价模型；
  // 它们是语料，不是会被执行的脚本。
  /(^|\/)bench\/tasks\/.*\/agent\.json$/,
];

// 逐文件返回新增行。返回数组而不是拼好的字符串，是为了让 scanDiff 能按文件边界扫描：
// 拼成一整段以后，跨文件的正则窗口会把"一个 Remove-Item"和"另一个文件里孤零零的
// -Recurse"缝成一条 recursive-delete 命令，实测误报。
export function addedCode(diffText, ignore = SELF_IGNORE) {
  if (typeof diffText !== 'string' || diffText === '') return [];

  const kept = [];
  let current = null;

  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (!header) {
        // 认不出来的 header（git 对非 ASCII 路径的八进制引号形态）：整段当没有归属。
        // 塞给上一个文件会让 ignore 判定与 kind 归属一起错位。
        current = null;
        continue;
      }
      // 只看落地路径：把脚本从 docs/ 搬进 src/ 是"开始会被执行"，
      // 按来源路径豁免就等于给它开了免检。
      const skip = ignore.some((re) => re.test(header[2]));
      current = skip ? null : { path: header[2], lines: [] };
      if (current) kept.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) current.lines.push(line.slice(1));
  }

  return kept.filter((f) => f.lines.length > 0);
}

// 按文件逐个扫描，再合并 kind
export function scanDiff(diffText, ignore = SELF_IGNORE) {
  const kinds = new Set();
  for (const file of addedCode(diffText, ignore)) {
    for (const k of scanEffects(file.lines.join('\n'))) kinds.add(k);
  }
  return [...kinds];
}

// 供文档与错误信息使用；不是判断逻辑
export const EFFECT_KINDS = RULES.map((r) => r.kind);
