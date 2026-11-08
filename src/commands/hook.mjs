// 宿主接线：ZCode/Claude Code 的 Stop 事件 = 一次响应结束（交付前）。
// 退出码语义是宿主定的：0 放行、2 是"拦住并续一轮"（stderr 交给模型去修），其它非零会被当成故障。
// 三层护栏：
//   1. 没初始化过 = 这个仓库不在协议里 → 静默放行；初始化过但台账被删 → 拦（删文件不是退出协议）。
//   2. 已经因 Stop 钩子续过一轮 → 不再重复阻断，否则永远拦的钩子会打成死循环；
//      第二次仍没申报就落一条 violations 记录，让"放行"也可统计。
//   3. 指纹：工作区变了、台账没变 = 沿用上次申报，拦一次。check 无状态，判不了这一条。
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { check, readBaseline } from './check.mjs';
import { changedLines, diffSince } from '../observe/git.mjs';
import { readDelivery, overclaims, declaresUnverified } from '../overclaim.mjs';
import { isProtocolPath } from '../undeclared.mjs';
import { treeHash, ledgerHash, readSnapshot, writeSnapshot, recordViolation } from '../delivery.mjs';
import { LEDGER_PATH, BASELINE_PATH, TEMPLATE_HASH_PATH } from '../paths.mjs';

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
      }),
      new Promise((resolve) => setTimeout(() => resolve(''), 5000)),
    ]);
    return raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function hook({ cwd, ledger = LEDGER_PATH, payload = null } = {}) {
  const p = payload ?? {};
  const dir = cwd || p?.cwd || process.env.ZCODE_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const continuedBefore = p?.stop_hook_active === true || p?.stopHookActive === true;
  const at = new Date().toISOString();
  // 本地状态写不进去（只读仓库、路径被占）不许把交付打成宿主故障：
  // 快照/违规记录是尽力而为的审计线索，不是交付的前置条件。
  const saveSnapshot = async (entry) => {
    try {
      await writeSnapshot(dir, entry);
    } catch {}
  };
  const logViolation = async (entry) => {
    try {
      await recordViolation(dir, entry);
    } catch {}
  };

  // 台账被删：初始化过（有 baseline 或模板指纹）就不是"不在协议里"，而是绕开。
  if (!existsSync(join(dir, ledger))) {
    const initialized = existsSync(join(dir, BASELINE_PATH)) || existsSync(join(dir, TEMPLATE_HASH_PATH));
    if (!initialized) return { code: 0, text: '' };
    if (continuedBefore) {
      await logViolation({ at, reason: 'ledger-deleted' });
      return { code: 0, text: '台账被删了；本轮已续过一次，不再重复阻断。' };
    }
    return { code: 2, text: '台账被删了：恢复 .claimrail/decisions.json，或重新跑 claimrail init。' };
  }

  const r = await check({ cwd: dir, ledger });

  // 1. check 本身不过：未申报 / 结构 / 证据 / 代价。
  if (r.code !== 0) {
    if (continuedBefore) {
      if (r.undeclared) {
        await logViolation({
          at,
          reason: 'undeclared',
          task_class: r.data?.task_class ?? null,
          changed: r.undeclared.changed,
          changedTotal: r.undeclared.changedTotal,
        });
      }
      return { code: 0, text: `${r.text}\n（本轮已因 Stop 钩子续过一次，不再重复阻断；上面是仍未通过的原因）` };
    }
    return { code: 2, text: `${r.text}\n先修申报或去拿证据；拿不到就问人，不要改措辞绕过。` };
  }

  // 2. 指纹：工作区变了、台账没变 = 沿用上次申报。
  const base = await readBaseline(dir);
  const changedNow = await changedLines(dir, base);
  const touched = changedNow
    ? [...new Set([...changedNow.ranges.keys(), ...changedNow.untracked, ...(changedNow.renamed ?? [])])].filter(
        (f) => !isProtocolPath(f),
      )
    : [];
  const diff = await diffSince(dir, base);
  const tHash = treeHash({ touched, diffText: diff });
  const lHash = ledgerHash(await readFile(join(dir, ledger), 'utf8'));
  const snap = await readSnapshot(dir);
  if (snap && tHash !== snap.treeHash && lHash === snap.ledgerHash) {
    if (continuedBefore) {
      await logViolation({ at, reason: 'stale', changed: touched.slice(0, 5), changedTotal: touched.length });
      await saveSnapshot({ at, treeHash: tHash, ledgerHash: lHash });
      return { code: 0, text: '工作区有改动，但台账自上次放行后未变；本轮已续过一次，不再重复阻断。' };
    }
    return {
      code: 2,
      text: [
        '【未申报 · 工作区有改动，台账自上次放行后未变】',
        `这次改了 ${touched.length} 个文件：${touched.slice(0, 5).join('、')}${
          touched.length > 5 ? `（另有 ${touched.length - 5} 个）` : ''
        }`,
        '更新 .claimrail/decisions.json：有分叉就写 forks；没有就写 "forks": [] 和 no_fork_reason。',
        '沿用上次的申报不算这次申报——哪怕结论一样，也要把理由改成这次的理由。',
      ].join('\n'),
    };
  }

  // 3. 只拦一次：续过一轮就放行，但把仍未通过的检查原因留在输出里。
  if (continuedBefore) {
    await saveSnapshot({ at, treeHash: tHash, ledgerHash: lHash });
    return { code: 0, text: `${r.text}\n（本轮已因 Stop 钩子续过一次，不再重复阻断；上面是仍未通过的原因）` };
  }

  // 4. 门放行了但有未验证条目：正文必须逐条声明。
  // 交付正文拿得到就直接按它判。顺序不能反：先说"是否宣称全都核实了"，再谈"是否已声明"——
  // 一句"本次没有任何未验证的事项，全部来源均已核实"两边都能命中，只能按最严重的那条处理。
  const delivery = readDelivery(p);
  if (r.unverified?.length) {
    if (!delivery) {
      // 宿主没给正文：判不了"有没有逐条声明"。拦下去会在不提供正文的宿主上打成死循环
      // （stop_hook_active 也未必给）。按"未判"处理：未验证条目仍留在 check 输出里。
      await saveSnapshot({ at, treeHash: tHash, ledgerHash: lHash });
      return { code: 0, text: `${r.text}\n（宿主没给交付正文，跳过"正文逐条声明"检查；未验证条目见上）` };
    }
    const claims = overclaims(delivery);
    const declared = declaresUnverified(delivery);
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
    if (declared) {
      await saveSnapshot({ at, treeHash: tHash, ledgerHash: lHash });
      return { code: 0, text: '' };
    }
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

  await saveSnapshot({ at, treeHash: tHash, ledgerHash: lHash });
  return { code: 0, text: '' };
}
