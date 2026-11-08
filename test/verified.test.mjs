// verified 是台账里唯一被接受的自供字段，所以更要把边界钉死：
// 它只是写给人和 reviewer 看的申报，判定只看证据回验结果。
// 这条测试的用法是"防回归"——将来有人把 verified 接进门槛，这里必须变红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { check } from '../src/cli.mjs';
import { repoWithEvidence } from './helpers.mjs';

test('verified 只是申报：true/false 不改变任何判定', async () => {
  const dir = await repoWithEvidence();
  try {
    const p = join(dir, '.claimrail', 'decisions.json');
    const ledger = JSON.parse(await readFile(p, 'utf8'));
    const run = async (verified) => {
      ledger.forks[0].verified = verified;
      await writeFile(p, JSON.stringify(ledger, null, 2), 'utf8');
      return check({ cwd: dir });
    };

    const yes = await run(true);
    const no = await run(false);
    assert.equal(yes.code, no.code);
    assert.deepEqual(yes.data, no.data);
    // 自报 false 不等于"程序判了未验证"：证据成立时它照样是 0 条未验证
    assert.equal(no.data.unverified.length, 0);
    assert.match(no.text, /未验证 0 条/, no.text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
