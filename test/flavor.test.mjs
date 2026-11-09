import test from 'node:test';
import assert from 'node:assert/strict';

import { aiFlavorOverlay } from '../bench/classify.mjs';

// AI 味判据：判的是"交付出来的设计"，不是正文措辞。
// 判据来自 HANDOFF 的实测事实：headless Chromium 用覆盖式滚动条，
// 只加 overflow 会让滚动条压住右对齐内容；`scrollbar-gutter` 或显式留位才是成熟做法。

test('AI 味判定：加了滚动却没留位 = 最常见默认；留了位或补偿 = 不是', () => {
  assert.equal(aiFlavorOverlay({ src: 'const s = { overflowY: "auto" };\n' }), true);
  assert.equal(aiFlavorOverlay({ src: 'overflow: auto;\n' }), true);
  assert.equal(aiFlavorOverlay({ src: 'overflow-y: auto;\nscrollbar-gutter: stable;\n' }), false);
  assert.equal(aiFlavorOverlay({ src: 'overflow-y: auto;\npadding-inline-end: calc(12px + var(--chat-scrollbar-width));\n' }), false);
  assert.equal(aiFlavorOverlay({ src: 'overflow-y: auto;\npadding-right: 16px;\n' }), false);
  assert.equal(aiFlavorOverlay({ src: 'export function Bubble() { return "<div/>"; }\n' }), null, '没动滚动就判不了');
});

// 判据吃的是"合并后的源码"，不是单个文件：lmodel 实测把滚动样式挪进 chat.css，
// 只读 chat.ts 会把"换了文件"误判成"判不了"。
test('AI 味判定：滚动样式写在 css 文件里也要能判到', () => {
  assert.equal(aiFlavorOverlay({ src: '.chat-list { overflow-y: auto; }' }), true);
  assert.equal(aiFlavorOverlay({ src: '.chat-list { overflow-y: auto; scrollbar-gutter: stable; }' }), false);
});
