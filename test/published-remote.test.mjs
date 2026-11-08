// 「已发布」只认远端默认分支与 tag（2026-11-08 用户拍板收窄）。
// 旧实现把任何已推送的提交都算成发布：推一个功能分支就会让理由句写「已发布」，
// 把人指去查发布记录，而那里什么都没有。收窄之后 false low 的风险靠"未知 → null → high"兜住：
// 远端默认分支读不出来时，不猜。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { headOnRemoteDefault } from '../src/observe/git.mjs';
import { check } from '../src/cli.mjs';

const g = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

async function repo({ branch = 'main', push = true, setHead = false } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'fk-remote-'));
  const remote = join(base, 'remote.git');
  const dir = join(base, 'wt');
  await mkdir(dir, { recursive: true });
  g(base, ['init', '-q', '--bare', remote]);
  g(dir, ['init', '-q']);
  g(dir, ['config', 'user.email', 'r@r']);
  g(dir, ['config', 'user.name', 'r']);
  await writeFile(join(dir, 'package.json'), '{"name":"probe"}', 'utf8');
  g(dir, ['add', '-A']);
  g(dir, ['commit', '-qm', 'init']);
  g(dir, ['branch', '-m', branch]);
  g(dir, ['remote', 'add', 'origin', remote]);
  if (push) g(dir, ['push', '-q', '-u', 'origin', branch]);
  if (setHead) g(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${branch}`]);
  return { base, dir };
}

const withRepo = async (opts, fn) => {
  const { base, dir } = await repo(opts);
  try {
    return await fn(dir);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
};

test('默认分支 main 已推送：返回上游名，而不是笼统的 true', async () => {
  await withRepo({ branch: 'main' }, async (dir) => {
    assert.equal(await headOnRemoteDefault(dir), 'origin/main');
  });
});

test('自定义默认分支靠 origin/HEAD 认出来，不写死 main/master', async () => {
  await withRepo({ branch: 'trunk', setHead: true }, async (dir) => {
    assert.equal(await headOnRemoteDefault(dir), 'origin/trunk');
  });
});

test('功能分支已推送不算发布', async () => {
  await withRepo({ branch: 'main', setHead: true }, async (dir) => {
    g(dir, ['checkout', '-q', '-b', 'feat']);
    g(dir, ['commit', '-q', '--allow-empty', '-m', 'feat']);
    g(dir, ['push', '-q', '-u', 'origin', 'feat']);
    assert.equal(await headOnRemoteDefault(dir), false);
  });
});

test('功能分支的提交已合进默认分支：仍算发布，别漏掉已合并的改动', async () => {
  await withRepo({ branch: 'main', setHead: true }, async (dir) => {
    g(dir, ['checkout', '-q', '-b', 'feat']);
    g(dir, ['commit', '-q', '--allow-empty', '-m', 'feat']);
    g(dir, ['push', '-q', '-u', 'origin', 'feat']);
    g(dir, ['checkout', '-q', 'main']);
    g(dir, ['merge', '-q', '--ff-only', 'feat']);
    g(dir, ['push', '-q', 'origin', 'main']);
    g(dir, ['checkout', '-q', 'feat']);
    assert.equal(await headOnRemoteDefault(dir), 'origin/main');
  });
});

test('本地领先上游：HEAD 本身没推上去，不算发布', async () => {
  await withRepo({ branch: 'main' }, async (dir) => {
    g(dir, ['commit', '-q', '--allow-empty', '-m', 'ahead']);
    assert.equal(await headOnRemoteDefault(dir), false);
  });
});

test('远端默认分支读不出来、分支名也不是 main/master：返回未知，不猜', async () => {
  await withRepo({ branch: 'feature-x' }, async (dir) => {
    assert.equal(await headOnRemoteDefault(dir), null);
  });
});

test('没有上游：确定未发布，不是未知', async () => {
  await withRepo({ branch: 'main', push: false }, async (dir) => {
    assert.equal(await headOnRemoteDefault(dir), false);
  });
});

test('理由句说「已推送/已发布」并带上游名——不再把功能分支说成已发布', async () => {
  await withRepo({ branch: 'main' }, async (dir) => {
    await mkdir(join(dir, '.claimrail'), { recursive: true });
    await writeFile(
      join(dir, '.claimrail', 'decisions.json'),
      JSON.stringify({
        schema: 1,
        task_class: 'ui-new',
        forks: [
          {
            fork: '滚动条覆盖还是留 gutter',
            options: ['覆盖式', '留 gutter'],
            picked: '留 gutter',
            evidence: null,
            target: { file: 'package.json' },
            cost_if_wrong: 'low',
            verified: false,
          },
        ],
      }),
      'utf8',
    );
    const res = await check({ cwd: dir });
    assert.equal(res.code, 1, res.text);
    assert.match(res.text, /已推送\/已发布或有副作用：pushed:origin\/main/, res.text);
    assert.match(res.text, /【开工前 1 条 · 需你定】/, res.text);
  });
});
