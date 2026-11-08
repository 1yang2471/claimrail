// 交付指纹：回答"这次交付有没有新改动"。check 无状态；hook 有状态，记上次放行的快照。
// 快照与违规记录都是本地状态，不进 git（init 已把它们写进 .gitignore）。
import { createHash } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SNAPSHOT_PATH, VIOLATIONS_PATH } from './paths.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');

// 指纹只看"工作"：调用方已经把 .claimrail / AGENTS.md / .gitignore 过滤掉。
// diffText 带上协议文件也无妨——台账变了时 ledgerHash 也会变，不会误判 stale。
export const treeHash = ({ touched = [], diffText = '' }) => sha(JSON.stringify({ touched: [...touched].sort(), diffText }));

export const ledgerHash = (text) => sha(text);

export async function readSnapshot(cwd) {
  try {
    return JSON.parse(await readFile(join(cwd, SNAPSHOT_PATH), 'utf8'));
  } catch {
    return null;
  }
}

export async function writeSnapshot(cwd, snap) {
  await writeFile(join(cwd, SNAPSHOT_PATH), `${JSON.stringify(snap)}\n`, 'utf8');
}

// 只追加，不改写：违规记录是审计线索，不是状态机。
export async function recordViolation(cwd, entry) {
  await appendFile(join(cwd, VIOLATIONS_PATH), `${JSON.stringify(entry)}\n`, 'utf8');
}
