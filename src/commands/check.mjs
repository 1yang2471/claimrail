// 交付前的门：check（校验台账）。hook（宿主接线）已拆到 ./hook.mjs——
// 两者是两个关注点，而且放在一起会把本文件推过提交钩子的 20KB 上限。
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { validateLedger } from '../schema.mjs';
import { grade, FAN_IN_HIGH } from '../cost.mjs';
import { verifyAll } from '../evidence.mjs';
import { enrich, decide, render } from '../gate.mjs';
import { observe, whyUnknown } from '../observe/index.mjs';
import { newestTrackedMtime, changedLines, isChangedLine, resolveRef, diffSince, gitState } from '../observe/git.mjs';
import { readLog } from '../store.mjs';
import { surfaceFiles } from '../audit.mjs';
import { LEDGER_PATH, BASELINE_PATH } from '../paths.mjs';
import { undeclaredBlock } from '../undeclared.mjs';

export { readJson, writeBaseline, readBaseline };

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

async function readJson(path) {
  try {
    const text = await readFile(path, 'utf8');
    return { ok: true, value: JSON.parse(text), text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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
    // 截图本体的哈希：报告里写了 shot_sha256，这里重算一遍对比——
    // 换一张图或换一份同名报告都会在这一步露馅（落盘链的最后一环）。
    shotHash: async (p) => {
      try {
        return createHash('sha256').update(await readFile(join(cwd, p))).digest('hex');
      } catch {
        return null;
      }
    },
    fetch: async (url) => {
      if (!allowNet) return null;
      // 死链/DNS 失败必须变成这一条证据失败，而不是把整份 check 炸掉：
      // 没有 timeout 和 try/catch 时，一个不可达 URL 会让其余分叉的回验结果全部丢失
      // accept-language 是实测补的：web.dev 对不带语言标的回访返回过法语页，英文引文因此在
      // 自己刚引过的那篇上匹配不上——语言漂移不该算成"这个来源不成立"
      const res = await globalThis.fetch(url, {
        signal: AbortSignal.timeout(10_000),
        redirect: 'follow',
        headers: { 'accept-language': 'en' },
      });
      return { status: res.status, text: await res.text() };
    },
  };
}

export async function check({ cwd = process.cwd(), ledger = LEDGER_PATH, unattended = false, allowNet = false, diffText = null, changed = null } = {}) {
  const raw = await readJson(join(cwd, ledger));
  if (!raw.ok) return { code: 1, text: `台账读不到或不是合法 JSON：${raw.error}\n（先跑 claimrail init，或把路径传给 --ledger）` };

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

    // 申报无分叉时的审计线索：台账说没有分叉，而改动落在该类的面上。
    // 只进输出与 --json，不参与 action/退出码——见 src/audit.mjs 顶部的说明。
    const touched = changedNow
      ? [...new Set([...changedNow.ranges.keys(), ...changedNow.untracked, ...(changedNow.renamed ?? [])])]
      : [];

    // 未申报：工作区真有改动，台账却还是 init 模板。这是 pilot 里 5/6 的形状——
    // 门以前只校验"已申报"的东西，不写台账就静默放行（2026-11-08 第一性复核）。
    const undeclared = await undeclaredBlock({
      cwd,
      ledgerText: raw.text,
      ledger: raw.value,
      changed: touched,
      ledgerPath: ledger,
    });
    if (undeclared) {
      return {
        code: 1,
        undeclared,
        data: {
          schema: 1,
          action: 'block',
          task_class: raw.value.task_class,
          total: 0,
          metrics: { interrupts: 0, unverified: 0, violations: 0, rule4NotEnabled: 0 },
          degraded: null,
          no_fork_reason: raw.value.no_fork_reason ?? null,
          emptyDeclaration: null,
          undeclared,
          overrides: [],
          questions: [],
          unverified: [],
          violations: [],
          notEnabled: [],
        },
        text: undeclared.text,
      };
    }

    const auditFiles = raw.value.forks.length === 0 ? surfaceFiles(raw.value.task_class, touched) : [];
    const emptyDeclaration = auditFiles.length
      ? {
          reason: raw.value.no_fork_reason ?? null,
          touched: auditFiles.slice(0, 5),
          touchedTotal: auditFiles.length,
        }
      : null;
    // 非 git 目录：三个代价输入一个都取不到 → 每条分叉都判 high。必须一次说清，
    // 否则"降级默认"在报告里跟"实测出的高代价"长得一模一样。
    // 也别把"半瞎"说成"全瞎"：repo 档在 git 之外仍读得了文件与行号，真正丢掉的是
    // "先干后证"（判断引用的行是不是本次刚写的，那一步要 git）。
    const git = await gitState(cwd);
    const gitRepo = git === 'repo';
    if (git === 'none') {
      overrides.push(
        '⚠ 非 git 目录（降级模式）：fanIn / published / irreversible 三项都取不到，所有分叉按 high 处理——这是保守默认，不是实测结果；repo 类证据仍验得了"文件里确实有这些字"，但验不了"先干后证"（引用的行是不是本次刚写的）',
      );
    } else if (git === 'unknown') {
      // "仓库读不出来"和"这里不是仓库"要分开说：后者该 git init，前者该查环境
      overrides.push(
        '⚠ git 读不出仓库状态（这不等于"这里不是 git 仓库"：查 GIT_DIR、safe.directory、git 是否可用）：三项代价输入都取不到，所有分叉按 high 处理',
      );
    }
    // 这一句只在真仓库里成立：没有仓库时说"没跑过 init"会把人指错方向
    if (gitRepo && !base && diffText === null) {
      overrides.push('⚠ 没有 baseline（没跑过 claimrail init，或仓库当时没有提交）：本次只比较 HEAD 之后的改动，已提交的内容扫不到');
    }

    const observations = [];
    for (const fork of raw.value.forks) {
      const obs = await observe(fork.target, { cwd, diffText: diff, changed: changedNow, base });
      observations.push(obs);
      // 申报 low 而程序算出 high：覆写，并把原因摊开——这一步不留痕迹就等于没拦。
      // 三种 high 的来源要分开说：读不到值、已发布/有副作用、引用数达到门槛。
      // 只拼后两种会漏掉 fan-in（2026-11-08 实测：冒号后空白，照着它查不到 fan-in）。
      if (fork.cost_if_wrong === 'low' && grade(obs) === 'high') {
        const missing = whyUnknown(obs, { gitRepo });
        const hit = [...obs.published ?? [], ...obs.irreversible ?? []];
        const reasons = missing.length
          ? missing
          : [
              ...(hit.length ? [`已推送/已发布或有副作用：${hit.join('、')}`] : []),
              ...(typeof obs.fanIn === 'number' && obs.fanIn >= FAN_IN_HIGH
                ? [`引用数 ${obs.fanIn} 处达到 ${FAN_IN_HIGH} 的门槛`]
                : []),
            ];
        overrides.push(`${fork.fork}：申报 low → 程序 high（${reasons.join('；') || '程序判 high'}）`);
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

    const d = decide(enrich(raw.value, { observations, verifications, optionsCosts }), {
      humanPresent: !unattended,
      // reviewer 抽查"哪个类别从来不长分叉"靠的就是这个字段，不能只校验不显示
      noForkReason: raw.value.no_fork_reason ?? null,
    });

    // 结构化判定：宿主与脚本该拿这个（调研自 craft-anything 的 MCP/结构化证据面）。
    // 文本只是同一份数据的视图；两边永远来自同一次 decide()，不各算一遍。
    const item = (f) => ({
      fork: f.fork,
      picked: f.picked,
      options: f.options ?? [],
      cost: f.cost ?? null,
      why: f.evidenceWhy ?? '',
      where: f.where ?? null,
    });
    const data = {
      schema: 1,
      action: d.action,
      task_class: raw.value.task_class,
      total: d.total,
      metrics: d.metrics,
      degraded: git === 'repo' ? null : git === 'none' ? 'no-git' : 'git-unknown',
      // 审计面要能用脚本消费："为什么申报无分叉"以前只在文本视图里
      no_fork_reason: raw.value.no_fork_reason ?? null,
      emptyDeclaration,
      overrides,
      questions: d.questions.map(item),
      unverified: d.unverified.map(item),
      violations: d.violations.map((f) => ({ ...item(f), rule: f.rule, cheaper: f.cheap })),
      notEnabled: d.notEnabled.map(item),
    };

    return {
      code: d.action === 'proceed' ? 0 : 1,
      // 兼容旧调用方：unverified 保留平铺的一份（hook 与既有测试按它判断）
      unverified: d.unverified.map((f) => ({ fork: f.fork, picked: f.picked, why: f.evidenceWhy })),
      data,
      text: [
        `任务类型 ${raw.value.task_class} · 分叉 ${d.total} 条 · 需打断 ${d.metrics.interrupts} 次 · 未验证 ${d.metrics.unverified} 条`,
        ...(overrides.length ? ['【程序覆写档位】', ...overrides.map((o) => `  ${o}`)] : []),
        render(d),
        ...(emptyDeclaration
          ? [
              `【申报无分叉的审计项 · 本次改动落在 ${raw.value.task_class} 的面上】`,
              `  改动文件 ${emptyDeclaration.touchedTotal} 个：${emptyDeclaration.touched.join('、')}${
                emptyDeclaration.touchedTotal > emptyDeclaration.touched.length
                  ? `（另有 ${emptyDeclaration.touchedTotal - emptyDeclaration.touched.length} 个）`
                  : ''
              }`,
              '  不拦交付：程序判不了"有没有分叉"，只把"申报无分叉却动了这类文件"记下来供抽查',
            ]
          : []),
        d.action === 'proceed' ? '✓ 可以交付' : `✗ 交付被拦住（${d.action}）`,
      ].join('\n'),
    };
  } catch (err) {
    // check 是全函数：log 损坏、读不到文件这类必须报非零并说清原因，
    // 不能抛出去让"跑坏了"和"跑过且通过"混成同一种沉默
    return { code: 1, text: `检查没跑完：${err.message}` };
  }
}

// 宿主接线（hook / readIncoming）已拆到 ./hook.mjs：check 与 hook 各自是一个关注点，
// 而且两个函数放在一起会把本文件推过提交钩子的 20KB 上限。

