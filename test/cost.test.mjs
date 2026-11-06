import test from 'node:test';
import assert from 'node:assert/strict';
import { grade, apply, FAN_IN_HIGH } from '../src/cost.mjs';

const clean = { fanIn: 2, published: [], irreversible: [] };

test('三个输入都干净才是 low', () => {
  assert.equal(grade(clean), 'low');
});

test('fanIn 取不到值一律 high，不替模型补一个感觉', () => {
  for (const obs of [{}, undefined, null, { fanIn: NaN, published: [], irreversible: [] }, { fanIn: '很多', published: [], irreversible: [] }]) {
    assert.equal(grade(obs), 'high');
  }
});

test('published 或 irreversible 读不出来也是 high', () => {
  assert.equal(grade({ fanIn: 1 }), 'high');
  assert.equal(grade({ fanIn: 1, published: null, irreversible: [] }), 'high');
});

test('已发布 = 收不回来，直接 high', () => {
  assert.equal(grade({ ...clean, published: ['tag:v1.2.0'] }), 'high');
});

test('有外部副作用，再小的改动也是 high', () => {
  assert.equal(grade({ ...clean, irreversible: ['recursive-delete'] }), 'high');
});

test('fan-in 到线就升档', () => {
  assert.equal(grade({ ...clean, fanIn: FAN_IN_HIGH - 1 }), 'low');
  assert.equal(grade({ ...clean, fanIn: FAN_IN_HIGH }), 'high');
});

test('程序算出 high 时，模型报 low 无效', () => {
  assert.equal(apply('low', { ...clean, published: ['npm'] }), 'high');
});

test('模型可以往高报，程序不反驳保守', () => {
  assert.equal(apply('high', clean), 'high');
});

test('两档都 low 才真的 low', () => {
  assert.equal(apply('low', clean), 'low');
});

test('档位缺失或填了第三档，按 high 处理', () => {
  assert.equal(apply(undefined, clean), 'high');
  assert.equal(apply('medium', clean), 'high');
  assert.equal(apply('', clean), 'high');
});
