import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { append, rules, invalidate, formatRules } from './memory.mjs';

// 偏好闭环的落盘层。log 只追加，规则是缓存，禁用名单单独存。
//
// 这里最贵的一件事是行号：台账里的 `log#n` 是引用坐标，不是数组下标。
// 删一行、插一行、甚至留个空行，都会让已有的引用悄悄指向另一条记录，
// 而且指过去的那条看起来一样合法。所以坏行、坏形状、行号对不上，三种同等严重，一律硬拦。

const LOG_FILE = join('memory', 'log.jsonl');
const DENIED_FILE = join('memory', 'denied.json');
const KINDS = ['rejection', 'anchor'];

function checkShape(parsed, where) {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${LOG_FILE} ${where}不是对象记录`);
  }
  if (typeof parsed.key !== 'string' || !parsed.key) throw new Error(`${LOG_FILE} ${where}缺 key`);
  if (typeof parsed.what !== 'string' || !parsed.what) throw new Error(`${LOG_FILE} ${where}缺 what`);
  if (parsed.kind !== undefined && !KINDS.includes(parsed.kind)) {
    throw new Error(`${LOG_FILE} ${where}的 kind "${parsed.kind}" 不认识，只接受 ${KINDS.join('/')}`);
  }
}

export async function readLog(dir) {
  let text = '';
  try {
    text = await readFile(join(dir, LOG_FILE), 'utf8');
  } catch {
    return [];
  }

  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const out = [];
  for (const [i, line] of lines.entries()) {
    const where = `第 ${i + 1} 行`;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`${LOG_FILE} ${where}不是合法 JSON，log#n 行号会全部错位，请修这一行而不是删掉它`);
    }
    checkShape(parsed, where);

    // 写入时每条都带 at；读回来对不上，说明有人删过行或插过行
    if (parsed.at !== undefined && parsed.at !== i + 1) {
      throw new Error(
        `${LOG_FILE} ${where}自带的编号是 log#${parsed.at}——行号被改动过，台账里已有的 log#n 引用现在指向别的记录。请恢复被删的那行，不要重排`,
      );
    }
    out.push({ ...parsed, kind: parsed.kind ?? 'rejection', at: i + 1 });
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
    if (!Array.isArray(parsed)) throw new Error('不是数组');
    return parsed;
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    // 半截 JSON 会被静默当成"没禁过"，用户当场作废的那条规则就复活了——
    // 这个承诺不能因为文件坏了就消失
    throw new Error(`${DENIED_FILE} 读坏了：${err.message}。它决定哪些规则已被你作废，不能用"没有"兜底`);
  }
}

// 命中两次才升格；升格动的是缓存，不是真相
export async function rulesList(dir) {
  const [entries, denied] = await Promise.all([readLog(dir), readDenied(dir)]);
  return invalidate(rules(entries), denied);
}

export async function record(dir, entry) {
  // kind 放在展开之后：调用方不该能把自己伪装成 anchor 混过升格统计
  const { log, added } = await appendEntry(dir, { ...entry, key: String(entry?.key ?? ''), kind: 'rejection' });
  const hits = log.filter((e) => e.kind === 'rejection' && e.key === added.key).length;
  const list = await rulesList(dir);
  return { n: added.at, hits, promoted: list.find((r) => r.key === added.key) ?? null, rules: list };
}

// 正向参照物：人指认"像这个"比描述规则容易，但它不参与升格
export async function recordAnchor(dir, entry) {
  const { added } = await appendEntry(dir, { ...entry, key: String(entry?.key ?? ''), kind: 'anchor' });
  return { n: added.at };
}

export async function anchors(dir) {
  return (await readLog(dir)).filter((e) => e.kind === 'anchor');
}

// 废规则要落盘：规则每次从 log 重算，不落盘下次又长回来
export async function invalidateRule(dir, keyOrId) {
  const list = await rulesList(dir);
  const hit = list.filter((r) => r.key === keyOrId || r.id === keyOrId);
  if (!hit.length) {
    throw new Error(
      `没有叫 "${keyOrId}" 的现行规则。可能它还没命中满两次（还没升格），也可能已经废过——原始 log 不受影响，用 claimrail rules 看现在生效的`,
    );
  }

  const denied = await readDenied(dir);
  await mkdir(join(dir, 'memory'), { recursive: true });
  await writeFile(join(dir, DENIED_FILE), `${JSON.stringify([...new Set([...denied, ...hit.map((r) => r.key)])], null, 2)}\n`, 'utf8');
  return { removed: hit, remaining: await rulesList(dir) };
}

export async function rulesText(dir) {
  return formatRules(await rulesList(dir));
}
