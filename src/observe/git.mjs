import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { statSync } from 'node:fs';
import { join } from 'node:path';

const run = promisify(execFile);

// 区分"命令失败"和"没有匹配"：git grep 无匹配时退出码 1，那是 fanIn = 0，
// 不是取不到值。混为一谈会让每个干净的仓库全部判 high。
export async function gitRaw(args, cwd) {
  try {
    const { stdout, stderr } = await run('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    if (typeof err?.code === 'number') return { code: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    return { code: -1, stdout: '', stderr: String(err?.message ?? err) };
  }
}

export async function tagPointsAtHead(cwd) {
  const r = await gitRaw(['tag', '--points-at', 'HEAD'], cwd);
  if (r.code !== 0) return null;
  return r.stdout.split('\n').filter(Boolean);
}

// HEAD 是否已被某个上游分支包含——已推送就收不回来了
export async function headOnRemote(cwd) {
  const branch = (await gitRaw(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).stdout.trim();
  if (!branch || branch === 'HEAD') return null;

  const up = (await gitRaw(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], cwd)).stdout.trim();
  if (!up) return false; // 从没推过

  const ahead = await gitRaw(['rev-list', '--count', `${up}..HEAD`], cwd);
  if (ahead.code !== 0) return null;
  return Number(ahead.stdout.trim()) === 0;
}

export async function diffAgainstHead(cwd) {
  const r = await gitRaw(['diff', 'HEAD', '--no-color'], cwd);
  return r.code === 0 ? r.stdout : null;
}

function sumCounts(stdout, self) {
  let total = 0;
  for (const line of stdout.split('\n').filter(Boolean)) {
    const idx = line.lastIndexOf(':');
    const file = line.slice(0, idx);
    const n = Number(line.slice(idx + 1));
    if (!Number.isFinite(n)) continue;
    if (self && file.replace(/\\/g, '/') === self.replace(/\\/g, '/')) continue;
    total += n;
  }
  return total;
}

export async function grepCount(term, excludeFile, cwd, { fixed = false } = {}) {
  const args = ['grep', '-w', '-c', ...(fixed ? ['-F'] : []), '-e', term, '--', '.', ...(excludeFile ? [`:(exclude)${excludeFile}`] : [])];
  const r = await gitRaw(args, cwd);
  if (r.code === 1 && r.stdout.trim() === '') return 0; // 干净的零，不是未知
  if (r.code > 1) return null;
  return sumCounts(r.stdout, excludeFile);
}

// 扫一遍跟踪文件的时间戳，用来判断截图是不是新的。
// 仓库大到一定规模就放弃：宁缺，不要为了拿数字卡住整道门。
export async function newestTrackedMtime(cwd, limit = 5000) {
  const r = await gitRaw(['ls-files'], cwd);
  if (r.code !== 0) return null;
  const files = r.stdout.split('\n').filter(Boolean);
  if (files.length === 0 || files.length > limit) return null;

  let max = 0;
  for (const f of files) {
    try {
      const st = statSync(join(cwd, f));
      if (st.mtimeMs > max) max = st.mtimeMs;
    } catch {
      /* 文件被删了：跳过，剩下的时间戳仍是有意义的下界 */
    }
  }
  return max || null;
}
