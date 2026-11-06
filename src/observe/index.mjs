import { publishedFrom } from './published.mjs';
import { scanEffects, addedCode } from './effects.mjs';
import { tagPointsAtHead, headOnRemote, grepCount, diffAgainstHead } from './git.mjs';

// Observation：cost.grade 唯一的输入。三个值都必须从仓库里读出来，
// 这一层是整套协议里唯一接触真实世界的地方。
export async function observe(target, { cwd, diffText, declaredPublished = [] } = {}) {
  const published = publishedFrom({
    tagNames: await tagPointsAtHead(cwd),
    onRemote: await headOnRemote(cwd),
    declared: declaredPublished,
  });

  const diff = diffText ?? (await diffAgainstHead(cwd)) ?? '';
  const irreversible = scanEffects(addedCode(diff));

  // 没给测量对象就不硬猜：fanIn 取不到 → 按 high 处理 → 会来问人。
  // 审美类分叉正好落在这里，而它们本来就该被问。
  let fanIn = null;
  if (target?.symbol) fanIn = await grepCount(target.symbol, target.file, cwd);
  else if (target?.file) fanIn = await grepCount(target.file, target.file, cwd, { fixed: true });

  return { fanIn, published, irreversible };
}

export function whyUnknown(observation) {
  const obs = observation ?? {};
  const missing = [];
  if (typeof obs.fanIn !== 'number') missing.push('引用数取不到：未提供测量对象，或 grep 失败');
  if (!Array.isArray(obs.published)) missing.push('发布状态取不到：不在 git 仓库里，或分支状态读不出来');
  if (!Array.isArray(obs.irreversible)) missing.push('改动内容取不到：无法扫描副作用');
  return missing;
}
