import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { statSync, readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

const run = promisify(execFile);

// Windows 与中文路径：git 默认把非 ASCII 路径八进制转义并加引号，
// 于是 statSync("src/\"346竗…\"") 失败、被 catch 吞掉，扫描和新鲜度双双静默失效。
// 所有调用统一关掉 quotepath，并对列表类输出用 -z 走 NUL 分隔。
const BASE = ['-c', 'core.quotepath=false'];

export async function gitRaw(args, cwd) {
  try {
    const { stdout, stderr } = await run('git', [...BASE, ...args], { cwd, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
    return { code: 0, stdout, stderr };
  } catch (err) {
    if (typeof err?.code === 'number') return { code: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    return { code: -1, stdout: '', stderr: String(err?.message ?? err) };
  }
}

const splitZ = (text) => text.split('\0').filter(Boolean);
const toPosix = (p) => String(p).split(sep).join('/');

// 宿主/代理的运行时状态目录：本机实测（2026-11-11 UX 审查），ZCode 插件每次工具调用都往仓库
// 丢 .mimosa/hook-state/*.json、.mimosa/hook-status/*.json，模型没碰它们。算进"工作区有改动"
// 会让拦截消息列出用户没改的文件，甚至单独触发 stale 假拦截（抢在正文对撞之前）。
//
// 名单只收**实测过**的宿主运行时目录，只有一个：.mimosa。曾经顺手加过 .claude/.cursor 等
// "看起来也是宿主目录"的一串——但那些常被用户**有意跟踪**为配置（`.claude/settings.json`、
// `.cursor/rules/*`），忽略它们等于把真活藏起来，比噪音本身更坏（2026-11-12 审查）。
// 以后要加，先有实测：哪个宿主、往哪个子路径写、写的是不是可丢的运行态。
// `i` 标志：Windows 文件系统大小写不敏感，.Mimosa 与 .mimosa 是同一个目录。
const HOST_NOISE = /(^|\/)(\.mimosa)(\/|$)/i;

// 同一份名单必须贯穿所有消费方：untracked、diff ranges、以及整段 diff 文本
// （treeHash 与副作用扫描读的是 diff 文本，不读 ranges）。只在某一处过滤 = 别处照漏。
const isHostNoise = (p) => HOST_NOISE.test(toPosix(p));

// 从 unified diff 文本里剔掉宿主噪音文件的整块（`diff --git a/X b/Y` 到下一块之前）。
// treeHash 与 effects 扫描都吃这段文本；不剔的话，被跟踪过的宿主状态文件一改，
// 指纹就变、stale 假拦，或副作用扫描拿噪音内容判出 irreversible。
export function stripHostNoiseDiff(diffText) {
  const out = [];
  let skip = false;
  for (const line of String(diffText ?? '').split('\n')) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) skip = isHostNoise(m[1]) || isHostNoise(m[2]);
    if (!skip) out.push(line);
  }
  return out.join('\n');
}

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

// 仓库根。子目录运行时（check 从 pkg/ 下跑、hook 由宿主在任意目录启动）所有路径必须
// 以仓库根为基准——git diff 的键是根相对路径，文件读取也要在同一基准上，否则
// "先干后证"和 repo 证据两条守卫在子目录里一个漏拦、一个误拦（审查实测复现）。
export async function gitToplevel(cwd) {
  const r = await gitRaw(['rev-parse', '--show-toplevel'], cwd);
  if (r.code !== 0) return null;
  const p = r.stdout.trim();
  return p || null;
}

export async function tagPointsAtHead(cwd) {
  const r = await gitRaw(['tag', '--points-at', 'HEAD'], cwd);
  if (r.code !== 0) return null;
  return r.stdout.split('\n').filter(Boolean);
}

// 远端跟踪分支列表（不含 origin/HEAD 这类符号别名）。任何一次 git 读失败都交 null。
async function remoteBranches(cwd, extra = []) {
  const r = await gitRaw(['branch', '-r', ...extra, '--format=%(refname:short)'], cwd);
  if (r.code !== 0) return null;
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.endsWith('/HEAD'));
}

// 远端默认分支在本地跟踪引用里的名字（origin/main）。优先读 <remote>/HEAD 符号引用；
// 读不到时只认"该远端下唯一一个 main/master"——两个都在（历史遗留）就不猜。
// all 是全部远端分支，用来排除指向已删除分支的过期符号引用。
async function defaultRemoteRef(cwd, remote, all) {
  const r = await gitRaw(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`], cwd);
  if (r.code === 0) {
    const name = r.stdout.trim();
    if (name && all.includes(name)) return name;
  }
  const candidates = all.filter((b) => b === `${remote}/main` || b === `${remote}/master`);
  return candidates.length === 1 ? candidates[0] : null;
}

// HEAD 是否已经"发布"到远端默认分支。返回远端分支名（如 origin/main）表示已发布；
// false 表示没有；null 表示读不出来（→ cost high）。
//
// 判据不是"当前分支有没有上游"：`git push origin HEAD:main` 不设置上游，但 HEAD 确实
// 已经在默认分支上。所以直接问 git"哪些远端分支包含 HEAD"——这一步同时覆盖了
// "推了功能分支"（不包含默认分支）、"功能分支已合并"（包含默认分支）、
// "本地领先上游"（没有任何远端分支包含 HEAD）三种形状。
//
// 2026-11-08 收窄：以前任何已推送的提交都算发布，于是"推了个功能分支"也会在理由句里
// 写成「已发布」，把人指去查发布记录。现在只认默认分支。默认分支读不出来、而 HEAD
// 又确实在某个远端分支上时返回 null（→ high），不拿 main/master 硬猜。
export async function headOnRemoteDefault(cwd) {
  const [all, containing] = await Promise.all([remoteBranches(cwd), remoteBranches(cwd, ['--contains', 'HEAD'])]);
  if (all === null || containing === null) return null;
  if (containing.length === 0) return false;

  let unknown = false;
  for (const remote of new Set(containing.map((b) => b.split('/')[0]))) {
    const def = await defaultRemoteRef(cwd, remote, all);
    if (!def) {
      unknown = true;
      continue;
    }
    if (containing.includes(def)) return def;
  }
  return unknown ? null : false;
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
        // 宿主运行时状态不进 ranges：下游的 touched / 审计面 / undeclared 都读这个 Map，
        // 在这里挡住比在每个消费方各挡一次可靠（以前只在 untracked 一路挡，diff 一路漏）。
        file = isHostNoise(h[2]) ? null : h[2];
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

  // 未跟踪：新写的文件根本没进 diff。宿主状态目录（HOST_NOISE）不算工作改动。
  const untracked = [];
  for (const entry of splitZ(statusRes.stdout)) {
    if (!entry.startsWith('??')) continue;
    const p = toPosix(entry.slice(2).split('\0')[0].trim());
    if (p && !isHostNoise(p)) untracked.push(p);
  }

  return { ranges, untracked, renamed: renames.filter((p) => !isHostNoise(p)) };
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
      .filter((p) => !SELF_ARTIFACT.test(p) && !HOST_NOISE.test(p));
  }

  // 删除也是"代码改动"。删文件只更新其父目录的 mtime，被删路径本身 stat 不到，
  // 不补这一类的话"截图之后删了文件"仍算截图是新的——render 新鲜度对删除失明。
  // 状态码 XY 里含 D 的记录即删除；-z 的 rename 第二段（旧路径）没有状态前缀，
  // 不会被 `^(..) ` 匹配到。
  const deleted = [];
  if (st.code === 0) {
    for (const e of splitZ(st.stdout)) {
      const m = /^(..) /.exec(e);
      if (m && m[1].includes('D')) deleted.push(toPosix(e.slice(3)));
    }
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
  for (const p of deleted.filter((p) => !SELF_ARTIFACT.test(p))) {
    try {
      const t = statSync(dirname(join(cwd, p))).mtimeMs;
      if (t > max) max = t;
    } catch {
      /* 父目录也没了：后面还有别的信号兜底 */
    }
  }
  return max || null;
}
