#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateLedger } from './schema.mjs';
import { grade } from './cost.mjs';
import { verifyAll } from './evidence.mjs';
import { enrich, decide, render } from './gate.mjs';
import { observe, whyUnknown } from './observe/index.mjs';
import { newestTrackedMtime, changedLines, isChangedLine, resolveRef, diffSince, gitState } from './observe/git.mjs';
import { record, recordAnchor, rulesList, rulesText, invalidateRule, readLog, readDenied } from './store.mjs';
import { web } from './commands/web.mjs';
import { LEDGER_PATH, BASELINE_PATH, TEMPLATE_HASH_PATH } from './paths.mjs';
import { TEMPLATE_TEXT, templateHash } from './template.mjs';
import { parse, help, unknownCmd } from './args.mjs';
import { check, hook, readIncoming, readJson, writeBaseline, readBaseline } from './commands/check.mjs';

export { web, parse, help, unknownCmd, LEDGER_PATH, check, hook };
export { readJson, writeBaseline, readBaseline } from './commands/check.mjs';


const NOTICE = `数据去向：
  .claimrail/decisions.json  进 git（它是给你 review 的东西）
  memory/                    不进 git（个人偏好，只在你机器上）
  截图（.claimrail/shots/）      不进 git（真实产品画面）`;

// 光靠技能 description 触发不了（真机实测：设计任务照做、台账一字不写），而宿主一定会读
// 仓库根的 AGENTS.md。所以 init 在这里写一段带 marker 的指路：可幂等、可卸载、不动原内容。
const AGENTS_BEGIN = '<!-- claimrail:begin -->';
const AGENTS_END = '<!-- claimrail:end -->';
// 指路块里刻意不写"去加载 claimrail 技能"：技能要靠 SKILL.md 装进宿主的 skills 目录才算注册，
// npm 安装只把 skill/ 放在包里，不会自动装。写"读技能"会让 agent 去找一个没注册的技能。
// 改成指向包里那个真实存在的文件路径——它一定在，且能直接读。
const AGENTS_BLOCK = [
  AGENTS_BEGIN,
  '## claimrail',
  '',
  '动界面、文档、接口之前，先读 `node_modules/claimrail/skill/SKILL.md`（没装成依赖就读仓库里的 `skill/SKILL.md`），',
  '写 `.claimrail/decisions.json` 申报分叉与证据；',
  '交付前跑 `claimrail check`——结构不合规先修申报，红的不许交。',
  AGENTS_END,
].join('\n');

async function writeAgentsPointer(cwd) {
  const p = join(cwd, 'AGENTS.md');
  const old = existsSync(p) ? await readFile(p, 'utf8') : '';
  if (old.includes(AGENTS_BEGIN)) return '已存在，跳过';
  const body = old.trim() ? `${old.replace(/\n*$/, '')}\n\n${AGENTS_BLOCK}\n` : `${AGENTS_BLOCK}\n`;
  await writeFile(p, body, 'utf8');
  return old.trim() ? '已追加' : '已新建';
}

export async function init({ cwd = process.cwd() } = {}) {
  await mkdir(join(cwd, '.claimrail'), { recursive: true });
  const file = join(cwd, LEDGER_PATH);
  const created = !existsSync(file);
  if (created) await writeFile(file, TEMPLATE_TEXT, 'utf8');
  // 模板指纹：check 用它判"台账是不是一字未动"。存下来而不是每次现算，
  // 是为了模板跨版本变化时，旧仓库仍按 init 当时的模板判。
  await writeFile(join(cwd, TEMPLATE_HASH_PATH), `${templateHash()}\n`, 'utf8');

  const gi = join(cwd, '.gitignore');
  const lines = existsSync(gi) ? (await readFile(gi, 'utf8')).split('\n') : [];
  // 只写自己产物所在的目录。曾经还写过 '*.png'：那会把目标仓库里所有真实图片
  // 一起排除在提交之外（静默丢数据），而 init 的本意只是别让截图进库。
  const add = ['memory/', '.claimrail/shots/', '.claimrail/last-delivery.json', '.claimrail/violations.jsonl'].filter((p) => !lines.includes(p));
  if (add.length) await writeFile(gi, `${lines.join('\n').replace(/\n*$/, '')}\n${add.join('\n')}\n`, 'utf8');

  // baseline 只在没有的时候写：重复 init 不许把起点往前推，那等于把已提交的改动洗白
  const hasBase = existsSync(join(cwd, BASELINE_PATH));
  const base = hasBase ? await readBaseline(cwd) : await writeBaseline(cwd);
  const agents = await writeAgentsPointer(cwd);

  return {
    code: 0,
    text: [
      `${created ? '已建' : '已存在，不动'} ${LEDGER_PATH}`,
      `补进 .gitignore：${add.join('、') || '（无新增）'}`,
      `AGENTS.md：${agents}指路段`,
      base ? `起点记在 ${BASELINE_PATH}：${base.slice(0, 8)}（之后 commit 掉的改动照样会被 check 看到）` : '没找到 HEAD：本次任务请尽早 check，改动一旦提交就无法确定起点',
      '',
      NOTICE,
    ].join('\n'),
  };
}




export async function recordCmd({ cwd = process.cwd(), key, what, why, anchor = false } = {}) {
  if (!key || !what) {
    return { code: 1, text: '用法：claimrail record --key <类别> --what <要什么> [--why <为什么>] [--anchor]' };
  }
  try {
    if (anchor) {
      const { n } = await recordAnchor(cwd, { key, what, why });
      return { code: 0, text: `参照物记为 log#${n}。正向锚点不参与升格，它只用于点名"照这个做"。` };
    }
    const r = await record(cwd, { key, what, why });
    const lines = [`记为 log#${r.n}，key "${key}" 累计命中 ${r.hits} 次`, `现行规则 ${r.rules.length} 条`];
    if (r.hits < 2) lines.push('还没升格——同一条否决要命中满两次才写进规则，一次随口的吐槽不该被永久固化');
    else if (r.promoted) lines.push(`已升格：${r.promoted.rule}  [来源: ${r.promoted.sources.join(',')}]`, `推翻它：claimrail invalidate ${key}`);
    else lines.push(`这条命中满两次了，但被你用 claimrail invalidate ${key} 废过，不会自动复活`);
    return { code: 0, text: lines.join('\n') };
  } catch (err) {
    return { code: 1, text: `没记上：${err.message}` };
  }
}

export async function rulesCmd({ cwd = process.cwd() } = {}) {
  try {
    const [list, entries, denied, text] = await Promise.all([rulesList(cwd), readLog(cwd), readDenied(cwd), rulesText(cwd)]);
    const rejections = entries.filter((e) => (e.kind ?? 'rejection') === 'rejection').length;
    return {
      code: 0,
      text: [
        `现行规则 ${list.length} 条 · 原始否决 ${rejections} 条 · 参照物 ${entries.length - rejections} 条 · 已废 ${denied.length} 个 key`,
        text || '（还没有一条命中满两次，所以现在只有记录、没有规则）',
        ...list.map((r) => `  · 推翻它：claimrail invalidate ${r.key}`),
      ].join('\n'),
    };
  } catch (err) {
    return { code: 1, text: `读不出来：${err.message}` };
  }
}

export async function invalidateCmd({ cwd = process.cwd(), key } = {}) {
  if (!key) return { code: 1, text: '用法：claimrail invalidate <key 或 r:key>' };
  try {
    const { removed, remaining } = await invalidateRule(cwd, key);
    return {
      code: 0,
      text: [
        `已废掉 ${removed.length} 条：${removed.map((r) => r.rule).join('；')}`,
        `原始 log 一条没动，禁用名单写在 memory/denied.json——所以它不会因新的命中自动长回来`,
        `现行规则剩 ${remaining.length} 条`,
      ].join('\n'),
    };
  } catch (err) {
    return { code: 1, text: err.message };
  }
}

const HANDLERS = { init, check, web, hook, record: recordCmd, rules: rulesCmd, invalidate: invalidateCmd, help, unknown: unknownCmd };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { cmd, flags } = parse(process.argv.slice(2));
  let res;
  try {
    // hook 的 payload 在 stdin：在入口读一次，保持 hook() 本身是纯函数、测试不会挂在等 EOF
    const args = cmd === 'hook' ? { ...flags, payload: await readIncoming() } : flags;
    res = await HANDLERS[cmd](args);
  } catch (err) {
    // 兜底：log 损坏、权限问题这类必须报非零，不能静默当成"跑过了"
    res = { code: 1, text: `没跑成：${err.message}` };
  }
  if (cmd === 'hook') {
    if (res.text) console.error(res.text);
  } else if (flags.json && res.data) {
    // 结构化视图：宿主/脚本消费这份；文本视图仍然保留给人看
    console.log(JSON.stringify(res.data, null, 2));
  } else if (flags.json) {
    // 要求了 JSON 却拿不到结构化结果（例如台账读不到）：照样给 JSON，别混出一段中文
    console.log(JSON.stringify({ schema: 1, error: String(res.text ?? ''), action: 'error' }, null, 2));
  } else {
    console.log(res.text);
  }
  process.exitCode = res.code;
}
