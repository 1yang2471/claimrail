// 焦点探针的结果合并。纯函数，可脱离浏览器测。
//
// 只有真实键盘 Tab 走出来的样式差才能当结论。程序化 el.focus() 不保证触发
// :focus-visible，用它判会产生假红；而假红的代价是把用户教会成"无视整屏清单"。

export function applyFocusProbe(interactive, focusSamples) {
  const bySelector = new Map((focusSamples ?? []).map((s) => [s.selector, s.style]));

  return (interactive ?? []).map((el) => {
    if (el.focusable === false) return { ...el, hasVisibleFocus: null };

    const focused = bySelector.get(el.selector);
    // Tab 没走到它（被跳过、被隐藏、或走了一圈没回来）：不猜，留 null
    if (focused === undefined || typeof el.baseStyle !== 'string') return { ...el, hasVisibleFocus: null };
    return { ...el, hasVisibleFocus: focused !== el.baseStyle };
  });
}

export function focusProbeCoverage(interactive, focusSamples) {
  const probed = applyFocusProbe(interactive, focusSamples).filter((el) => el.hasVisibleFocus !== null);
  return { probed: probed.length, invisible: probed.filter((el) => el.hasVisibleFocus === false).length };
}
