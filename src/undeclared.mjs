// 「未申报」这条规则只住在这里：工作区真有改动、台账却还是 init 模板 → 拦住。
// check 调它；hook 之后判 stale 也走同一套模板/指纹口径，避免两处各写一份。
// 只判「有没有写」，不判「写得对不对」——后者归 schema、证据回访和代价覆写。
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { LEDGER_PATH, TEMPLATE_HASH_PATH } from './paths.mjs';
import { templateHash, isTemplateReason } from './template.mjs';

// init 自己写进工作区的文件不算"agent 干了活"：否则刚 init 完、还没开工，check 就会拦。
// 这三类是 init 的脚印；真正的工作改动不会落在这里。
export const isProtocolPath = (p) => p === 'AGENTS.md' || p === '.gitignore' || p.startsWith('.claimrail/');

async function readTemplateHash(cwd) {
  try {
    const s = (await readFile(join(cwd, TEMPLATE_HASH_PATH), 'utf8')).trim();
    if (/^[0-9a-f]{64}$/.test(s)) return s;
  } catch {}
  // 老仓库没有指纹文件：退回当前模板常量。init 会补写指纹；没有指纹时
  // 仍能用占位理由兜住"一字未动"的另一种形状。
  return templateHash();
}

export async function undeclaredBlock({ cwd, ledgerText, ledger, changed = [], ledgerPath = LEDGER_PATH }) {
  // 自定义台账路径也算协议文件：台账自己不该出现在"工作区有改动"的清单里。
  const ledgerPosix = String(ledgerPath).replaceAll('\\', '/');
  const workTouched = changed.filter((f) => !isProtocolPath(f) && String(f).replaceAll('\\', '/') !== ledgerPosix);
  if (!workTouched.length) return null;

  const ledgerHash = createHash('sha256').update(ledgerText).digest('hex');
  const seed = await readTemplateHash(cwd);
  const stillTemplate = ledgerHash === seed || (ledger.forks.length === 0 && isTemplateReason(ledger.no_fork_reason));
  if (!stillTemplate) return null;

  const shown = workTouched.slice(0, 5);
  return {
    changed: shown,
    changedTotal: workTouched.length,
    text: [
      '【未申报 · 台账仍是 init 模板】',
      `工作区有改动（${workTouched.length} 个文件）：${shown.join('、')}${
        workTouched.length > shown.length ? `（另有 ${workTouched.length - shown.length} 个）` : ''
      }`,
      `写 ${ledgerPath}：有分叉就写 forks；没有就写 "forks": [] 和 no_fork_reason。`,
      '不要求你想清楚每个分叉，只要求把"这次有没有分叉"写下来。',
    ].join('\n'),
  };
}
