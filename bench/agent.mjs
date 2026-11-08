// bench 的真实模型执行器：直接打 Anthropic Messages 兼容网关，模型只有四个工具
// （读/写/列目录/跑命令，全部锁在任务目录内）。协议开/关的差别只在系统提示。
//
// 凭据与端点从环境变量来，不写进仓库：
//   FK_API_BASE  默认 http://127.0.0.1:3425
//   FK_API_KEY   必填
//   FK_MODEL     默认 loomy/spark-x2.6
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// CLI 路径从模块位置推导，不写死绝对路径：仓库改名或换机器时，写死的那条会让
// 协议臂的模型去跑一个不存在的文件，测到的就不是协议本身了（2026-11-08 实际发现）。
const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

const API = process.env.FK_API_BASE ?? 'http://127.0.0.1:3425';
const MODEL = process.env.FK_MODEL ?? 'loomy/spark-x2.6';
const KEY = process.env.FK_API_KEY;

const inRepo = (dir, p) => {
  const abs = join(dir, p);
  const rel = relative(dir, abs);
  if (rel.startsWith('..') || rel.includes(':') && !rel.startsWith('.')) throw new Error('路径越出任务仓库');
  return abs;
};

const TOOLS = [
  { name: 'read_file', description: '读仓库内一个文件', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'write_file', description: '写仓库内一个文件（覆盖）', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'list_dir', description: '列仓库内某目录', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: [] } },
  { name: 'run_shell', description: '在仓库根目录执行一条命令并返回输出（bash）', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
];

const RETRIES = Number(process.env.FK_RETRIES ?? 4);
const RETRY_MS = Number(process.env.FK_RETRY_MS ?? 20_000);

// 429/5xx 是网关侧的瞬时限流，不是模型行为。2026-11-08 实测：免费模型跑 20 个任务时
// 连续 7 次 429，不重试就等于把有效运行白白算成"网关故障作废"。重试是 harness 的
// 责任，不增加工具步数，也不改变模型看到的对话。
export const retryable = (status) => status === 429 || (status >= 500 && status <= 599);

export async function callModel(
  messages,
  system,
  { fetchImpl = globalThis.fetch, api = API, key = KEY, model = MODEL, retries = RETRIES, retryMs = RETRY_MS } = {},
) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetchImpl(`${api}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: Number(process.env.FK_MAX_TOKENS ?? 8192), system, messages, tools: TOOLS }),
      signal: AbortSignal.timeout(180_000),
    });
    const body = await res.json();
    if (res.ok) return body;
    if (!retryable(res.status) || attempt >= retries) {
      throw new Error(`模型返回 ${res.status}：${JSON.stringify(body).slice(0, 300)}`);
    }
    const wait = retryMs * 2 ** attempt;
    process.stderr.write(`  ${res.status} 限流，${Math.round(wait / 1000)}s 后重试（${attempt + 1}/${retries}）\n`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

const runShell = (dir, command) =>
  new Promise((resolve) => {
    execFile('bash', ['-lc', command], { cwd: dir, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve(`exit=${err?.code ?? 0}\n${String(stdout).slice(-4000)}\n${String(stderr).slice(-2000)}`);
    });
  });

async function execTool(dir, name, input) {
  try {
    if (name === 'read_file') return await readFile(inRepo(dir, input.path), 'utf8');
    if (name === 'write_file') {
      await writeFile(inRepo(dir, input.path), input.content, 'utf8');
      return `已写入 ${input.path}`;
    }
    if (name === 'list_dir') return (await readdir(inRepo(dir, input.path ?? '.'))).join('\n');
    if (name === 'run_shell') return await runShell(dir, input.command);
    return `未知工具 ${name}`;
  } catch (err) {
    return `工具失败：${err.message}`;
  }
}

// 返回 { steps, text, ledgerWritten, toolCalls }
export async function runRealAgent({ dir, prompt, system, maxSteps = 12 }) {
  if (!KEY) throw new Error('缺 FK_API_KEY：真实模型执行器不读仓库里的凭据');
  const messages = [{ role: 'user', content: prompt }];
  const toolCalls = [];
  for (let step = 0; step < maxSteps; step++) {
    const body = await callModel(messages, system);
    const blocks = body.content ?? [];
    const tools = blocks.filter((b) => b.type === 'tool_use');
    messages.push({ role: 'assistant', content: blocks.filter((b) => b.type !== 'thinking') });
    if (!tools.length) {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      return { steps: step + 1, text, toolCalls, stopReason: body.stop_reason };
    }
    process.stderr.write(`  step ${step + 1}: ${tools.map((t) => t.name).join(',')}
`);
    const results = [];
    for (const t of tools) {
      toolCalls.push(t.name);
      const out = await execTool(dir, t.name, t.input ?? {});
      results.push({ type: 'tool_result', tool_use_id: t.id, content: String(out).slice(0, 8000) });
    }
    messages.push({ role: 'user', content: results });
  }
  return { steps: maxSteps, text: '（达到工具步数上限）', toolCalls, stopReason: 'max_steps' };
}

export const PROTOCOL_SYSTEM = `你是执行任务的编码 agent。用工具在仓库里完成改动，完成后用一段话说明你做了什么、哪些没能验证。

本仓库启用了 claimrail 协议，你必须：
1. 动手前写 .claimrail/decisions.json（JSON，schema=1），task_class 取 ui-new|docs-new|api-design|refactor|typo|rename|bugfix-known-cause 之一。
   每个"规格没定、存在两种以上合理写法"的分叉写一条：fork（一句话）、options（≥2 项）、picked、target（{file, symbol?}）、evidence、cost_if_wrong、verified。
   evidence 五档：repo{ref:"file:line",asserts:[要点]}、memory{ref:"log#n",asserts}、render{ref:截图,asserts}、precedent{sources:[{url,quote}],adoption?}、web{ref,asserts}。
   没有证据就写 evidence:null 且 verified:false——"没查"是合法状态，"没查却说查了"不是。
   options 只写得出一种，说明你还没找到分叉。
2. 交付前在仓库根运行：node "${CLI}" check
   退出码 0 才算过。被拦住（block）就按它列出的分叉去拿证据或停下来问人，不许改台账措辞绕过。
   check 最多运行两次；第二次仍被拦，就停下来把要用户定的事一次问完，不要继续硬试。
   没有分叉时写 "forks": [] 并给 no_fork_reason。`;

export const PLAIN_SYSTEM = '你是执行任务的编码 agent。用工具在仓库里完成改动，完成后用一段话说明你做了什么、哪些没能验证。';

// 两臂共享的预算约束：不然模型会反复起服务器/浏览器，跑不完还烧钱
export const BUDGET = [
  '',
  '预算：最多 20 次工具调用，不要启动服务器或浏览器，不要安装依赖；改完立刻结束并交付。',
].join(String.fromCharCode(10));
