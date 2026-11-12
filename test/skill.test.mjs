// G2 群体（AI agent）的实测最大单笔负担：双语协议同文件，每个会话白读一半。
// 拆分后：默认打印中文版（原英文节位置留指路），--en 打印英文版。
// frontmatter 不动——宿主扫描触发靠它（args.test 的双语 description 用例继续钉住）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { skill } from '../src/cli.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

test('skill() 默认打印中文协议，原英文节位置留 --en 指路', async () => {
  const r = await skill();
  assert.equal(r.code, 0);
  assert.match(r.text, /claimrail skill --en/);
  assert.doesNotMatch(r.text, /# claimrail \(English\)/);
});

test('skill({ en: true }) 打印英文协议正文（不含中文正文）', async () => {
  const r = await skill({ en: true });
  assert.equal(r.code, 0);
  assert.match(r.text, /# claimrail \(English\)/);
  assert.match(r.text, /Never do this/);
  assert.doesNotMatch(r.text, /证据分五档/);
});

test('命令行入口：skill --en 可用，--en 不被当未知选项', async () => {
  const zh = spawnSync(process.execPath, [join(repo, 'src', 'cli.mjs'), 'skill'], { encoding: 'utf8' });
  assert.equal(zh.status, 0, zh.stderr);
  assert.doesNotMatch(zh.stdout, /# claimrail \(English\)/);
  const en = spawnSync(process.execPath, [join(repo, 'src', 'cli.mjs'), 'skill', '--en'], { encoding: 'utf8' });
  assert.equal(en.status, 0, en.stderr);
  assert.match(en.stdout, /# claimrail \(English\)/);
});
