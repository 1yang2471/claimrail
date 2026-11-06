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

export async function tagPointsAtHead(cwd) {
  const r = await gitRaw(['tag', '--points-at', 'HEAD'], cwd);
  if (r.code !== 0) return null;
  return r.stdout.split('\n').filter(Boolean);
}

// 上游读不出来必须是 null（未知），不能当成"从没推过"。
// 曾经的写法直接读 stdout，配了个不存在的 remote 时输出空串 → false → published 为空 → 判 low。
export async function headOnRemote(cwd) {
  const branchRes = await gitRaw(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (branchRes.code !== 0) return null;
  const branch = branchRes.stdout.trim();
  if (!branch || branch === 'HEAD') return null;

  const up = await gitRaw(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], cwd);
  if (up.code !== 0) {
    const text = `${up.stderr}${up.stdout}`.toLowerCase();
    // "no upstream configured" 才是真的从没推过；其余（坏 remote 配置等）是未知
    return text.includes('no upstream') || text.includes('unknown branch or revision') ? false : null;
  }
  const upstream = up.stdout.trim();
  if (!upstream) return null;

  const ahead = await gitRaw(['rev-list', '--count', `${upstream}..HEAD`], cwd);
  if (ahead.code !== 0) return null;
  const n = Number(ahead.stdout.trim());
  if (!Number.isFinite(n)) return null;
  return n === 0;
}

export async function diffAgainstHead(cwd) {
  const r = await gitRaw(['diff', 'HEAD', '--no-color'], cwd);
  return r.code === 0 ? r.stdout : null;
}

// -U0 只要变更行，行号精确；未跟踪文件不进 diff，必须单列。
export async function changedLines(cwd) {
  const [diffRes, statusRes] = await Promise.all([
    gitRaw(['diff', 'HEAD', '--no-color', '-U0'], cwd),
    gitRaw(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd),
  ]);
  if (diffRes.code !== 0 && diffRes.code !== 1) return null;
  if (statusRes.code !== 0) return null;

  const ranges = new Map();
  if (diffRes.code === 0 || diffRes.stdout) {
    let file = null;
    for (const line of diffRes.stdout.split(/\r?\n/)) {
      const h = /^diff --git a\/.+? b\/(.+)$/.exec(line);
      if (h) {
        file = h[1];
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

  // 未跟踪：新写的文件根本没进 diff，曾经因此既扫不到副作用、也不推后时间戳
  const untracked = [];
  for (const entry of splitZ(statusRes.stdout)) {
    if (!entry.startsWith('??')) continue;
    const p = toPosix(entry.slice(2).split('\0')[0].trim());
    if (p) untracked.push(p);
  }

  return { ranges, untracked };
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
  for (const p of changed?.untracked ?? []) {
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

// 仓库太大就放弃全量扫描：返回 null 让调用方按"未判"处理，
// 而不是拿着半截结果宣布"都比代码新"。
//
// 必须排除 forklight 自己的产物：台账总是在截图之后写，若把它算进"代码改动时间"，
// 每一条 render 证据都会先天"截图比代码旧"，报告层的伪造检查就永远轮不到执行。
const SELF_ARTIFACT = /(^|\/)(\.forklight|memory)(\/|$)/;

export async function newestTrackedMtime(cwd, limit = 5000) {
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
