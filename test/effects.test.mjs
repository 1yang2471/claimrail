import test from 'node:test';
import assert from 'node:assert/strict';
import { scanEffects, scanDiff, addedCode, EFFECT_KINDS } from '../src/observe/effects.mjs';

// 扫描单位是"单个文件的新增行"。所以这里的用例都按真实 diff 形状写：
// 一个 header + 若干 +/- 行，多文件就拼多段。

const chunk = (path, added = [], removed = [], context = ['unchanged line']) =>
  [
    `diff --git a/${path} b/${path}`,
    ...context.map((c) => ` ${c}`),
    ...removed.map((r) => `-${r}`),
    ...added.map((a) => `+${a}`),
  ].join('\n');

test('递归删除的几种真实写法都认', () => {
  for (const cmd of [
    'rm -rf ./dist',
    'rm -fr /tmp/build',
    'rmdir /s /q D:\\data',
    'powershell Remove-Item -LiteralPath $p -Recurse -Force',
    'shutil.rmtree(path)',
    'fs.rmSync(dir, { recursive: true })',
  ]) {
    assert.deepEqual(scanEffects(cmd), ['recursive-delete'], cmd);
  }
});

test('git rm -r 是可恢复的索引操作，不算不可逆删除', () => {
  assert.deepEqual(scanEffects('git rm -r --cached dist'), []);
  assert.deepEqual(scanEffects('git rm -rf path'), []);
});

test('单文件删除与 SQL、迁移、历史重写、发布、部署各自归类', () => {
  assert.ok(scanEffects('os.remove(old_path)').includes('file-delete'));
  assert.ok(scanEffects('await fs.unlink(tmp)').includes('file-delete'));
  assert.ok(scanEffects('ALTER TABLE x DROP COLUMN y').includes('sql-destructive'));
  assert.ok(scanEffects('npx prisma migrate deploy').includes('migration'));
  assert.ok(scanEffects('git push --force origin main').includes('history-rewrite'));
  assert.ok(scanEffects('git clean -fdx').includes('history-rewrite'));
  assert.ok(scanEffects('npm publish --access public').includes('publish'));
  assert.ok(scanEffects('vercel --prod').includes('deploy'));
});

test('普通业务代码不该被当成副作用——误拦一次就会教会用户无视整屏清单', () => {
  for (const line of [
    "await fetch('/api/user', { method: 'POST', body: json })",
    'router.post("/login", handler)',
    'docker compose up -d',
    'git push origin feature/x',
    'rm file.txt',
    'npm run build',
    'SELECT * FROM users WHERE id = $1',
    'const dir = "./tmp/build"',
  ]) {
    assert.deepEqual(scanEffects(line), [], line);
  }
});

test('空文本与脏输入返回空', () => {
  assert.deepEqual(scanEffects(''), []);
  assert.deepEqual(scanEffects(undefined), []);
  assert.deepEqual(scanEffects(null), []);
});

test('同一条规则命中多次只报一次，多种并列', () => {
  assert.deepEqual(scanEffects('rm -rf a\nrm -rf b'), ['recursive-delete']);
  assert.deepEqual(scanEffects('rm -rf ./x\ngit push --force'), ['recursive-delete', 'history-rewrite']);
});

// ---- diff 解析 ----

test('只看新增行：删除行与上下文行不算', () => {
  const files = addedCode(chunk('app.mjs', [], ['rm -rf ./dist']));
  assert.deepEqual(files, []);
});

test('测试、fixtures、文档、台账、memory、规则表本身都不算被执行的动作', () => {
  for (const p of [
    'test/x.test.mjs',
    'tests/y.mjs',
    'test/fixtures/cmd.sh',
    'docs/PRD.md',
    'README.md',
    '.claimrail/decisions.json',
    'memory/log.jsonl',
    'src/observe/effects.mjs',
  ]) {
    assert.deepEqual(addedCode(chunk(p, ['rm -rf ./x'])), [], p);
  }
});

test('台账里诚实描述危险选项的分叉，不再被扫成副作用', () => {
  // 曾经：诚实写出"要不要 rm -rf 旧缓存"的发布类任务，每次都被强制升 high
  assert.deepEqual(scanDiff(chunk('.claimrail/decisions.json', ['要不要 rm -rf 旧缓存并 git push --force'])) , []);
});

test('文件路径不参与匹配', () => {
  // 曾经把 path 拼进待扫文本，一个叫 rimraf-helper 的空文件就被报成 file-delete
  const files = addedCode(chunk('src/rimraf-helper.mjs', ['export const noop = 1']));
  assert.equal(files.length, 1);
  assert.deepEqual(scanEffects(files[0].lines.join('\n')), []);
  assert.deepEqual(scanDiff(chunk('src/rimraf-helper.mjs', ['export const noop = 1'])), []);
});

test('跨文件不许被缝成一条命令', () => {
  const two = [chunk('a.ps1', ['Remove-Item c:\\tmp']), chunk('b.txt', ['-Recurse x'])].join('\n');
  assert.deepEqual(scanDiff(two), [], '两个无关文件不该合成 recursive-delete');
  assert.deepEqual(scanDiff(chunk('a.ps1', ['Remove-Item c:\\tmp -Recurse'])), ['recursive-delete'], '同一条命令内该认');
});

test('rename 只看落地路径：搬进执行区就要扫', () => {
  const rename = ['diff --git a/docs/deploy.sh b/src/deploy.sh', 'similarity index 100%', 'rename from docs/deploy.sh', 'rename to src/deploy.sh', '+rm -rf /var/data'].join('\n');
  assert.deepEqual(scanDiff(rename), ['recursive-delete']);
});

test('搬进豁免区就不扫', () => {
  const rename = ['diff --git a/src/deploy.sh b/docs/deploy.sh', 'rename from src/deploy.sh', 'rename to docs/deploy.sh', '+rm -rf /var/data'].join('\n');
  assert.deepEqual(scanDiff(rename), []);
});

test('带空格与引号的 diff header 不丢内容', () => {
  const plain = addedCode(chunk('src/my file.mjs', ['vercel --prod']));
  assert.equal(plain.length, 1);
  assert.deepEqual(scanDiff(chunk('src/my file.mjs', ['vercel --prod'])), ['deploy']);

  const quoted = ['diff --git "a/src/\\346\\270\\205.mjs" "b/src/\\346\\270\\205.mjs"', '+rm -rf x'].join('\n');
  assert.deepEqual(scanDiff(quoted), [], '认不出来的 header 宁可整段不扫，也别把内容归到别的文件');
});

test('多文件混排只保留被执行的那些', () => {
  const out = addedCode([chunk('test/a.test.mjs', ['rm -rf /']), chunk('scripts/deploy.sh', ['vercel --prod'])].join('\n'));
  assert.deepEqual(out.map((f) => f.path), ['scripts/deploy.sh']);
  assert.deepEqual(out[0].lines, ['vercel --prod']);
});

test('非 diff 输入不会炸', () => {
  assert.deepEqual(addedCode(''), []);
  assert.deepEqual(addedCode(undefined), []);
  assert.deepEqual(scanDiff('随便一段文本'), []);
});

test('kind 名称去重且不含第三种档位', () => {
  assert.equal(new Set(EFFECT_KINDS).size, EFFECT_KINDS.length);
});
