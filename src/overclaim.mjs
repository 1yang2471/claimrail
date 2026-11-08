// 交付正文与门里的未验证项对撞。
//
// 为什么需要它：门的"未验证"只写在 check 的输出里，模型交付的正文完全可能只字不提，
// 甚至反过来写"全部核实"。真模型实测（shell-citation on 臂）：门已经点名"只有 1 个独立
// 域名确认该说法"，正文照样写"3 个来源的引文全部当场核实"。语气判不了，但
// "正文宣称全核实 + 门里有未验证项"这个自相矛盾是字面可判的。
//
// 宿主确实把正文递过来了：ZCode 在 Stop 事件里写 last_assistant_message（依据是产品
// 自带的 resources/glm/zcode.cjs 构造 payload 的那段）。拿不到就老实说拿不到。
//
// 只在门里确实有未验证条目时才用这一套——没问题的时候不许拿它找茬。

// 全称断言：把"全都核实过了"这类话认出来。刻意收窄，宁可漏也不误伤。
const OVERCLAIM = /(全部|所有|均|都|逐条|一一)\s*(已|都)?\s*(当场)?\s*(核实|验证|确认|校验|检查|过了一遍|过一遍)/;

// 否定句不是宣称："不能直接说全部核实，因为只找到一个域名"是在反驳，不该被拦。
// 只看断言前面那一小段：真模型会把结论引出来再否定。
const NEGATED = /(不能|不该|别|不要|不是|没有|没|未|无法|不算)[^。；\n]{0,8}$/;

export function overclaims(text) {
  const s = String(text ?? '');
  const hits = [];
  for (const m of s.matchAll(new RegExp(OVERCLAIM.source, 'g'))) {
    if (NEGATED.test(s.slice(Math.max(0, m.index - 10), m.index))) continue;
    hits.push(m[0]);
  }
  return hits;
}

// 正文里有没有老实声明。有就不必再拦一轮——这一条以前是靠猜的（"你一条都没提"），
// 现在能按正文判，就不该继续猜。
const DECLARED = /(未验证|未能验证|没能验证|无法验证|未核实|未能核实|没能核实|没法核实|拿不到证据|没拿到证据|无法核实)/;

// 但"本次交付没有任何未验证的事项"里也有"未验证"三个字——它说的是"没有这回事"。
// 纯关键词存在性判断会被这句话骗过去，而且它出现的位置正好在放行分支上：
// 一句否认就把"逐条声明"和"不得宣称全部核实"两道防线一起短路。所以要看关键词前面
// 是不是一个全称否定。
const VOID = /(没有|无|不存在|没有任何|一条也没|不属于|不算|并非|不是)[^。；\n]{0,6}$/;

export function declaresUnverified(text) {
  const s = String(text ?? '');
  for (const m of s.matchAll(new RegExp(DECLARED.source, 'g'))) {
    if (VOID.test(s.slice(Math.max(0, m.index - 10), m.index))) continue;
    return true;
  }
  return false;
}

// 事件里的交付正文。字段名在不同宿主之间不一致，认识的都认；拿不到返回 null。
export function readDelivery(payload) {
  const p = payload ?? {};
  for (const key of ['last_assistant_message', 'lastAssistantMessage', 'responseText']) {
    const v = p[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}
