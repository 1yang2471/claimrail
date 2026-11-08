import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { statSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

const run = promisify(execFile);

// Windows 与中文路径：git 默认把非 ASCII 路径八进制转义并加引号，
// 于是 statSync("src/\"346竗…\"") 失败、被 catch 吞掉，扫描和新鲜度双双静默失效。
// 所有调用统一关掉 quotepath，并对列表类输出用 -z 走 NUL 分隔。
const BASE = ['-c', 'core.quotepath=false'];

export async function gitRaw(args, cwd) {
  try {
    const { stdout, stderr } = await run('git', [...BASE, ...args], { cwd, maxBuffer: 32 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    if (typeof err?.code === 'number') return { code: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    return { code: -1, stdout: '', stderr: String(err?.message ?? err) };
  }
}

const splitZ = (text) => text.split('\0').filter(Boolean);
const toPosix = (p) => String(p).split(sep).join('/');

// 这个目录到底在不在 git 里。用来把"降级模式"与"实测出的高代价"分开：
// 两者在报告里长得一样（都是 high），但一个该去 `git init`，一个该去拆改动。
//
// 三种结果必须分清，不能都叫"不在仓库里"：
//   repo    —— 真在仓库里
//   none    —— 这个目录确实不是仓库（该去 git init）
//   unknown —— git 本身用不了（坏 GIT_DIR、safe.directory、没装 git）：把人指去
//              `git init` 一个本来就是仓库的目录，比不说还坏
// 两条 stderr 实测可分辨：
//   none    → fatal: not a git repository (or any of the parent directories): .git
//   unknown → fatal: not a git repository: '<路径>'   ← 没有括号那句
export async function gitState(cwd) {
  const r = await gitRaw(['rev-parse', '--is-inside-work-tree'], cwd);
  if (r.code === 0) return r.stdout.trim() === 'true' ? 'repo' : 'unknown';
  const text = `${r.stderr}${r.stdout}`.toLowerCase();
  return /not a git repository \(or any of the parent directories\)/.test(text) ? 'none' : 'unknown';
}

export async function tagPointsAtHead(cwd) {
  const r = await gitRaw(['tag', '--points-at', 'HEAD'], cwd);
  if (r.code !== 0) return null;
  return r.stdout.split('\n').filter(Boolean);
}

// 上游读不出来必须是 null（未知），不能当成"从没推过"。
// 曾经的写法直接读 stdout，配了个不存在的 remote 时输出空串 → false → published 为空 → 判 low。
async function currentUpstream(cwd) {
  const branchRes = await gitRaw(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (branchRes.code !== 0) return null;
  const branch = branchRes.stdout.trim();
  if (!branch || branch === 'HEAD') return null;

  const up = await gitRaw(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], cwd);
  if (up.code !== 0) {
    const text = `${up.stderr}${up.stdout}`.toLowerCase();
    // "no upstream configured" 才是真的从没推过；其余（坏 remote 配置等）是未知
    return text.includes('no upstream') || text.includes('unknown branch or revision')
      ? { branch, upstream: null }
      : null;
  }
  const upstream = up.stdout.trim();
  if (!upstream) return null;
  return { branch, upstream };
}

// 远端默认分支在本地跟踪引用里的名字（origin/main）。优先读 <remote>/HEAD 符号引用；
// 读不到就交 null——调用方据此返回"未知"，不拿 main/master 硬套。
async function defaultRemoteRef(cwd, remote) {
  const r = await gitRaw(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`], cwd);
  if (r.code !== 0) return null;
  const name = r.stdout.trim();
  return name || null;
}

// HEAD 是否已经"发布"到远端默认分支。返回上游名（如 origin/main）表示已发布；
// false 表示没有；null 表示读不出来（→ cost high）。
//
// 2026-11-08 收窄：以前任何已推送的提交都算发布，于是"推了个功能分支"也会在理由句里
// 写成「已发布」，把人指去查发布记录。现在只认默认分支——包括已合并进默认分支的提交
// （只看上游是不是默认分支会漏掉这一种）。默认分支读不出来时：
//   - 当前分支是 main/master 且上游就是 <remote>/<同名>：按已发布处理（最常见形状）
//   - 其余：返回 null，交 high 保守处理，不猜
export async function headOnRemoteDefault(cwd) {
  const cur = await currentUpstream(cwd);
  if (!cur) return null;
  if (!cur.upstream) return false;

  const ahead = await gitRaw(['rev-list', '--count', `${cur.upstream}..HEAD`], cwd);
  if (ahead.code !== 0) return null;
  const n = Number(ahead.stdout.trim());
  if (!Number.isFinite(n)) return null;
  if (n !== 0) return false; // 本地领先上游：HEAD 本身没推上去

  const remote = cur.upstream.split('/')[0];
  const def = await defaultRemoteRef(cwd, remote);
  if (def) {
    const anc = await gitRaw(['merge-base', '--is-ancestor', 'HEAD', def], cwd);
    if (anc.code === 0) return def;
    if (anc.code === 1) return false;
    return null;
  }
  if ((cur.branch === 'main' || cur.branch === 'master') && cur.upstream === `${remote}/${cur.branch}`) {
    return cur.upstream;
  }
  return null;
}

// baseline 由 init 记录。没有它，"先把改动 commit 掉再 check"就能让
// `git diff HEAD` 输出空串，副作用扫描与档位计算双双失明——审查报告点名的绕道之二。
export async function resolveRef(cwd, ref) {
  if (!ref) return null;
  const r = await gitRaw(['rev-parse', '--verify', `${ref}^{commit}`], cwd);
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function diffSince(cwd, base) {
  const args = base ? ['diff', base, '--no-color'] : ['diff', 'HEAD', '--no-color'];
  const r = await gitRaw(args, cwd);
  return r.code === 0 || r.code === 1 ? r.stdout : null;
}

// 纯 rename / copy 在 diff 里可能一行内容都不带（similarity 100%）。
// 把 docs/ 里的删库脚本搬进 src/ 就该被当成"开始会被执行的东西"来扫，
// 所以这些落地路径的全文要并进扫描对象。是否豁免交给 effects 的 ignore 判定。
async function renamedTargets(cwd, base) {
  const args = ['diff', '--name-status', '-M', '-C', base ?? 'HEAD'];
  const r = await gitRaw(args, cwd);
  if (r.code !== 0 && r.code !== 1) return [];
  const out = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^(R|C)\d*\t(.+?)\t(.+)$/.exec(line.trim());
    if (m) out.push(toPosix(m[3]));
  }
  return [...new Set(out)];
}

// -U0 只要变更行，行号精确；未跟踪文件不进 diff，必须单列。
export async function changedLines(cwd, base = null) {
  const diffArgs = base ? ['diff', base, '--no-color', '-U0'] : ['diff', 'HEAD', '--no-color', '-U0'];
  const [diffRes, statusRes, renames] = await Promise.all([
    gitRaw(diffArgs, cwd),
    gitRaw(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd),
    renamedTargets(cwd, base),
  ]);
  if (diffRes.code !== 0 && diffRes.code !== 1) return null;
  if (statusRes.code !== 0) return null;

  const ranges = new Map();
  if (diffRes.code === 0 || diffRes.stdout) {
    let file = null;
    for (const line of diffRes.stdout.split(/\r?\n/)) {
      const h = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (h) {
        file = h[2];
        continue;
      }
      const at = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (at && file) {
        const from = Number(at[1]);
        const count = at[2] === undefined ? 1 : Number(at[2]);
        if (!ranges.has(file)) ranges.set(file, []);
        ranges.get(file).push([from, from + Math.max(count - 1, 0)]);
      }
    }
  }

  // 未跟踪：新写的文件根本没进 diff
  const untracked = [];
  for (const entry of splitZ(statusRes.stdout)) {
    if (!entry.startsWith('??')) continue;
    const p = toPosix(entry.slice(2).split('\0')[0].trim());
    if (p) untracked.push(p);
  }

  return { ranges, untracked, renamed: renames };
}

export const isChangedLine = (changed, file, from, to) => {
  if (!changed) return false;
  const f = toPosix(file);
  if (changed.untracked.includes(f)) return true;
  for (const [a, b] of changed.ranges.get(f) ?? []) {
    if (from <= b && to >= a) return true;
  }
  return false;
};

const MAX_SCAN_BYTES = 4 * 1024 * 1024;

// 交给副作用扫描的文本 = 本次新增行 + 未跟踪文件全文。
// 未跟踪文件是真正会被执行的东西，不能因为没 git add 就当它不存在。
export function worktreeScanText(diffText, changed, cwd) {
  let text = String(diffText ?? '');
  let budget = MAX_SCAN_BYTES;
  // 未跟踪的新文件 + 纯 rename/copy 的落地文件：两者都不带在 diff 的新增行里，
  // 却都是真正会被执行的东西
  for (const p of [...(changed?.untracked ?? []), ...(changed?.renamed ?? [])]) {
    if (budget <= 0) break;
    try {
      const body = readFileSync(join(cwd, p), 'utf8').slice(0, budget);
      budget -= body.length;
      text += `\ndiff --git a/${p} b/${p}\n@@\n+${body.split(/\r?\n/).join('\n+')}\n`;
    } catch {
      /* 读不到就少扫一个文件：宁可漏检，也不要让整道门崩掉 */
    }
  }
  return text;
}

function sumCounts(stdout, self) {
  let total = 0;
  for (const line of stdout.split('\n').filter(Boolean)) {
    const idx = line.lastIndexOf(':');
    const file = line.slice(0, idx);
    const n = Number(line.slice(idx + 1));
    if (!Number.isFinite(n)) continue;
    if (self && toPosix(file) === toPosix(self)) continue;
    total += n;
  }
  return total;
}

// 退出码归类必须是可测的纯函数。曾经的写法是 `if (code > 1) return null`，
// 于是 git 不存在（spawn 失败，我们标成 -1）漏进 fall-through，
// 被当成"0 处引用"——读不到降级成乐观值，门就从这里开。
export function mapGrepExit(code, stdout) {
  if (code === 0) return 'matches';
  if (code === 1 && String(stdout ?? '').trim() === '') return 'none';
  // 128 不在仓库、-1 缺 git 或启动失败、2/3 pathspec 报错、1 却有输出=异常
  return 'unknown';
}

export async function grepCount(term, excludeFile, cwd, { fixed = false } = {}) {
  const args = ['grep', '-w', '-c', ...(fixed ? ['-F'] : []), '-e', term, '--', '.', ...(excludeFile ? [`:(exclude)${toPosix(excludeFile)}`] : [])];
  const r = await gitRaw(args, cwd);
  const kind = mapGrepExit(r.code, r.stdout);
  if (kind === 'none') return 0;
  if (kind === 'unknown') return null;
  return sumCounts(r.stdout, excludeFile);
}

// 文件级 fan-in 必须认相对写法。调用方写的是 `import { helper } from './helper.mjs'`，
// 而 target 给的是仓库相对路径 `src/helper.mjs`——拿后者做精确匹配，实测被三处 import
// 的文件会算成"0 处引用"，于是代价判 low、不覆写、不打断。
// 三种写法一起数：仓库相对路径、`./名字`、以及单独的名字（同一条 git grep 里多给 -e，
// 一行命中多次只算一次）。
export async function fileRefs(file, cwd) {
  const posix = toPosix(file);
  const base = posix.split('/').pop();
  const r = await gitRaw([
    'grep', '-w', '-c', '-F',
    '-e', posix,
    '-e', `./${base}`,
    '-e', base,
    '--', '.', `:(exclude)${posix}`,
  ], cwd);
  const kind = mapGrepExit(r.code, r.stdout);
  if (kind === 'none') return 0;
  if (kind === 'unknown') return null;
  return sumCounts(r.stdout, posix);
}

// 测量对象本身必须先成立。target 是模型填的，指向不存在的东西时"0 处引用"是假零——
// 而 fanIn 正是便宜/贵的输入之一。返回 false 表示"这个测量对象不成立"，
// 调用方按 null（→ high）处理，绝不按 0。
export async function targetResolves(target, cwd) {
  const file = target?.file;
  if (!file) return true; // 只给 symbol 的情况交给 grep 自己判
  const posix = toPosix(file);
  const tracked = await gitRaw(['ls-files', '--error-unmatch', '--', posix], cwd);
  if (tracked.code !== 0) {
    // 未跟踪不等于不存在：刚建的文件本来就没进索引
    try {
      statSync(join(cwd, file));
    } catch {
      return false;
    }
  }
  if (!target?.symbol) return true;
  const hit = await gitRaw(['grep', '-w', '-c', '-e', target.symbol, '--', posix], cwd);
  return hit.code === 0; // 文件里根本没这个符号 → 测量对象不成立
}

// 仓库大到某个程度就放弃全量扫描：返回 null 让调用方按"未判"处理，
// 而不是拿着半截结果宣布"都比代码新"。
//
// 上限原先是 5000，实测把它变成了一个纯损失：6000 个文件全部 stat 只要 148ms
// （2026-11-08 实测，Windows + NTFS），而 5000 的门槛会让任何正常 monorepo
// 的 render 证据一次性全失效。现在抬到 200000——它只用来挡住"误把整个 home
// 目录当仓库"这类异常情况，不再对真实项目生效。
//
// 必须排除 claimrail 自己的产物：台账总是在截图之后写，若把它算进"代码改动时间"，
// 每一条 render 证据都会先天"截图比代码旧"，报告层的伪造检查就永远轮不到执行。
const SELF_ARTIFACT = /(^|\/)(\.claimrail|memory)(\/|$)/;

export async function newestTrackedMtime(cwd, limit = 200_000) {
  const r = await gitRaw(['ls-files', '-z'], cwd);
  if (r.code !== 0) return null;
  const tracked = splitZ(r.stdout).filter((p) => !SELF_ARTIFACT.test(toPosix(p)));
  if (tracked.length === 0 || tracked.length > limit) return null;

  let untracked = [];
  const st = await gitRaw(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd);
  if (st.code === 0) {
    untracked = splitZ(st.stdout)
      .filter((e) => e.startsWith('??'))
      .map((e) => toPosix(e.slice(2).trim()))
      .filter((p) => !SELF_ARTIFACT.test(p));
  }

  let max = 0;
  for (const f of [...tracked, ...untracked]) {
    try {
      const t = statSync(join(cwd, f)).mtimeMs;
      if (t > max) max = t;
    } catch {
      /* 已删除：剩下的时间戳仍是有意义的下界 */
    }
  }
  return max || null;
}
