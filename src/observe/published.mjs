// published 的判定。三个来源都能拿到就用，任何一个取不到就整体返回 null——
// 按 cost 规则 null 一律 high，宁可多问一句。
//
// onRemote 的语义在 2026-11-08 收窄：只认"HEAD 在远端默认分支上"（或已合并进去），
// 不再把任何已推送的提交算成发布——功能分支推上去不等于发布，把它写成「已发布」
// 只会让人去查一份不存在的发布记录。
//
// declared 是给"线上 URL 可访问"这类 git 看不见的情况留的手工口子，
// 它只能是补充，不能是唯一来源：否则等于让模型自己宣布自己已发布。

export function publishedFrom({ tagNames = null, onRemote = null, declared = [] }) {
  // onRemote：null 未知 / false 未发布 / true（旧调用方）/ 上游名（origin/main）
  if (!Array.isArray(tagNames)) return null;
  if (typeof onRemote !== 'boolean' && typeof onRemote !== 'string') return null;

  const out = [...tagNames.map((t) => `tag:${t}`)];
  if (onRemote) out.push(`pushed:${typeof onRemote === 'string' ? onRemote : 'HEAD'}`);
  for (const d of declared ?? []) out.push(`declared:${d}`);
  return out;
}
