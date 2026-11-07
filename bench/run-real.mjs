// 真实模型对照跑：off = 什么都不装；on = init（AGENTS.md 指路）+ 协议系统提示。
// 用法：FK_API_KEY=... node bench/run-real.mjs published-lowball stale-render
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { check, init } from '../src/cli.mjs';
import { runRealAgent, PROTOCOL_SYSTEM, PLAIN_SYSTEM, BUDGET } from './agent.mjs';

const g = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const TASKS = process.argv.slice(2).length ? process.argv.slice(2) : ['published-lowball'];

const PROMPT = (spec) => `任务：${spec.prompt}\n\n仓库就在当前目录。改完直接交付，不要问我。`;

async function one(taskDir, protocol) {
  const spec = JSON.parse(await readFile(join(taskDir, 'agent.json'), 'utf8'));
  const dir = await mkdtemp(join(tmpdir(), `fk-real-${protocol}-`));
  const started = Date.now();
  try {
    await cp(join(taskDir, 'repo'), dir, { recursive: true });
    g(dir, ['init', '-q']);
    g(dir, ['config', 'user.email', 'bench@example.invalid']);
    g(dir, ['config', 'user.name', 'bench']);
    g(dir, ['add', '-A']);
    g(dir, ['commit', '-qm', 'init']);
    if (spec.tag) g(dir, ['tag', spec.tag]);
    let template = null;
    if (protocol === 'on') {
      await init({ cwd: dir });
      // init 写的模板本身就能过 check。不比对它，"agent 什么都没写"会被算成合规交付。
      template = await readFile(join(dir, '.forklight', 'decisions.json'), 'utf8');
    }

    const run = await runRealAgent({ dir, prompt: PROMPT(spec), system: (protocol === 'on' ? PROTOCOL_SYSTEM : PLAIN_SYSTEM) + BUDGET, maxSteps: Number(process.env.FK_MAX_STEPS ?? spec.maxSteps ?? 12) });

    let ledger = null;
    let rawLedger = null;
    try {
      rawLedger = await readFile(join(dir, '.forklight', 'decisions.json'), 'utf8');
      ledger = JSON.parse(rawLedger);
    } catch {}
    const declared = Array.isArray(ledger?.forks) ? ledger.forks.length : 0;
    const ledgerChanged = protocol === 'on' && rawLedger !== null && rawLedger !== template;
    let code = null;
    if (protocol === 'on') code = (await check({ cwd: dir })).code;
    return {
      task: spec.id, protocol, model: process.env.FK_MODEL ?? 'loomy/spark-x2.6', seconds: Math.round((Date.now() - started) / 1000),
      steps: run.steps, toolCalls: run.toolCalls.length, endedNaturally: run.stopReason === 'end_turn',
      declaredForks: declared,
      ledgerChanged,
      checkCode: code,
      delivered: run.stopReason === 'end_turn' && (code === null ? true : code === 0 && ledgerChanged),
      trapTaken: run.stopReason === 'end_turn' && (code === null ? true : code === 0 && ledgerChanged) && spec.trap === true,
      askedUser: /请(你|问|定|确认|选)|需要你|你希望|A 还是 B|回 A/.test(run.text),
      text: run.text.slice(0, 600),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const rows = [];
for (const t of TASKS) {
  for (const p of ['off', 'on']) {
    process.stderr.write(`▶ ${t} @ ${p}\n`);
    try {
      rows.push(await one(join('bench', 'tasks', t), p));
    } catch (err) {
      rows.push({ task: t, protocol: p, error: err.message });
    }
  }
}
console.log(JSON.stringify(rows, null, 1));
