// 交付前的门：check（校验台账）与 hook（宿主接线）放在一起——hook 只是 check 的宿主外壳，
// 拆成两个文件只会让"读 check 的人找不到 hook 在哪"。
// 从 cli.mjs 搬出来是因为提交钩子按 token 拒收超大文件（20KB），而这两个函数是同一件事的两面。
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { validateLedger } from '../schema.mjs';
import { grade } from '../cost.mjs';
import { verifyAll } from '../evidence.mjs';
import { enrich, decide, render } from '../gate.mjs';
import { observe, whyUnknown } from '../observe/index.mjs';
import { newestTrackedMtime, changedLines, isChangedLine, resolveRef, diffSince, gitState } from '../observe/git.mjs';
import { readLog } from '../store.mjs';
import { LEDGER_PATH, BASELINE_PATH } from '../paths.mjs';
import { overclaims, declaresUnverified, readDelivery } from '../overclaim.mjs';

export { readJson, writeBaseline, readBaseline };  // check / hook 本身就是 export

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
    return { ok: true, value: JSON.parse(await readFile(path, 'utf8')) };
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
      // 申报 low 而程序算出 high：覆写，并把原因摊开——这一步不留痕迹就等于没拦
      if (fork.cost_if_wrong === 'low' && grade(obs) === 'high') {
        const missing = whyUnknown(obs, { gitRepo });
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

    const d = decide(enrich(raw.value, { observations, verifications, optionsCosts }), {
      humanPresent: !unattended,
      // reviewer 抽查"哪个类别从来不长分叉"靠的就是这个字段，不能只校验不显示
      noForkReason: raw.value.no_fork_reason ?? null,
    });

    return {
      code: d.action === 'proceed' ? 0 : 1,
      // unverified 单独给结构化一份：hook 要按条目回给模型"逐条声明"，别让它解析渲染文本
      unverified: d.unverified.map((f) => ({ fork: f.fork, picked: f.picked, why: f.evidenceWhy })),
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

// 宿主从 stdin 发事件 JSON（Stop 的 payload 里有 stop_hook_active / stopHookActive）。
export async function readIncoming() {
  if (process.stdin.isTTY) return null;
  try {
    // 上限：宿主不关闭 stdin 时，钩子会一直挂着（宿主那边只能等超时）。
    // 事件 payload 只有几 KB，五秒读不到就当没有事件。
    const raw = await Promise.race([
      (async () => {
        let buf = '';
        for await (const chunk of process.stdin) buf += chunk;
        return buf;
      })(),
      new Promise((resolve) => setTimeout(() => resolve(''), 5000)),
    ]);
    return raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// hooks：宿主接线，刻意做薄，不放逻辑。ZCode/Claude Code 的 Stop 事件 = 一次响应结束（交付前）。
// 退出码语义是宿主定的：0 放行、2 是"拦住并续一轮"（stderr 交给模型去修），其它非零会被当成故障。
// 两个护栏：没有台账 = 这个仓库不在协议里 → 静默放行；已经因 Stop 钩子续过一轮 → 不再重复阻断，
// 否则永远拦的钩子会打成死循环。
//
// "低代价 + 无证据"是放行但要点名（gate 的 unverified，check 退出码 0）。点名只写在 check 的
// 输出里，模型交付的正文完全可能不提——真模型实测（shell-citation on 臂）：末尾挂着
// "只有 1 个独立域名确认该说法"，正文照样写"3 个来源全部当场核实"。所以钩子在放行前把这些
// 条目回给模型续一轮改口：交付正文里必须逐条写"这条我没能验证，原因是 X"。仍是只拦一次。
export async function hook({ cwd, ledger = LEDGER_PATH, payload = null } = {}) {
  const p = payload ?? {};
  const dir = cwd || p?.cwd || process.env.ZCODE_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const continuedBefore = p?.stop_hook_active === true || p?.stopHookActive === true;
  if (!existsSync(join(dir, ledger))) return { code: 0, text: '' };
  const r = await check({ cwd: dir, ledger });
  // 两种拦截都要模型续一轮：显式 block（高代价无证据），以及"门放行了但有没有验证的条目
  // 要逐条声明"——后者在 check 里退出码是 0，模型容易把"check 过了"当成"正文可以只字不提"。
  // 真模型实测（shell-citation on 臂）：末尾挂着"只有 1 个独立域名确认该说法"，正文照样写
  // "3 个来源全部当场核实"。所以钩子把未验证条目结构化地回给模型改口。仍然是只拦一次。
  // 注意顺序：stop_hook_active 的放行判断必须在未验证声明之前，否则续过一轮还会被拦。
  if (continuedBefore) return { code: 0, text: `${r.text}\n（本轮已因 Stop 钩子续过一次，不再重复阻断；上面是仍未通过的原因）` };
  // 交付正文拿得到就直接按它判。顺序不能反：先说"是否宣称全都核实了"，再谈"是否已声明"——
  // 一句"本次没有任何未验证的事项，全部来源均已核实"两边都能命中，只能按最严重的那条处理。
  // 拿不到正文时老实说拿不到，不猜。
  const delivery = readDelivery(p);
  if (r.code === 0 && r.unverified?.length) {
    // 两条分支都要看得见：
    //   declared —— 正文里有老老实实的声明（"这条我没能验证，原因是 X"）。
    //               声明优先：这句话里若还有"其余全部核实"之类的说法，指的是别的对象，
    //               不该拿它当矛盾（否则诚实交付会被白拦一轮）。
    //   claims   —— 正文宣称"全都核实过了"，而门里确实有未验证项。这两句不能同时成立。
    // 一句否认（"本次交付没有任何未验证的事项"）不算声明——它正好是最该被拦的那种话。
    const claims = overclaims(delivery ?? '');
    const declared = delivery ? declaresUnverified(delivery) : false;
    if (claims.length && !declared) {
      return {
        code: 2,
        text: [
          r.text,
          `交付正文里写着「${claims[0]}」，但门里有 ${r.unverified.length} 条未验证项——这两句不能同时成立：`,
          ...r.unverified.map((u) => `  • ${u.fork}｜已选 ${u.picked}｜${u.why}`),
          '要么去把证据拿到，要么把正文改成"这条我没能验证，原因是 X"。不要只改措辞。',
        ].join('\n'),
      };
    }
    if (declared) return { code: 0, text: '' };
    return {
      code: 2,
      text: [
        r.text,
        `交付说明必须逐条声明未验证项（${delivery ? '你的交付说明里一条都没提' : '没能读到交付正文，按"没提"处理'}）：`,
        ...r.unverified.map((u) => `  • ${u.fork}｜已选 ${u.picked}｜${u.why}`),
        '在正文里写清"哪条没能验证、原因是什么"，然后结束本轮。',
      ].join('\n'),
    };
  }
  if (r.code === 0) return { code: 0, text: '' };
  return { code: 2, text: `${r.text}\n先修申报或去拿证据；拿不到就问人，不要改措辞绕过。` };
}
