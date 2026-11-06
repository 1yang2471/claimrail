#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateLedger, SCHEMA_VERSION } from './schema.mjs';
import { grade } from './cost.mjs';
import { verifyAll } from './evidence.mjs';
import { enrich, decide, render } from './gate.mjs';
import { observe, whyUnknown } from './observe/index.mjs';
import { newestTrackedMtime, diffAgainstHead } from './observe/git.mjs';

export const LEDGER_PATH = join('.forklight', 'decisions.json');
export const LOG_PATH = join('memory', 'log.jsonl');

const NOTICE = `数据去向：
  .forklight/decisions.json  进 git（它是给你 review 的东西）
  memory/                    不进 git（个人偏好，只在你机器上）
  *.png 截图                 不进 git（真实产品画面）`;

const TEMPLATE = {
  schema: SCHEMA_VERSION,
  task_class: 'ui-new',
  forks: [],
  no_fork_reason: '把本行改成"为什么这次没有分叉"，或者填 forks',
};

async function readJson(path) {
  try {
    return { ok: true, value: JSON.parse(await readFile(path, 'utf8')) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function init({ cwd = process.cwd() } = {}) {
  await mkdir(join(cwd, '.forklight'), { recursive: true });
  const file = join(cwd, LEDGER_PATH);
  const created = !existsSync(file);
  if (created) await writeFile(file, `${JSON.stringify(TEMPLATE, null, 2)}\n`, 'utf8');

  const gi = join(cwd, '.gitignore');
  const lines = existsSync(gi) ? (await readFile(gi, 'utf8')).split('\n') : [];
  const add = ['memory/', '.forklight/shots/', '*.png'].filter((p) => !lines.includes(p));
  if (add.length) await writeFile(gi, `${lines.join('\n').replace(/\n*$/, '')}\n${add.join('\n')}\n`, 'utf8');

  return { code: 0, text: `${created ? '已建' : '已存在，不动'} ${LEDGER_PATH}\n补进 .gitignore：${add.join('、') || '（无新增）'}\n\n${NOTICE}` };
}

function makeCtx({ cwd, allowNet }) {
  return {
    allowNet,
    lastChangeMs: undefined, // 下面异步补
    readRange: async (file, from, to) => {
      try {
        const text = await readFile(join(cwd, file), 'utf8');
        return text.split(/\r?\n/).slice(from - 1, to).join('\n');
      } catch {
        return null;
      }
    },
    logEntry: async (ref) => {
      const n = Number(/#(\d+)$/.exec(ref)?.[1]);
      if (!Number.isFinite(n)) return null;
      try {
        const lines = (await readFile(join(cwd, LOG_PATH), 'utf8')).split('\n').filter(Boolean);
        const entry = JSON.parse(lines[n - 1]);
        return [entry.what, entry.why].filter(Boolean).join(' → ');
      } catch {
        return null;
      }
    },
    statFile: async (p) => {
      try {
        return { mtimeMs: (await stat(join(cwd, p))).mtimeMs };
      } catch {
        return null;
      }
    },
    fetch: async (url) => {
      if (!allowNet) return null;
      const res = await globalThis.fetch(url);
      return { status: res.status, text: await res.text() };
    },
  };
}

export async function check({ cwd = process.cwd(), ledger = LEDGER_PATH, unattended = false, allowNet = false, diffText = null } = {}) {
  const raw = await readJson(join(cwd, ledger));
  if (!raw.ok) return { code: 1, text: `台账读不到或不是合法 JSON：${raw.error}\n（先跑 forklight init，或把路径传给 --ledger）` };

  const v = validateLedger(raw.value);
  if (!v.ok) {
    return { code: 1, text: ['台账结构不合规，后续检查没开始：', ...v.errors.map((e) => `  ${e.path} · ${e.msg}`)].join('\n') };
  }

  const ctx = makeCtx({ cwd, allowNet });
  ctx.lastChangeMs = (await newestTrackedMtime(cwd)) ?? undefined;
  const diff = diffText ?? (await diffAgainstHead(cwd)) ?? '';

  const observations = [];
  const overrides = [];
  for (const fork of raw.value.forks) {
    const obs = await observe(fork.target, { cwd, diffText: diff });
    observations.push(obs);
    // 申报 low 而程序算出 high：覆写，并把原因摊开——这一步不留痕迹就等于没拦
    if (fork.cost_if_wrong === 'low' && grade(obs) === 'high') {
      const missing = whyUnknown(obs);
      const hit = [...obs.published ?? [], ...obs.irreversible ?? []];
      const reason = missing.length ? missing.join('；') : `已发布或有副作用：${hit.join('、')}`;
      overrides.push(`${fork.fork}：申报 low → 程序 high（${reason}）`);
    }
  }

  const verifications = await verifyAll(raw.value, ctx);
  const d = decide(enrich(raw.value, { observations, verifications }), { humanPresent: !unattended });

  return {
    code: d.action === 'proceed' ? 0 : 1,
    text: [
      `任务类型 ${raw.value.task_class} · 分叉 ${d.total} 条 · 需打断 ${d.metrics.interrupts} 次 · 未验证 ${d.metrics.unverified} 条`,
      ...(overrides.length ? ['【程序覆写档位】', ...overrides.map((o) => `  ${o}`)] : []),
      render(d),
      d.action === 'proceed' ? '✓ 可以交付' : `✗ 交付被拦住（${d.action}）`,
    ].join('\n'),
  };
}

function parse(argv) {
  const opts = { cmd: argv[0] === 'init' || argv[0] === 'check' ? argv[0] : 'check', start: argv[0] === 'init' || argv[0] === 'check' ? 1 : 0 };
  const flags = { cwd: process.cwd(), ledger: LEDGER_PATH, unattended: false, allowNet: false };
  let ledgerGiven = false;
  for (let i = opts.start; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cwd') flags.cwd = argv[++i];
    else if (a === '--ledger') {
      flags.ledger = argv[++i];
      ledgerGiven = true;
    } else if (a === '--unattended') flags.unattended = true;
    else if (a === '--allow-net') flags.allowNet = true;
    else if (!a.startsWith('--') && !ledgerGiven) flags.ledger = a; // 位置参数就当台账路径
  }
  return { ...opts, flags };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { cmd, flags } = parse(process.argv.slice(2));
  const res = cmd === 'init' ? await init(flags) : await check(flags);
  console.log(res.text);
  process.exitCode = res.code;
}
