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

// 公开版必须能接住英文交付：宿主和模型不保证用中文写总结。
// 旧实现四组正则全是中文，英文"All sources were verified"不命中，
// 英文"not verified"也不被认成声明——hook 会把诚实的英文交付无限拦下去。
test('英文全称断言要能认出来，英文否定句不算断言', () => {
  assert.equal(overclaims('All sources were verified.').length, 1);
  assert.equal(overclaims('I verified everything.').length, 1);
  assert.equal(overclaims('Every check was confirmed.').length, 1);
  assert.deepEqual(overclaims('Not all sources were verified.'), []);
  assert.deepEqual(overclaims('I did not verify everything.'), []);
});

test('英文诚实声明要能认出来，全称否认不算声明', () => {
  assert.equal(declaresUnverified('This claim was not verified.'), true);
  assert.equal(declaresUnverified('I could not verify the screenshot.'), true);
  assert.equal(declaresUnverified('There are no unverified items.'), false);
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

test('读不到正文时按"未判"放行，不猜也不死循环', async () => {
  const dir = await repoWithUnverified();
  try {
    const r = await hook({ cwd: dir, payload: {} });
    // 宿主不提供正文时，钩子判不了"有没有逐条声明"。拦下去会在这种宿主上打成死循环
    // （stop_hook_active 也未必给）；未验证条目仍留在 check 输出里，所以按未判放行。
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /宿主没给交付正文/);
    assert.doesNotMatch(r.text, /一条都没提/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 审查抓到的假绿：一句否认同时短路两道防线。
// "本次交付没有任何未验证的事项，所有来源均已核实" 里既有"未验证"三字（骗过声明识别），
// 又有全称断言；而声明分支排在前面时直接放行 → 退出 0。
test('否认句不许冒充"已声明"，两条防线也不许被一句话同时短路', async () => {
  assert.equal(declaresUnverified('本次交付没有任何未验证的事项'), false);
  assert.equal(declaresUnverified('没有未核实的内容'), false);
  // 老老实实说自己没能验证的句子仍然算声明
  assert.equal(declaresUnverified('这条我没能验证，原因是拿不到设计规范'), true);

  const dir = await repoWithUnverified();
  try {
    const r = await hook({
      cwd: dir,
      payload: { last_assistant_message: '本次交付没有任何未验证的事项，所有来源均已核实。' },
    });
    assert.equal(r.code, 2, r.text);
    assert.match(r.text, /不能同时成立/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 声明优先，但"否认"不算声明。
// 这两条一起钉住，顺序就动不了：先看宣称 → 诚实的"其余都核实过"会被白拦；
// 先看声明 → 一句否认就能把两道防线一起短路。
test('诚实的声明优先放行；否认不算声明', async () => {
  const dir = await repoWithUnverified();
  try {
    const honest = await hook({
      cwd: dir,
      payload: { last_assistant_message: '「列表行高用 token 还是写死」这条我没能验证（拿不到设计规范）；其余来源全部核实。' },
    });
    assert.equal(honest.code, 0, honest.text);

    const denial = await hook({
      cwd: dir,
      payload: { last_assistant_message: '本次交付没有任何未验证的事项，所有来源均已核实。' },
    });
    assert.equal(denial.code, 2, denial.text);
    assert.match(denial.text, /不能同时成立/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('hook：英文诚实声明放行，英文全称断言与未验证项矛盾要拦', async () => {
  const dir = await repoWithUnverified();
  try {
    const honest = await hook({
      cwd: dir,
      payload: { last_assistant_message: 'Done. The row-height claim was not verified because the design spec was unavailable.' },
    });
    assert.equal(honest.code, 0, honest.text);

    const overclaim = await hook({
      cwd: dir,
      payload: { last_assistant_message: 'Done. All sources were verified.' },
    });
    assert.equal(overclaim.code, 2, overclaim.text);
    assert.match(overclaim.text, /不能同时成立/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
