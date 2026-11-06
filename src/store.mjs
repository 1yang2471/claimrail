import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { append, rules, invalidate, formatRules } from './memory.mjs';

// 偏好闭环的落盘层。log 只追加，规则是缓存，禁用名单单独存——
// 因为"原始记录不许被任何下游决定改写"，否则 log#n 的行号会被挪动，
// 已经写进台账的证据引用就会指到另一条记录上。

const LOG_FILE = join('memory', 'log.jsonl');
const DENIED_FILE = join('memory', 'denied.json');

// 坏行必须报错，不能跳过：跳一行等于把后面所有 log#n 往前挪一位，
// 台账里引用的证据会安静地指向别的记录，而这正是这套机制唯一在防的事。
export async function readLog(dir) {
  let text = '';
  try {
    text = await readFile(join(dir, LOG_FILE), 'utf8');
  } catch {
    return [];
  }

  const out = [];
  for (const [i, line] of text.split(/\r?\n/).filter((l) => l.trim() !== '').entries()) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`${LOG_FILE} 第 ${i + 1} 行不是合法 JSON，log#n 行号会全部错位，请修这一行而不是删掉它`);
    }
    out.push({ ...parsed, at: i + 1 });
  }
  return out;
}

async function appendEntry(dir, entry) {
  const log = await readLog(dir);
  const next = append(log, entry); // memory.mjs 在这里校验 key/what，缺了就抛
  const added = next[next.length - 1];
  await mkdir(join(dir, 'memory'), { recursive: true });
  await appendFile(join(dir, LOG_FILE), `${JSON.stringify(added)}\n`, 'utf8');
  return { log: next, added };
}

export async function readDenied(dir) {
  try {
    const parsed = JSON.parse(await readFile(join(dir, DENIED_FILE), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// 命中两次才升格，升格的是缓存不是真相
export async function rulesList(dir) {
  const [entries, denied] = await Promise.all([readLog(dir), readDenied(dir)]);
  return invalidate(rules(entries), denied);
}

export async function record(dir, entry) {
  const { log, added } = await appendEntry(dir, { kind: 'rejection', ...entry });
  const hits = log.filter((e) => (e.kind ?? 'rejection') === 'rejection' && e.key === added.key).length;
  const list = await rulesList(dir);
  return {
    n: added.at,
    hits,
    promoted: list.find((r) => r.key === added.key) ?? null,
    rules: list,
  };
}

// 正向参照物：人指认"像这个"比描述规则容易，但它不参与升格
export async function recordAnchor(dir, entry) {
  const { added } = await appendEntry(dir, { kind: 'anchor', ...entry });
  return { n: added.at };
}

export async function anchors(dir) {
  const entries = await readLog(dir);
  return entries.filter((e) => e.kind === 'anchor');
}

// 废规则要落盘：规则是每次从 log 重算出来的，不落盘下次又会长回来
export async function invalidateRule(dir, keyOrId) {
  const list = await rulesList(dir);
  const hit = list.filter((r) => r.key === keyOrId || r.id === keyOrId);
  if (!hit.length) {
    throw new Error(
      `没有叫 "${keyOrId}" 的现行规则。可能它还没命中满两次（还没升格），也可能已经废过——原始 log 不受影响，用 forklight rules 看现在生效的`,
    );
  }

  const denied = await readDenied(dir);
  const keys = hit.map((r) => r.key);
  await mkdir(join(dir, 'memory'), { recursive: true });
  await writeFile(join(dir, DENIED_FILE), `${JSON.stringify([...new Set([...denied, ...keys])], null, 2)}\n`, 'utf8');
  return { removed: hit, remaining: await rulesList(dir) };
}

export async function rulesText(dir) {
  const list = await rulesList(dir);
  return formatRules(list);
}
