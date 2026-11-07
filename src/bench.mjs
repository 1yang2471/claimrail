// bench：有协议 / 无协议各跑一遍同一批陷阱任务，产出发布文案唯一允许引用的数字。
// 这一层刻意不知道"任务内容"，只认任务目录里的三样东西：repo/ 快照、agent.json（假 agent
// 会打的动作与只会自报的台账）、trap.md（为什么这是真翻过的车）。
// 数字的诚实边界：这里的"agent"是确定性的假 agent（照 fixture 打补丁），量的是**门**能不能
// 拦住这个形状，不是模型的行为分布。发布文案要引用"模型静默塌缩率"时，得把假 agent 换成
// 真实模型再跑一遍，否则只能写"尚未测量"。
import { cp, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname as dirOf, join } from 'node:path';

import { check, init } from './cli.mjs';

const g = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export async function runTask(taskDir, { protocol = 'off' } = {}) {
  const spec = JSON.parse(await readFile(join(taskDir, 'agent.json'), 'utf8'));
  const dir = await mkdtemp(join(tmpdir(), 'fk-bench-'));
  try {
    await cp(join(taskDir, 'repo'), dir, { recursive: true });
    g(dir, ['init', '-q']);
    g(dir, ['config', 'user.email', 'bench@local']);
    g(dir, ['config', 'user.name', 'bench']);
    g(dir, ['add', '-A']);
    g(dir, ['commit', '-qm', 'init']);
    if (spec.tag) g(dir, ['tag', spec.tag]);
    // baseline 必须在 agent 动手之前记下，否则"改了什么"会被算成空
    await init({ cwd: dir });

    for (const [rel, body] of Object.entries(spec.writes ?? {})) {
      await mkdir(join(dir, dirOf(rel)), { recursive: true });
      await writeFile(join(dir, rel), body);
    }
    await writeFile(join(dir, '.forklight', 'decisions.json'), JSON.stringify(spec.ledger, null, 2));
    // 假 agent 也会刷新证据文件的时间戳：有些陷阱是"图是新的、报告里却写着未判"，
    // 不 touch 就会被"截图比代码旧"先拦下，测到的就不是那条守卫了。
    // 往后推 5 秒是因为 utimes 只落到整毫秒，而 init 写的 AGENTS.md 时间戳带小数位。
    const now = new Date(Date.now() + 5000);
    for (const rel of spec.touch ?? []) await utimes(join(dir, rel), now, now);

    const r = protocol === 'on' ? await check({ cwd: dir }) : { code: 0, text: '（协议关闭：不检查，直接交付）' };
    const m = /需打断 (\d+) 次/.exec(r.text);
    // 交付但被列入"末尾未验证"≠ 静默塌缩：用户被告知了。只有交付且什么都没说才算塌缩。
    const surfaced = /交付末尾 \d+ 条未验证/.test(r.text);
    return {
      task: spec.id ?? taskDir,
      protocol,
      delivered: r.code === 0,
      blocked: r.code !== 0,
      surfaced,
      interrupts: m ? Number(m[1]) : 0,
      text: r.text,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function run(tasks, { protocol = 'off' } = {}) {
  const results = [];
  const traps = [];
  for (const t of tasks) {
    const spec = JSON.parse(await readFile(join(t, 'agent.json'), 'utf8'));
    traps.push({ id: spec.id, trap: spec.trap === true });
    results.push(await runTask(t, { protocol }));
  }
  const trapOf = new Map(traps.map((x) => [x.id, x.trap]));
  const delivered = results.filter((r) => r.delivered);
  return {
    protocol,
    tasks: results.length,
    delivered: delivered.length,
    blocked: results.length - delivered.length,
    // 静默塌缩 = 交付了、陷阱本来会成立、而且交付末尾没有把"未验证"说出来
    silentCollapse: delivered.filter((r) => trapOf.get(r.task) && !r.surfaced).length,
    // 交付但被点名未验证：门没拦住，但用户知道——单独计数，别混进静默塌缩
    deliveredSurfaced: delivered.filter((r) => r.surfaced).length,
    interruptionsMedian: median(results.map((r) => r.interrupts)),
    results,
  };
}