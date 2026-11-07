import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { check, init, parse, help, unknownCmd, LEDGER_PATH } from '../src/cli.mjs';

// 参数解析、帮助、文档与命名的一致性。从 cli.test.mjs 拆出来：那个文件被 20KB
// 提交钩子拒收，而这一组测试只关心"命令行长什么样、文档里写的名字对不对"。

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

// 新用户第一屏就是 --help。之前 parse() 把不认识的第一个词当 check，位置参数当台账路径，
// 于是 `claimrail --help` 会去读一份叫 "--help" 的台账、`claimrail foo` 读 "foo"。
test('parse：--help / -h 走帮助，不当成 check', () => {
  for (const argv of [['--help'], ['-h'], ['help'], ['check', '--help']]) {
    const r = parse(argv);
    assert.equal(r.cmd, 'help', `${argv.join(' ')} → ${r.cmd}`);
  }
});

test('parse：拼错的命令要报错，不许静默退化成 check', () => {
  const r = parse(['chekc']);
  assert.equal(r.cmd, 'unknown');
  assert.equal(r.flags.unknown, 'chekc');
});

test('parse：合法命令与位置参数照旧', () => {
  assert.equal(parse([]).cmd, 'check', '无参数仍然是 check');
  const withLedger = parse(['check', 'custom.json']);
  assert.equal(withLedger.cmd, 'check');
  assert.equal(withLedger.flags.ledger, 'custom.json');
  assert.equal(parse(['invalidate', 'ui.spacing']).flags.key, 'ui.spacing');
});

test('帮助文本列出全部命令，且退出码 0', async () => {
  const r = await help({});
  assert.equal(r.code, 0);
  for (const c of ['init', 'check', 'web', 'hook', 'record', 'rules', 'invalidate']) {
    assert.match(r.text, new RegExp(`\\b${c}\\b`), `帮助里没有 ${c}`);
  }
});

test('未知命令：退出码非 0，且明确说"没有这个命令"并给出 help 提示', async () => {
  const r = await unknownCmd({ command: 'chekc' });
  assert.equal(r.code, 1);
  assert.match(r.text, /没有这个命令/);
  assert.match(r.text, /chekc/);
  assert.match(r.text, /--help/);
});

// 端到端接线：parse() 把拼错的命令放在 flags.unknown，handler 必须从那里读。
// 只测 unknownCmd({command}) 会漏掉这个错配——真实 CLI 报过"没有这个命令："后面是空的。
test('parse → unknownCmd 接线：拼错的命令名要真的出现在报错里', async () => {
  const { cmd, flags } = parse(['chekc']);
  assert.equal(cmd, 'unknown');
  const r = await unknownCmd(flags);
  assert.match(r.text, /没有这个命令：chekc/, `报错里没带命令名：${r.text.split('\n')[0]}`);
});

// 文档双语化之后，中英两版必须同时进包，且互相链得上。
// 少一个链接就是"英文用户点不开中文版"，而 npm 页面只显示 README.md。
test('中英双语文档：两版都在包内，且互相链接', async () => {
  const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('README.md'), '英文 README 不在 files 里');
  assert.ok(pkg.files.includes('README.zh-CN.md'), '中文 README 不在 files 里');

  const en = await readFile(join(repo, 'README.md'), 'utf8');
  const zh = await readFile(join(repo, 'README.zh-CN.md'), 'utf8');
  assert.match(en, /README\.zh-CN\.md/, '英文版没有链到中文版');
  assert.match(zh, /README\.md/, '中文版没有链到英文版');
  assert.ok(existsSync(join(repo, 'README.zh-CN.md')));
});

test('SKILL.md 的 description 中英双语，英文关键词也要能触发', async () => {
  const skill = await readFile(join(repo, 'skill', 'SKILL.md'), 'utf8');
  const desc = skill.split('---')[1].split('description:')[1].split('\n')[0];
  assert.match(desc, /决策台账/, '中文触发词丢了');
  assert.match(desc, /decision ledger/i, '英文触发词丢了');
  assert.ok(desc.length < 1024, `description 过长（${desc.length}），多数宿主会截断`);
});

// 改名（forklight → claimrail）之后，名字必须四处一致：包名、bin、台账目录、AGENTS 指路 marker。
// 漏一处就会出现"装了 claimrail、台账却写进 .forklight"这种半改状态。
test('名字四处一致：包名 / bin / 台账目录 / AGENTS marker', async () => {
  const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'claimrail');
  assert.deepEqual(Object.keys(pkg.bin), ['claimrail']);
  assert.equal(LEDGER_PATH.split('\\').join('/'), '.claimrail/decisions.json');

  const dir = await mkdtemp(join(tmpdir(), 'claimrail-name-'));
  try {
    await init({ cwd: dir });
    const agents = await readFile(join(dir, 'AGENTS.md'), 'utf8');
    assert.match(agents, /<!-- claimrail:begin -->/, 'marker 没跟着改名');
    assert.doesNotMatch(agents, /forklight/, '指路里还留着旧名');
    assert.ok(existsSync(join(dir, '.claimrail', 'decisions.json')), '台账没写进 .claimrail/');
    const gi = await readFile(join(dir, '.gitignore'), 'utf8');
    assert.match(gi, /\.claimrail\/shots\//, '.gitignore 里的路径没跟着改名');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
