import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { record, readLog, recordAnchor, anchors, rulesList, rulesText, invalidateRule } from '../src/store.mjs';
import { verify } from '../src/evidence.mjs';

// 这一层守的是"闭环真的闭"：存进去的必须能读出来，读出来的行号必须能被证据回验指到。
// 全部用真临时目录，不 mock 文件系统——mock 掉存储就是在测一个假数据库。

const withDir = async (fn) => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-store-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('第二次命中才升格，升格信息带得出处行号', async () => {
  await withDir(async (dir) => {
    const first = await record(dir, { key: 'card-gap', what: '卡片上下间距 8px 太挤' });
    assert.equal(first.promoted, null);
    assert.equal(first.hits, 1);

    const second = await record(dir, { key: 'card-gap', what: '卡片上下间距至少 16px' });
    assert.equal(second.hits, 2);
    assert.equal(second.promoted.key, 'card-gap');
    assert.deepEqual(second.promoted.sources, ['log#1', 'log#2']);

    const third = await record(dir, { key: 'other', what: '滚动条别压气泡' });
    assert.equal(third.promoted, null, '别的 key 不该被上一次升格带出来');
  });
});

test('规则文本自带出处指针，没有出处的规则无法被推翻', async () => {
  await withDir(async (dir) => {
    await record(dir, { key: 'card-gap', what: '卡片间距 8px 太挤' });
    await record(dir, { key: 'card-gap', what: '卡片上下间距至少 16px' });
    assert.match(await rulesText(dir), /\[来源: log#1,log#2]/);
  });
});

test('废规则只改缓存，原始 log 一条不少', async () => {
  await withDir(async (dir) => {
    await record(dir, { key: 'card-gap', what: '太挤' });
    await record(dir, { key: 'card-gap', what: '卡片上下间距至少 16px' });

    const { removed, remaining } = await invalidateRule(dir, 'card-gap');
    assert.equal(removed.length, 1);
    assert.deepEqual(remaining, []);
    assert.equal((await readLog(dir)).length, 2, '否决记录是真相，废规则不许删它');
  });
});

test('禁用名单落盘——重新读同一目录仍然禁着，否则下次重算规则又长回来', async () => {
  await withDir(async (dir) => {
    await record(dir, { key: 'card-gap', what: '太挤' });
    await record(dir, { key: 'card-gap', what: '要 16px' });
    await invalidateRule(dir, 'card-gap');
    assert.deepEqual(await rulesList(dir), [], '跨进程读取必须带着这条禁用记录');

    await record(dir, { key: 'card-gap', what: '第三次还是嫌挤' });
    assert.deepEqual(await rulesList(dir), [], '被废过的规则不因新命中自动复活');
  });
});

test('按 id 也能废，因为 log 里只有 key，而人会说"那条 r:card-gap"', async () => {
  await withDir(async (dir) => {
    await record(dir, { key: 'card-gap', what: '太挤' });
    await record(dir, { key: 'card-gap', what: '要 16px' });
    assert.equal((await invalidateRule(dir, 'r:card-gap')).removed.length, 1);
  });
});

test('废一条还不存在的规则要说清为什么，而不是静默成功', async () => {
  await withDir(async (dir) => {
    await record(dir, { key: 'card-gap', what: '只命中一次' });
    await assert.rejects(() => invalidateRule(dir, 'card-gap'), /命中满两次/);
    await assert.rejects(() => invalidateRule(dir, 'nope'), /没有叫/);
  });
});

test('参照物也占 log 行号，但不进规则', async () => {
  await withDir(async (dir) => {
    await record(dir, { key: 'card-gap', what: '太挤' });
    await record(dir, { key: 'card-gap', what: '要 16px' });
    const a = await recordAnchor(dir, { key: 'chat-composer', what: '按 Linear composer 的间距' });
    assert.equal(a.n, 3);

    const list = await rulesList(dir);
    assert.deepEqual(list.map((r) => r.key), ['card-gap']);
    assert.deepEqual((await anchors(dir)).map((e) => e.what), ['按 Linear composer 的间距']);
  });
});

test('坏行让读和写都停下来——行号是引用坐标，坏一行就不能继续往上添', async () => {
  await withDir(async (dir) => {
    await record(dir, { key: 'k', what: '一条好好的记录' });
    const { appendFile, readFile } = await import('node:fs/promises');
    await appendFile(join(dir, 'memory', 'log.jsonl'), '{"key":"k","what": 坏\n', 'utf8');

    await assert.rejects(() => readLog(dir), /第 2 行/);
    await assert.rejects(() => record(dir, { key: 'k', what: '想追加的第二条' }), /第 2 行/);

    // 报错之后不许把坏行改掉或丢掉：那是需要人去看的问题，不是可以自动修的
    const raw = await readFile(join(dir, 'memory', 'log.jsonl'), 'utf8');
    assert.equal(raw.split(/\r?\n/).filter(Boolean).length, 2);
  });
});

// 闭环最关键的一步：写进去的记录必须能被证据回验按行号取到。
// 这条不通过，整套 memory 档证据就是自说自话。
test('端到端：record 写下的记录可以被台账按 log#n 引用', async () => {
  await withDir(async (dir) => {
    await record(dir, { key: 'card-gap', what: '卡片间距 8px 太挤' });
    await record(dir, { key: 'card-gap', what: '卡片上下间距至少 16px' });

    const logEntry = async (ref) => {
      const n = Number(/#(\d+)$/.exec(ref)?.[1]);
      const entries = await readLog(dir);
      const e = entries[n - 1];
      return e ? [e.what, e.why].filter(Boolean).join(' → ') : null;
    };
    const ctx = { logEntry };

    assert.equal((await verify({ kind: 'memory', ref: 'log#2', asserts: ['16px'] }, ctx)).ok, true);
    assert.equal((await verify({ kind: 'memory', ref: 'log#9', asserts: ['16px'] }, ctx)).ok, false);
    assert.equal((await verify({ kind: 'memory', ref: 'log#1', asserts: ['32px'] }, ctx)).ok, false);
  });
});

test('record 拒绝没有 key 的记录，否则命中次数无从统计', async () => {
  await withDir(async (dir) => {
    await assert.rejects(() => record(dir, { what: '丑' }), /key/);
    await assert.rejects(() => record(dir, { key: 'k' }), /what/);
    assert.deepEqual(await readLog(dir), []);
  });
});
test('否决记录写进去就能读回来，且带上可被引用的 log#n 行号', async () => {
  await withDir(async (dir) => {
    const r = await record(dir, { key: 'card-gap', what: '卡片上下间距至少 16px', why: '贴太紧' });
    assert.equal(r.n, 1);

    const log = await readLog(dir);
    assert.equal(log.length, 1);
    assert.equal(log[0].at, 1);
    assert.equal(log[0].key, 'card-gap');
    assert.equal(log[0].what, '卡片上下间距至少 16px');
    assert.equal(log[0].why, '贴太紧');
    assert.equal(log[0].kind, 'rejection');
  });
});
