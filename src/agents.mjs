// AGENTS.md 的 claimrail 指路段标记。cli 写、bench 的 silent 臂删，必须同一份定义：
// 两处各写一份字面量时，改标记只会让 silent 臂静默退化成 on。
export const AGENTS_BEGIN = '<!-- claimrail:begin -->';
export const AGENTS_END = '<!-- claimrail:end -->';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function stripAgentsBlock(text) {
  const stripped = String(text).replace(new RegExp(`${escapeRe(AGENTS_BEGIN)}[\\s\\S]*?${escapeRe(AGENTS_END)}\\n?`), '');
  if (stripped === text) throw new Error('AGENTS.md 的 claimrail 指路段没删掉');
  return stripped;
}
