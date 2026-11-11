import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hook } from '../src/cli.mjs';

// Stop 钩子是 precedent/web 两档最常见的入口。`check --allow-net` 已经能回访，
// 但 hook() 以前没有把 allowNet 传给 check()——即使宿主配置里写了 --allow-net，
// 钩子仍然报"未获同意"，precedent 档在宿主接线里永远不可用。
// 这里用本地 HTTP 服务做端到端：flag 没传时是"未获同意"，传了才会真的去 fetch。

const quote = 'This quote is long enough to be verified by the program.';

async function repoWithPrecedent(base) {
  const dir = await mkdtemp(join(tmpdir(), 'fk-hook-net-'));
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
      task_class: 'docs-new',
      forks: [
        {
          fork: '三个来源是否真的收敛',
          options: ['按来源', '按默认'],
          picked: '按来源',
          evidence: {
            kind: 'precedent',
            sources: [
              { url: `${base}/a`, quote },
              { url: `${base}/b`, quote },
              { url: `${base}/c`, quote },
            ],
          },
          target: { file: 'package.json' },
          cost_if_wrong: 'low',
          verified: false,
        },
      ],
    }),
    'utf8',
  );
  return dir;
}

test('hook：allowNet 要真的传到 check；不传时不得外发', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<html><body><p>${quote}</p></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = await repoWithPrecedent(base);
  try {
    const denied = await hook({ cwd: dir, payload: {} });
    assert.match(denied.text, /未获同意/, denied.text);

    const allowed = await hook({ cwd: dir, allowNet: true, payload: {} });
    assert.doesNotMatch(allowed.text, /未获同意/, allowed.text);
    // 三个 URL 是同一个注册域：真的回访了，才会走到"域名去重后只有 1 个"这一步。
    assert.match(allowed.text, /只有 1 个独立域名/, allowed.text);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
