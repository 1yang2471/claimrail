// published 的判定。三个来源都能拿到就用，任何一个取不到就整体返回 null——
// 按 cost 规则 null 一律 high，宁可多问一句。
//
// declared 是给"线上 URL 可访问"这类 git 看不见的情况留的手工口子，
// 它只能是补充，不能是唯一来源：否则等于让模型自己宣布自己已发布。

export function publishedFrom({ tagNames = null, onRemote = null, declared = [] }) {
  if (!Array.isArray(tagNames) || typeof onRemote !== 'boolean') return null;

  const out = [...tagNames.map((t) => `tag:${t}`)];
  if (onRemote) out.push('pushed:HEAD');
  for (const d of declared ?? []) out.push(`declared:${d}`);
  return out;
}
