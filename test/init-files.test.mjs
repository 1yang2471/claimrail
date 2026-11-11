import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { init, LEDGER_PATH } from '../src/cli.mjs';

// init 在目标仓库里写什么。从 cli.test.mjs 拆出来：那个文件被 20KB 提交钩子拒收，
// 而这一组只关心 init 的产物（模板、.gitignore、AGENTS 指路段、baseline）。

test('init 建模板、说清数据去向，并让偏好与截图不进 git', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claimrail-init-'));
  try {
    const res = await init({ cwd: dir });
    assert.equal(res.code, 0);
    assert.match(res.text, /已建/);
    assert.match(res.text, /decisions\.json\s+进 git/);
    assert.match(res.text, /memory\//);

    const ledger = JSON.parse(await readFile(join(dir, LEDGER_PATH), 'utf8'));
    assert.equal(ledger.schema, 1);
    assert.deepEqual(ledger.forks, []);

    const gi = await readFile(join(dir, '.gitignore'), 'utf8');
    for (const p of ['memory/log.jsonl', 'memory/denied.json', '.claimrail/shots/', '.claimrail/storage.json']) assert.ok(gi.includes(p), p);
    // storage.json 是 SKILL.md 教的 --state 落点，里面是登录 cookie：不忽略它，照协议做的
    // 用户会把凭据提交进 git（UX 审查 2026-11-11 阻断项）。init 的输出也要把这一条说破。
    assert.match(res.text, /登录态/, 'init 的数据去向通知没提登录态文件');
    assert.ok(!/^memory\/$/m.test(gi), `init 把整个 memory/ 目录忽略了：${gi}`);
    // 不许写 '*.png'：那会把目标仓库里所有真实图片一起排除掉（静默丢数据）
    assert.ok(!gi.includes('*.png'), `init 给目标仓库写了 *.png 通配：${gi}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 指路段必须能在任何目标仓库里工作：Python/Go 仓库没有 node_modules，
// 全局 npm link 也不会在目标仓库里创建 node_modules/claimrail。指向一个
// 不存在的文件，agent 第一步就读空；应该指向能从安装包自身取协议的 skill 命令。
test('init 的 AGENTS 指路段指向 claimrail skill 命令，不是目标仓库的 node_modules 路径', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claimrail-pointer-'));
  try {
    await init({ cwd: dir });
    const agents = await readFile(join(dir, 'AGENTS.md'), 'utf8');
    assert.match(agents, /claimrail skill/, agents);
    assert.doesNotMatch(agents, /node_modules[\\/]claimrail[\\/]skill[\\/]SKILL.md/, agents);
    // 指路段只给命令不给退路：目标仓库（Python/Go）里 claimrail 不在 PATH 时，
    // agent 照做会撞 command not found 然后无人指路（UX 审查 2026-11-11 #10）
    assert.match(agents, /npm link/, agents);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 目标仓库可能本来就有 memory/（AI 代理、知识库、缓存都用这个名）。
// init 只该忽略自己的两个文件，不能把用户目录整个吞掉——实测过：init 之后
// 新建的 memory/notes.md 被 .gitignore:2:memory/ 静默忽略。
test('init 只忽略 claimrail 自己的 memory 文件，不吞掉目标仓库已有的 memory/', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claimrail-memory-'));
  try {
    await mkdir(join(dir, 'memory'), { recursive: true });
    await writeFile(join(dir, 'memory', 'notes.md'), '用户的既有数据\n', 'utf8');
    const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    g(['init', '-q']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    g(['add', '-A']);
    g(['commit', '-qm', 'init']);

    await init({ cwd: dir });
    await writeFile(join(dir, 'memory', 'new-user-file.md'), '新数据\n', 'utf8');

    const userFile = spawnSync('git', ['check-ignore', 'memory/new-user-file.md'], { cwd: dir, encoding: 'utf8' });
    assert.notEqual(userFile.status, 0, `用户的 memory 新文件被忽略了：${userFile.stdout}`);
    const ownLog = spawnSync('git', ['check-ignore', 'memory/log.jsonl'], { cwd: dir, encoding: 'utf8' });
    assert.equal(ownLog.status, 0, `claimrail 自己的 log 没被忽略：${ownLog.stderr}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('init 不覆盖已有台账——那是别人的申报记录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claimrail-init2-'));
  try {
    await init({ cwd: dir });
    const file = join(dir, LEDGER_PATH);
    await writeFile(file, '{"schema":1,"task_class":"typo","forks":[],"no_fork_reason":"我写的"}', 'utf8');

    const res = await init({ cwd: dir });
    assert.match(res.text, /已存在，不动/);
    assert.match(await readFile(file, 'utf8'), /我写的/);
    assert.ok(existsSync(join(dir, '.gitignore')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
