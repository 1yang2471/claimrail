// 参数解析与帮助。从 cli.mjs 拆出来：cli.mjs 被 20KB 提交钩子拒收，
// 而这两块不碰台账、不碰 git，独立成文件不引入第二份实现。
import { join } from 'node:path';

import { LEDGER_PATH } from './paths.mjs';

export const COMMANDS = ['init', 'check', 'web', 'hook', 'record', 'rules', 'invalidate'];

// 帮助。新用户第一屏就是 `forklight --help`；没有它，拼错命令的人会看到"台账读不到"。
const HELP = [
  'forklight —— 让 AI 的选择留下痕迹：决策台账 + 程序算代价 + 可回验证据',
  '',
  '用法：forklight <命令> [选项]',
  '',
  '命令：',
  '  init                        建 .forklight/decisions.json、补 .gitignore、在 AGENTS.md 写指路段、记 baseline',
  '  check [台账路径]            交付前校验。退出码 0 放行 / 1 拦住',
  '  web --url <地址>            双视口截图 + 五项几何检查（需 playwright）',
  '  hook                       宿主钩子（从 stdin 读事件）。退出码 2 = 拦住并续一轮',
  '  record --key <类别> --what <要什么> [--why <为什么>] [--anchor]   记一次否决或参照物',
  '  rules                      现行规则 + 原始否决 + 来源',
  '  invalidate <key 或 r:key>  作废一条规则（原始 log 不动）',
  '',
  '选项：',
  '  --cwd <目录>      在指定目录工作（默认当前目录）',
  '  --ledger <路径>   台账路径（默认 .forklight/decisions.json）',
  '  --unattended      无人值守：高代价无证据时 halt 而不是 block',
  '  --allow-net       precedent / web 两档要真回访时必须显式打开（外发查询）',
  '  --viewport <列表> web 的视口，默认 390x700,1280x800',
  '  --state <文件>    web 的 Playwright storageState（登录态）',
  '  --out <目录>      web 的截图输出目录',
  '',
  '退出码：0 放行 / 1 拦住（含参数错误）/ 2 仅 hook：拦住并续一轮',
].join('\n');

export async function help() {
  return { code: 0, text: HELP };
}

// parse() 把拼错的命令放在 flags.unknown（handler 收到的就是整个 flags），
// 所以这里读 unknown；`command` 是给直接调用者留的别名。
export async function unknownCmd({ unknown, command } = {}) {
  const name = unknown ?? command ?? '';
  return {
    code: 1,
    text: [`没有这个命令：${name}`, '', HELP, '', '查看命令：forklight --help'].join('\n'),
  };
}

export function parse(argv) {
  const first = argv[0];
  const isHelp = first === '--help' || first === '-h' || first === 'help' || argv.includes('--help') || argv.includes('-h');
  if (isHelp) return { cmd: 'help', start: 0, flags: {} };
  // 拼错的命令不许静默退化成 check：check 会去读一份叫 "chekc" 的台账，报"读不到"，
  // 用户会以为自己少建了文件。没有命令（空 argv）才是 check。
  const known = COMMANDS.includes(first);
  const cmd = first === undefined ? 'check' : known ? first : 'unknown';
  const opts = { cmd, start: known ? 1 : 0 };
  const flags = {
    cwd: process.cwd(),
    ledger: LEDGER_PATH,
    unattended: false,
    allowNet: false,
    url: undefined,
    state: undefined,
    viewport: '390x700,1280x800',
    out: join('.forklight', 'shots'),
    name: undefined,
    key: undefined,
    what: undefined,
    why: undefined,
    anchor: false,
    unknown: cmd === 'unknown' ? first : undefined,
  };
  let ledgerGiven = false;
  for (let i = opts.start; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cwd') flags.cwd = argv[++i];
    else if (a === '--ledger') {
      flags.ledger = argv[++i];
      ledgerGiven = true;
    } else if (a === '--unattended') flags.unattended = true;
    else if (a === '--allow-net') flags.allowNet = true;
    else if (a === '--url') flags.url = argv[++i];
    else if (a === '--state') flags.state = argv[++i];
    else if (a === '--viewport') flags.viewport = argv[++i];
    else if (a === '--out') flags.out = argv[++i];
    else if (a === '--name') flags.name = argv[++i];
    else if (a === '--key') flags.key = argv[++i];
    else if (a === '--what') flags.what = argv[++i];
    else if (a === '--why') flags.why = argv[++i];
    else if (a === '--anchor') flags.anchor = true;
    else if (!a.startsWith('--')) {
      // check 的位置参数是台账，invalidate 的位置参数是被废的 key，两者不重叠
      if (cmd === 'check' && !ledgerGiven) {
        flags.ledger = a;
        ledgerGiven = true;
      } else if (cmd === 'invalidate' && !flags.key) flags.key = a;
    }
  }
  return { ...opts, flags };
}
