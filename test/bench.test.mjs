import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from '../src/bench.mjs';

// 这一层是发布文案唯一允许引用的数字来源（PRD Testing Decisions 第 2 层）。
// 陷阱任务必须来自真翻过的车，不新编。

const here = dirname(fileURLToPath(import.meta.url));
const tasksDir = join(here, '..', 'bench', 'tasks');
const task = (id) => join(tasksDir, id);

test('协议关闭：同一个任务直接交付，不拦', async () => {
  const m = await run([task('published-lowball')], { protocol: 'off' });
  assert.equal(m.protocol, 'off');
  assert.equal(m.tasks, 1);
  assert.equal(m.delivered, 1, JSON.stringify(m.results));
  assert.equal(m.blocked, 0);
});

test('协议开启：模型自报 low、程序算出已发布 → 覆写成 high 并拦住', async () => {
  const m = await run([task('published-lowball')], { protocol: 'on' });
  assert.equal(m.delivered, 0, JSON.stringify(m.results));
  assert.equal(m.blocked, 1);
  assert.match(m.results[0].text, /申报 low → 程序 high/);
});

test('指标形状：静默塌缩只数"交付了且陷阱成立"的任务', async () => {
  const off = await run([task('published-lowball')], { protocol: 'off' });
  assert.equal(off.silentCollapse, 1);
  const on = await run([task('published-lowball')], { protocol: 'on' });
  assert.equal(on.silentCollapse, 0);
});

test('旧截图冒充新证据：协议开启时必须报"截图比代码旧"并拦住', async () => {
  const off = await run([task('stale-render')], { protocol: 'off' });
  assert.equal(off.delivered, 1, JSON.stringify(off.results));
  assert.equal(off.silentCollapse, 1);

  const on = await run([task('stale-render')], { protocol: 'on' });
  assert.equal(on.blocked, 1, JSON.stringify(on.results));
  assert.match(on.results[0].text, /截图比代码旧/);
  assert.equal(on.silentCollapse, 0);
});

// 已知盲区必须被数字如实记下来：口头申报"无分叉"时，门看不见任何东西。
// 这条测试钉的是"有/无协议在这里没有差别"，防止有人把这条算成已拦。
test('申报无分叉绕开台账：两种协议下都应交付，并计入静默塌缩', async () => {
  for (const protocol of ['off', 'on']) {
    const m = await run([task('empty-declaration')], { protocol });
    assert.equal(m.delivered, 1, `${protocol}: ${JSON.stringify(m.results)}`);
    assert.equal(m.silentCollapse, 1, protocol);
  }
});