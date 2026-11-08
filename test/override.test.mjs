// 程序把模型自报的 low 覆写成 high 时，理由必须说清"因为什么"。
// 2026-11-08 实测：fan-in 达到门槛触发 high，理由句却是
// 「已推送/已发布或有副作用：」——冒号后空白，因为那两个数组恰好是空的。
// 照着这句话去查的人查不到 fan-in。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { check } from '../src/cli.mjs';
import { FAN_IN_HIGH } from '../src/cost.mjs';

const g = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

test('fan-in 触发的 high 必须在覆写理由里点名引用数', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-override-'));
  try {
    g(dir, ['init', '-q']);
    g(dir, ['config', 'user.email', 'o@o']);
    g(dir, ['config', 'user.name', 'o']);
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'hot.ts'), 'export const hot = 1;\n', 'utf8');
    // 让 hot.ts 的引用数刚好达到 FAN_IN_HIGH：每个文件一行 import，排除自身
    for (let i = 0; i < FAN_IN_HIGH + 1; i += 1) {
      await writeFile(join(dir, 'src', `u${i}.ts`), `import { hot } from './hot.ts';\n`, 'utf8');
    }
    await writeFile(join(dir, 'package.json'), '{"name":"probe"}', 'utf8');
    g(dir, ['add', '-A']);
    g(dir, ['commit', '-qm', 'init']);
    await mkdir(join(dir, '.claimrail'), { recursive: true });
    await writeFile(
      join(dir, '.claimrail', 'decisions.json'),
      JSON.stringify({
        schema: 1,
        task_class: 'refactor',
        forks: [
          {
            fork: '热路径的写法',
            options: ['A', 'B'],
            picked: 'A',
            evidence: null,
            target: { file: 'src/hot.ts' },
            cost_if_wrong: 'low',
            verified: false,
          },
        ],
      }),
      'utf8',
    );

    const r = await check({ cwd: dir });
    assert.match(r.text, /申报 low → 程序 high/, r.text);
    const line = r.text.split('\n').find((l) => l.includes('申报 low → 程序 high'));
    assert.ok(line, r.text);
    assert.doesNotMatch(line, /有副作用：\s*$/, `理由句不许留空：${line}`);
    assert.match(line, /引用数 \d+ 处/, `理由必须点名 fan-in：${line}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
