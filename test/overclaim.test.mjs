import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hook } from '../src/cli.mjs';
import { overclaims, declaresUnverified, readDelivery } from '../src/overclaim.mjs';

// ZCode 的 Stop 事件确实把交付正文递过来了（实测依据：产品自带的 resources/glm/zcode.cjs
// 里构造 payload 的那段，Stop 分支写 last_assistant_message = responseText）。
// 所以"工具不读交付正文"这条边界现在可以关掉一半：字面上的自相矛盾是程序能判的。

test('正文里的全称断言能被认出来，否定句不算', () => {
  assert.deepEqual(overclaims('3 个来源的引文全部当场核实'), ['全部当场核实']);
  assert.ok(overclaims('所有来源都已核实过').length === 1);
  assert.ok(overclaims('逐条核实过').length === 1);
  assert.deepEqual(overclaims('卡片间距改成 16px'), []);
  // 把结论引出来再否定，是反驳不是宣称——真模型干过这件事（bench 的 noticed 判据同源）
  assert.deepEqual(overclaims('不能直接说"全部核实"，因为只找到 1 个域名'), []);
  assert.deepEqual(overclaims('这条我没有逐条核实过'), []);
});

test('已经逐条声明过的正文要被认出来（不许白拦一轮）', () => {
  assert.ok(declaresUnverified('其中「列表行高」这条我没能验证，原因是拿不到设计规范'));
  assert.equal(declaresUnverified('三条分叉全部核实完毕'), false);
});

test('事件里没有正文时不许瞎说"你一条都没提"', () => {
  assert.equal(readDelivery({}), null);
  assert.equal(readDelivery({ last_assistant_message: '  ' }), null);
  assert.equal(readDelivery({ last_assistant_message: 'x' }), 'x');
  // 其它拼法也认（不同宿主字段名不一致）
  assert.equal(readDelivery({ lastAssistantMessage: 'y' }), 'y');
  assert.equal(readDelivery({ responseText: 'z' }), 'z');
});

// —— hook 层：把三种情况跑通 ——

const repoWithUnverified = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-ov-'));
  const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  g(['init', '-q']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  await writeFile(join(dir, 'package.json'), '{\n  "name": "x"\n}\n', 'utf8');
  g(['add', '-A']);
  g(['commit', '-qm', 'init']);
  await mkdir(join(dir, '.claimrail'), { recursive: true });
  await writeFile(
    join(dir, '.claimrail', 'decisions.json'),
    JSON.stringify({
      schema: 1,
      task_class: 'refactor',
      forks: [
        {
          fork: '列表行高用 token 还是写死',
          options: ['token', '写死 24px'],
          picked: 'token',
          target: { file: 'package.json' },
          evidence: null,
          cost_if_wrong: 'low',
          verified: false,
        },
      ],
    }),
    'utf8',
  );
  return dir;
};

test('正文宣称"全部核实"但门里有未验证项：拦一轮，并把矛盾摊开', async () => {
  const dir = await repoWithUnverified();
  try {
    const r = await hook({
      cwd: dir,
      payload: { last_assistant_message: '改动已完成，三项分叉的引文全部核实，可以交付。' },
    });
    assert.equal(r.code, 2, r.text);
    assert.match(r.text, /不能同时成立/);
    assert.match(r.text, /全部核实/);
    assert.match(r.text, /列表行高用 token 还是写死/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('正文已经逐条声明过：放行，不再白拦一轮', async () => {
  const dir = await repoWithUnverified();
  try {
    const r = await hook({
      cwd: dir,
      payload: { last_assistant_message: '其中「列表行高用 token 还是写死」这条我没能验证，原因是拿不到设计规范。' },
    });
    assert.equal(r.code, 0, r.text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('读不到正文时按"没提"处理，但明说读不到，不冒充看过', async () => {
  const dir = await repoWithUnverified();
  try {
    const r = await hook({ cwd: dir, payload: {} });
    assert.equal(r.code, 2, r.text);
    assert.match(r.text, /没能读到交付正文/);
    assert.doesNotMatch(r.text, /一条都没提/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
