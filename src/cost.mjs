// 代价档位。三个输入都必须由 observe 从真实世界里读出来，不接受任何"我觉得"。
// 取不到值一律 high——宁可多问一句，也不要静默放行。
//
// 这条规则是整个设计的地基：模型不给自己的选择打分。它报 low 而程序算出 high，
// 结果必须是 high，且这件事不需要任何人同意。

// fan-in 到这个数以上，改它就不再是局部事件。写死一个常量而不是配置项：
// 配置项意味着每次任务都得先决定填什么。
export const FAN_IN_HIGH = 10;

const has = (v) => Array.isArray(v);

export function grade(observation) {
  const obs = observation ?? {};
  const { fanIn, published, irreversible } = obs;

  if (typeof fanIn !== 'number' || !Number.isFinite(fanIn)) return 'high';
  if (!has(published) || !has(irreversible)) return 'high';

  if (irreversible.length > 0) return 'high';
  if (published.length > 0) return 'high';
  if (fanIn >= FAN_IN_HIGH) return 'high';

  return 'low';
}

// 模型申报的档位只允许往高改。缺失、填错、填了个 "medium" 都按 high 处理。
export function apply(claimed, observation) {
  const computed = grade(observation);
  if (claimed === 'high' || computed === 'high') return 'high';
  if (claimed !== 'low') return 'high';
  return 'low';
}
