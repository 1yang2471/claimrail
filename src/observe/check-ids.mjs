// 五项渲染检查的 id 集合。geometry 与 evidence 各自需要一份：判定层要按 id 取值，
// 证据回验层要按 id 校验报告。以前各写一份、靠测试同步——任一修改漏同步就是静默不一致。
export const CHECK_IDS = [
  'scrollbar-clears-text',
  'touch-targets-ok',
  'contrast-ok',
  'focus-visible-ok',
  'bottom-not-covered',
];
