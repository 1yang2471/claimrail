import test from 'node:test';
import assert from 'node:assert/strict';
import { publishedFrom } from '../src/observe/published.mjs';

test('git 状态取不到就是取不到，不补一个乐观值', () => {
  assert.equal(publishedFrom({}), null);
  assert.equal(publishedFrom({ tagNames: null, onRemote: false }), null);
  assert.equal(publishedFrom({ tagNames: [], onRemote: null }), null);
  assert.equal(publishedFrom({ tagNames: 'v1', onRemote: false }), null);
});

test('无 tag 且未推送 = 干净的未发布，不是未知', () => {
  assert.deepEqual(publishedFrom({ tagNames: [], onRemote: false }), []);
});

test('打过 tag 或已推到默认分支都算收不回来', () => {
  assert.deepEqual(publishedFrom({ tagNames: ['v1.2.0'], onRemote: false }), ['tag:v1.2.0']);
  assert.deepEqual(publishedFrom({ tagNames: [], onRemote: true }), ['pushed:HEAD']); // 旧调用方
  // 上游名要原样进理由：pushed:origin/main 比 pushed:HEAD 更能指出"发布到哪了"
  assert.deepEqual(publishedFrom({ tagNames: [], onRemote: 'origin/main' }), ['pushed:origin/main']);
});

test('手工声明只能补充，不能顶替 git 读取', () => {
  assert.deepEqual(publishedFrom({ tagNames: [], onRemote: false, declared: ['https://app.example'] }), ['declared:https://app.example']);
  assert.equal(publishedFrom({ tagNames: null, onRemote: null, declared: ['线上已可访问'] }), null);
});

test('多个 tag 全部列出，别把发布历史压成一个布尔', () => {
  assert.deepEqual(publishedFrom({ tagNames: ['v1', 'v2'], onRemote: true }).length, 3);
});
