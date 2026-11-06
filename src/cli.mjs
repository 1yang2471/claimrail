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
import { newestTrackedMtime, changedLines, isChangedLine, resolveRef, diffSince } from './observe/git.mjs';
import { renderPage } from './observe/web.mjs';
import { openPage, launchBrowser, parseViewports, nameFromUrl } from './observe/driver.mjs';
import { record, recordAnchor, rulesList, rulesText, invalidateRule, readLog, readDenied } from './store.mjs';

export const LEDGER_PATH = join('.forklight', 'decisions.json');
const BASELINE_PATH = join('.forklight', 'baseline');

// init 记下 HEAD 作为起点。没有它，"先把改动 commit 掉再 check"就能让
// `git diff HEAD` 输出空串，副作用扫描与档位计算一起失明。
async function writeBaseline(cwd) {
  const sha = await resolveRef(cwd, 'HEAD');
  await writeFile(join(cwd, BASELINE_PATH), `${sha ?? ''}\n`, 'utf8');
  return sha;
}

async function readBaseline(cwd) {
  try {
    const sha = (await readFile(join(cwd, BASELINE_PATH), 'utf8')).trim();
    return sha ? await resolveRef(cwd, sha) : null;
  } catch {
    return null;
  }
}

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

  // baseline 只在没有的时候写：重复 init 不许把起点往前推，那等于把已提交的改动洗白
  const hasBase = existsSync(join(cwd, BASELINE_PATH));
  const base = hasBase ? await readBaseline(cwd) : await writeBaseline(cwd);

  return {
    code: 0,
    text: [
      `${created ? '已建' : '已存在，不动'} ${LEDGER_PATH}`,
      `补进 .gitignore：${add.join('、') || '（无新增）'}`,
      base ? `起点记在 ${BASELINE_PATH}：${base.slice(0, 8)}（之后 commit 掉的改动照样会被 check 看到）` : '没找到 HEAD：本次任务请尽早 check，改动一旦提交就无法确定起点',
      '',
      NOTICE,
    ].join('\n'),
  };
}

function makeCtx({ cwd, allowNet, changed }) {
  return {
    allowNet,
    lastChangeMs: undefined, // 下面异步补
    // 先干后证：引用本次新增/修改的行，不能算"仓库里本来就这么做"。
    // 没有这一条，写完代码再补一条 repo 证据就能免掉一次提问。
    isChanged: async (file, from, to) => isChangedLine(changed, file, from, to),
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
      // 走 store.readLog：log 里有坏行时必须报错，不能把"读坏了"谎报成"这条记录不存在"——
      // 后者会让整份偏好 log 坏掉之后，所有 memory 档证据都安静地失效。
      const entry = (await readLog(cwd))[n - 1];
      if (!entry) return null;
      return [entry.what, entry.why].filter(Boolean).join(' → ');
    },
    statFile: async (p) => {
      try {
        return { mtimeMs: (await stat(join(cwd, p))).mtimeMs };
      } catch {
        return null;
      }
    },
    readReport: async (p) => (await readJson(join(cwd, p))).value ?? null,
    fetch: async (url) => {
      if (!allowNet) return null;
      // 死链/DNS 失败必须变成这一条证据失败，而不是把整份 check 炸掉：
      // 没有 timeout 和 try/catch 时，一个不可达 URL 会让其余分叉的回验结果全部丢失
      const res = await globalThis.fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'follow' });
      return { status: res.status, text: await res.text() };
    },
  };
}

export async function check({ cwd = process.cwd(), ledger = LEDGER_PATH, unattended = false, allowNet = false, diffText = null, changed = null } = {}) {
  const raw = await readJson(join(cwd, ledger));
  if (!raw.ok) return { code: 1, text: `台账读不到或不是合法 JSON：${raw.error}\n（先跑 forklight init，或把路径传给 --ledger）` };

  const v = validateLedger(raw.value);
  if (!v.ok) {
    return { code: 1, text: ['台账结构不合规，后续检查没开始：', ...v.errors.map((e) => `  ${e.path} · ${e.msg}`)].join('\n') };
  }

  try {
    // 起点优先用 baseline；拿不到就退回 HEAD，并在输出里说明这次的扫描范围小了
    const base = await readBaseline(cwd);
    const changedNow = changed ?? (await changedLines(cwd, base));
    const ctx = makeCtx({ cwd, allowNet, changed: changedNow });
    ctx.lastChangeMs = (await newestTrackedMtime(cwd)) ?? undefined;
    const diff = diffText ?? (await diffSince(cwd, base));
    const overrides = [];
    if (!base && diffText === null) {
      overrides.push('⚠ 没有 baseline（没跑过 forklight init，或仓库当时没有提交）：本次只比较 HEAD 之后的改动，已提交的内容扫不到');
    }

    const observations = [];
    for (const fork of raw.value.forks) {
      const obs = await observe(fork.target, { cwd, diffText: diff, changed: changedNow, base });
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

    // 规则四的代价数据必须由程序逐候选算出来。
    // 只在证据不成立时才算（有证据的贵做法是知情决定），也省掉一半 git grep。
    const optionsCosts = [];
    for (const [i, fork] of raw.value.forks.entries()) {
      if (verifications[i]?.ok) {
        optionsCosts.push(null);
        continue;
      }
      const opts = fork.options ?? [];
      const targets = opts.map((o) => (typeof o === 'string' ? null : o?.target ?? null));
      if (!opts.length || targets.some((t) => !t)) {
        optionsCosts.push(null); // 不齐 → 不判，由 gate 报"未启用"，绝不拿半截数据下结论
        continue;
      }
      const costs = {};
      for (const o of opts) {
        costs[o.label] = grade(await observe(o.target, { cwd, diffText: diff, changed: changedNow }));
      }
      optionsCosts.push(costs);
    }

    const d = decide(enrich(raw.value, { observations, verifications, optionsCosts }), { humanPresent: !unattended });

    return {
      code: d.action === 'proceed' ? 0 : 1,
      text: [
        `任务类型 ${raw.value.task_class} · 分叉 ${d.total} 条 · 需打断 ${d.metrics.interrupts} 次 · 未验证 ${d.metrics.unverified} 条`,
        ...(overrides.length ? ['【程序覆写档位】', ...overrides.map((o) => `  ${o}`)] : []),
        render(d),
        d.action === 'proceed' ? '✓ 可以交付' : `✗ 交付被拦住（${d.action}）`,
      ].join('\n'),
    };
  } catch (err) {
    // check 是全函数：log 损坏、读不到文件这类必须报非零并说清原因，
    // 不能抛出去让"跑坏了"和"跑过且通过"混成同一种沉默
    return { code: 1, text: `检查没跑完：${err.message}` };
  }
}

export async function web({ url, state, viewport = '390x700,1280x800', out = join('.forklight', 'shots'), name, cwd = process.cwd() } = {}) {
  if (!url) return { code: 1, text: '用法：forklight web --url <地址> [--viewport 390x700,1280x800] [--state 登录态.json] [--out .forklight/shots]' };

  let browser;
  try {
    browser = await launchBrowser();
  } catch (err) {
    return { code: 1, text: `浏览器没起来：${err.message}` };
  }

  const blocks = [];
  let red = false;

  try {
    for (const vp of parseViewports(viewport)) {
      let session;
      try {
        session = await openPage(browser, { url, state, viewport: vp });
      } catch (err) {
        blocks.push(`${vp}：页面没打开 —— ${err.message}`);
        red = true;
        continue;
      }

      try {
        const base = name ?? nameFromUrl(url);
        const vlabel = String(vp).replace(/×/g, 'x');
        const shotName = `${base}@${vlabel}`;
        const report = await renderPage(session.page, {
          outDir: join(cwd, out),
          name: shotName,
          label: `${url} @ ${vlabel}`,
          focusProbe: session.focusProbe,
        });

        const ref = join(out, `${shotName}.png`).replaceAll('\\', '/');
        const green = report.checks.filter((c) => c.ok === true).map((c) => c.id);
        const undecided = report.checks.filter((c) => c.ok === null).map((c) => c.id);
        if (report.checks.some((c) => c.ok === false)) red = true;

        blocks.push(
          [
            `${vp} · 容器 ${report.counts.scrollContainers} · 文本 ${report.counts.texts} · 可交互 ${report.counts.interactive}（真实 Tab 探到 ${report.counts.focusProbed}）· 固定条 ${report.counts.fixedRects} → ${ref}`,
            ...report.checks.map((c) => `  ${c.ok === true ? '✓' : c.ok === false ? '✗' : '–'} ${c.id}${c.detail ? `：${c.detail}` : ''}`),
            // 只许引用绿的项。把"未判"写成"已验证"是这套机制最不能出现的事。
            green.length ? `  可引用：{ "kind": "render", "ref": "${ref}", "asserts": [${green.map((g) => `"${g}"`).join(', ')}] }` : '  没有一项真的判过——这份报告不能当证据',
            undecided.length ? `  未判（不作数）：${undecided.join('、')}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      } finally {
        await session.context.close().catch(() => {});
      }
    }

    return { code: red ? 1 : 0, text: `${url}\n\n${blocks.join('\n\n')}` };
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function recordCmd({ cwd = process.cwd(), key, what, why, anchor = false } = {}) {
  if (!key || !what) {
    return { code: 1, text: '用法：forklight record --key <类别> --what <要什么> [--why <为什么>] [--anchor]' };
  }
  try {
    if (anchor) {
      const { n } = await recordAnchor(cwd, { key, what, why });
      return { code: 0, text: `参照物记为 log#${n}。正向锚点不参与升格，它只用于点名"照这个做"。` };
    }
    const r = await record(cwd, { key, what, why });
    const lines = [`记为 log#${r.n}，key "${key}" 累计命中 ${r.hits} 次`, `现行规则 ${r.rules.length} 条`];
    if (r.hits < 2) lines.push('还没升格——同一条否决要命中满两次才写进规则，一次随口的吐槽不该被永久固化');
    else if (r.promoted) lines.push(`已升格：${r.promoted.rule}  [来源: ${r.promoted.sources.join(',')}]`, `推翻它：forklight invalidate ${key}`);
    else lines.push(`这条命中满两次了，但被你用 forklight invalidate ${key} 废过，不会自动复活`);
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
        ...list.map((r) => `  · 推翻它：forklight invalidate ${r.key}`),
      ].join('\n'),
    };
  } catch (err) {
    return { code: 1, text: `读不出来：${err.message}` };
  }
}

export async function invalidateCmd({ cwd = process.cwd(), key } = {}) {
  if (!key) return { code: 1, text: '用法：forklight invalidate <key 或 r:key>' };
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

const COMMANDS = ['init', 'check', 'web', 'record', 'rules', 'invalidate'];

function parse(argv) {
  const cmd = COMMANDS.includes(argv[0]) ? argv[0] : 'check';
  const opts = { cmd, start: COMMANDS.includes(argv[0]) ? 1 : 0 };
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

const HANDLERS = { init, check, web, record: recordCmd, rules: rulesCmd, invalidate: invalidateCmd };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { cmd, flags } = parse(process.argv.slice(2));
  let res;
  try {
    res = await HANDLERS[cmd](flags);
  } catch (err) {
    // 兜底：log 损坏、权限问题这类必须报非零，不能静默当成"跑过了"
    res = { code: 1, text: `没跑成：${err.message}` };
  }
  console.log(res.text);
  process.exitCode = res.code;
}
