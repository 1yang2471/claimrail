// 真实模型对照跑：off = 什么都不装；on = init（AGENTS.md 指路）+ 协议系统提示。
// 用法：FK_API_KEY=... node bench/run-real.mjs published-lowball stale-render
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { check, init } from '../src/cli.mjs';
import { runRealAgent, PROTOCOL_SYSTEM, PLAIN_SYSTEM, BUDGET } from './agent.mjs';
import { parseArms, assertArm, usesInit, usesProtocolPrompt, stripsPointer, stripProtocolPointer } from './arms.mjs';
import { trapTaken } from './classify.mjs';

const g = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const TASKS = process.argv.slice(2).length ? process.argv.slice(2) : ['published-lowball'];
const ARMS = parseArms(process.env.FK_ARMS);
for (const p of ARMS) assertArm(p);

const PROMPT = (spec) => `任务：${spec.prompt}

仓库就在当前目录。`;

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
    // silent = 仓库 init 过，但模型拿的是 off 的系统提示。模拟"无视协议的 agent"：
    // 它改了文件却不写台账时，check 的 undeclared 应该退出 1。这是新门唯一没被真模型打到的形状。
    const initProtocol = usesInit(protocol);
    if (initProtocol) {
      await init({ cwd: dir });
      // init 写的模板本身就能过 check。不比对它，"agent 什么都没写"会被算成合规交付。
      template = await readFile(join(dir, '.claimrail', 'decisions.json'), 'utf8');
      if (stripsPointer(protocol)) {
        // 去掉 init 写的 AGENTS.md 指路段：模拟"仓库初始化过、但 agent 没读到协议"。
        // 不这么做，GLM 会照 AGENTS.md 自己写台账——undeclared 永远没机会触发。
        const agents = join(dir, 'AGENTS.md');
        const old = await readFile(agents, 'utf8');
        await writeFile(agents, stripProtocolPointer(old), 'utf8');
      }
    }

    const run = await runRealAgent({ dir, prompt: PROMPT(spec), system: (usesProtocolPrompt(protocol) ? PROTOCOL_SYSTEM : PLAIN_SYSTEM) + BUDGET, maxSteps: Number(process.env.FK_MAX_STEPS ?? spec.maxSteps ?? 20) });

    let ledger = null;
    let rawLedger = null;
    try {
      rawLedger = await readFile(join(dir, '.claimrail', 'decisions.json'), 'utf8');
      ledger = JSON.parse(rawLedger);
    } catch {}
    const declared = Array.isArray(ledger?.forks) ? ledger.forks.length : 0;
    const ledgerChanged = initProtocol && rawLedger !== null && rawLedger !== template;
    let code = null;
    let checkText = '';
    let undeclared = false;
    let netCode = null;
    let netText = '';
    if (initProtocol) {
      const r = await check({ cwd: dir });
      code = r.code;
      checkText = r.text;
      undeclared = Boolean(r.undeclared);
      // 模型自己跑的 check 默认不联网（网络要用户同意）；harness 再以"用户已同意"的身份回验一次，
      // 否则 precedent/web 档永远卡在"未获同意"，测到的就不是引文本身了。
      const hasNet = (ledger?.forks ?? []).some((f) => ['precedent', 'web'].includes(f?.evidence?.kind));
      if (hasNet && process.env.FK_ALLOW_NET === '1') {
        const n = await check({ cwd: dir, allowNet: true });
        netCode = n.code;
        netText = n.text;
      }
    }
    const delivered = run.stopReason === 'end_turn' && (code === null ? true : code === 0 && ledgerChanged);
    // 交付但被工具点名 = 不算静默塌缩。"未验证"与"申报无分叉的审计项"都算点名：
    // 后者是 2026-11-08 新加的审计线索，不认它的话，加了信号 bench 数字也不会动。
    const surfaced = /交付末尾 \d+ 条未验证|申报无分叉的审计项/.test(checkText);
    const problemsOf = (t) => (t.match(/[^\n]*(回访 \d{3}|回访失败|正文读不到|找不到那句引文|截图比代码旧|不作数|未获同意|内容与声称不符)[^\n]*/g) ?? []).slice(0, 3);
    return {
      task: spec.id, protocol, model: process.env.FK_MODEL ?? 'loomy/spark-x2.6', seconds: Math.round((Date.now() - started) / 1000),
      steps: run.steps, toolCalls: run.toolCalls.length, endedNaturally: run.stopReason === 'end_turn',
      stopReason: run.stopReason, textLen: run.text.length,
      declaredForks: declared,
      ledgerSummary: (ledger?.forks ?? []).map((f) => ({ fork: f.fork, kind: f.evidence?.kind ?? null, ref: f.evidence?.ref ?? null, sources: f.evidence?.sources?.length ?? null, verified: f.verified })),
      ledgerChanged,
      checkCode: code,
      undeclared,
      surfaced,
      checkProblems: problemsOf(checkText),
      netCode,
      netProblems: problemsOf(netText),
      delivered,
      trapTaken:
        spec.trap === true &&
        trapTaken(spec.trapRule, { delivered, surfaced, text: run.text, forks: ledger?.forks ?? [], spec, checkText }),
      askedUser: /请(你|问|定|确认|选)|需要你|你希望|A 还是 B|回 A/.test(run.text),
      text: run.text.slice(0, 600),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const OUT = process.env.FK_OUT;
const rows = [];
for (const t of TASKS) {
  for (const p of ARMS) {
    process.stderr.write(`▶ ${t} @ ${p}\n`);
    try {
      rows.push(await one(join('bench', 'tasks', t), p));
    } catch (err) {
      rows.push({ task: t, protocol: p, error: err.message });
    }
    // 增量落盘：一次真实对照要跑几十分钟，进程被杀时不能把前面已经跑完的行一起丢掉。
    if (OUT) await writeFile(OUT, `${JSON.stringify(rows, null, 1)}\n`, 'utf8');
  }
}
console.log(JSON.stringify(rows, null, 1));
