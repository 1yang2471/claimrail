import { publishedFrom } from './published.mjs';
import { scanDiff } from './effects.mjs';
import { tagPointsAtHead, headOnRemote, grepCount, diffSince, changedLines, worktreeScanText } from './git.mjs';

// Observation：cost.grade 唯一的输入。三个值都必须从仓库里读出来，
// 这一层是整套协议里唯一接触真实世界的地方。读不出来就交 null，
// 由 cost 按 high 处理——"读不到"永远不许降级成乐观值。
//
// base 是 init 记下的起点。不传就退回 `HEAD`，那意味着"先 commit 再 check"
// 会让改动看起来是空的——所以调用方必须显式传，缺了要报出来而不是静默降级。
export async function observe(target, { cwd, diffText = null, changed = null, base = null, declaredPublished = [] } = {}) {
  const [tagNames, onRemote, changedNow] = await Promise.all([
    tagPointsAtHead(cwd),
    headOnRemote(cwd),
    changed ?? changedLines(cwd, base),
  ]);

  const published = publishedFrom({ tagNames, onRemote, declared: declaredPublished });

  const rawDiff = diffText ?? (await diffSince(cwd, base));
  // 未跟踪文件与纯 rename 的落地文件都不在 diff 的新增行里：一并并进扫描对象。
  const irreversible =
    rawDiff === null || rawDiff === undefined
      ? null
      : changedNow
        ? scanDiff(worktreeScanText(rawDiff, changedNow, cwd))
        : scanDiff(rawDiff);

  // 没给测量对象就不硬猜：fanIn 取不到 → 按 high 处理 → 会来问人。
  // 审美类分叉正好落在这里，而它们本来就该被问。
  let fanIn = null;
  if (target?.symbol) fanIn = await grepCount(target.symbol, target.file, cwd);
  else if (target?.file) fanIn = await grepCount(target.file, target.file, cwd, { fixed: true });

  return { fanIn, published, irreversible };
}

// 取不到值的原因必须分清：一个是"没给测量对象"，一个是"这里根本没有 git"。
// 旧写法把后者也说成"git grep 失败"，照着这句去查 grep 的人永远查不到问题。
export function whyUnknown(observation, { gitRepo = true } = {}) {
  const obs = observation ?? {};
  const missing = [];
  if (typeof obs.fanIn !== 'number') {
    missing.push(gitRepo ? '引用数取不到：未提供测量对象，或 git grep 失败' : '不在 git 仓库里，引用数取不到');
  }
  if (!Array.isArray(obs.published)) {
    missing.push(gitRepo ? '发布状态取不到：不在 git 仓库里，或分支状态读不出来' : '不在 git 仓库里，发布状态取不到');
  }
  if (!Array.isArray(obs.irreversible)) {
    missing.push(gitRepo ? '改动内容取不到：无法扫描副作用' : '不在 git 仓库里，改动内容取不到');
  }
  return missing;
}
