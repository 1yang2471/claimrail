// 偏好闭环。全部代码里唯一字面记录"这个人拒绝过什么"的地方。
//
// log 是唯一真相，只追加；rules 是缓存，可以删了重建。
// 同一条否决命中两次才允许升格成规则——一次随口的吐槽不该被永久固化，
// 那正是这套机制要修的毛病换了个形式回来。
// 每条规则必须带出处指针，这样"这条不对"能当场废掉，并且废的是有据可查的那条。

export const PROMOTE_HITS = 2;

export function append(entries, e) {
  if (!e?.key) throw new Error('否决记录必须带 key，否则无从统计命中次数');
  if (!e?.what) throw new Error('否决记录必须带 what');
  const at = entries.length + 1;
  return Object.freeze([...entries, Object.freeze({ kind: 'rejection', ...e, at })]);
}

export const rejections = (entries) => entries.filter((e) => (e.kind ?? 'rejection') === 'rejection');
export const anchors = (entries) => entries.filter((e) => e.kind === 'anchor');

export function hits(entries, key) {
  return rejections(entries)
    .filter((e) => e.key === key)
    .map((e) => `log#${e.at}`);
}

export function rules(entries) {
  const byKey = new Map();
  for (const e of rejections(entries)) {
    if (!byKey.has(e.key)) byKey.set(e.key, []);
    byKey.get(e.key).push(e);
  }

  const out = [];
  for (const [key, list] of byKey) {
    if (list.length < PROMOTE_HITS) continue;
    // 文本取最近一次：同一个 key 的措辞会漂，最近那次才是他现在的意思。
    const last = list[list.length - 1];
    out.push(
      Object.freeze({
        id: `r:${key}`,
        key,
        rule: last.what,
        sources: list.map((e) => `log#${e.at}`),
      }),
    );
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

// 废规则按 key 或按 id 都认，因为人只会说"那条关于滚动条的别要了"。
export function invalidate(ruleList, removed) {
  const gone = new Set(removed);
  return ruleList.filter((r) => !gone.has(r.key) && !gone.has(r.id));
}

export function formatRules(ruleList) {
  return ruleList.map((r) => `${r.rule}  [来源: ${r.sources.join(',')}]`).join('\n');
}
