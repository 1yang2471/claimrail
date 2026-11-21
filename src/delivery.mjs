// 交付指纹：回答"这次交付有没有新改动"。check 无状态；hook 有状态，记上次放行的快照。
// 快照与违规记录都是本地状态，不进 git（init 已把它们写进 .gitignore）。
import { createHash } from 'node:crypto';
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SNAPSHOT_PATH, VIOLATIONS_PATH } from './paths.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');

// 指纹只看"工作"：调用方已经把 .claimrail / AGENTS.md / .gitignore 过滤掉。
// diffText 带上协议文件也无妨——台账变了时 ledgerHash 也会变，不会误判 stale。
export const treeHash = ({ touched = [], diffText = '' }) => sha(JSON.stringify({ touched: [...touched].sort(), diffText }));

export const ledgerHash = (text) => sha(text);

export async function readSnapshot(cwd) {
  let text;
  try {
    text = await readFile(join(cwd, SNAPSHOT_PATH), "utf8");
  } catch {
    return null; // 没有快照是常态（第一次放行之前），不算异常
  }
  try {
    return JSON.parse(text);
  } catch {
    // 存在但解析不了：多半是旧版非原子写留下的半截文件。降级成"没有快照"但不许无声——
    // 抛错会让钩子崩溃、宿主 fail-open，比 stale 失明更糟；喊一声，下次放行时重写自愈。
    process.stderr.write(`claimrail: 交付快照损坏（${SNAPSHOT_PATH}），stale 检查本轮失效；下次放行时重写\n`);
    return null;
  }
}

export async function writeSnapshot(cwd, snap) {
  // 原子写：进程中断留下的半截 JSON 会让 stale 检查静默失明（审查 2026-11-21）。
  // 同卷 tmp + rename；rename 目标是已存在文件时覆盖，是目录时失败（交给 bestEffort）。
  const tmp = `${join(cwd, SNAPSHOT_PATH)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(snap)}\n`, 'utf8');
  await rename(tmp, join(cwd, SNAPSHOT_PATH));
}

// 只追加，不改写：违规记录是审计线索，不是状态机。
export async function recordViolation(cwd, entry) {
  await appendFile(join(cwd, VIOLATIONS_PATH), `${JSON.stringify(entry)}\n`, 'utf8');
}
