import test from 'node:test';
import assert from 'node:assert/strict';
import { scanEffects, addedCode, EFFECT_KINDS } from '../src/observe/effects.mjs';

const hits = (t) => scanEffects(t);

test('递归删除的几种真实写法都认', () => {
  for (const cmd of [
    'rm -rf ./dist',
    'rm -fr /tmp/build',
    'rmdir /s /q D:\\data',
    'powershell Remove-Item -LiteralPath $p -Recurse -Force',
    'shutil.rmtree(path)',
    'fs.rmSync(dir, { recursive: true })',
  ]) {
    assert.deepEqual(hits(cmd), ['recursive-delete'], cmd);
  }
});

test('单文件删除也算不可逆', () => {
  assert.ok(hits('os.remove(old_path)').includes('file-delete'));
  assert.ok(hits('await fs.unlink(tmp)').includes('file-delete'));
});

test('破坏性 SQL', () => {
  assert.ok(hits('ALTER TABLE x DROP COLUMN y').includes('sql-destructive'));
  assert.ok(hits('DELETE FROM sessions').includes('sql-destructive'));
});

test('迁移命令', () => {
  assert.ok(hits('npx prisma migrate deploy').includes('migration'));
  assert.ok(hits('alembic upgrade head').includes('migration'));
});

test('历史重写与强推', () => {
  assert.ok(hits('git push --force origin main').includes('history-rewrite'));
  assert.ok(hits('git reset --hard HEAD~3').includes('history-rewrite'));
  assert.ok(hits('git clean -fdx').includes('history-rewrite'));
});

test('发布与部署', () => {
  assert.ok(hits('npm publish --access public').includes('publish'));
  assert.ok(hits('vercel --prod').includes('deploy'));
  assert.ok(hits('terraform apply -auto-approve').includes('deploy'));
});

test('普通业务代码不该被当成副作用——误拦一次就会教会用户无视整屏清单', () => {
  const harmless = [
    "await fetch('/api/user', { method: 'POST', body: json })",
    'router.post("/login", handler)',
    'docker compose up -d',
    'git push origin feature/x',
    'git commit -m "feat: x"',
    'rm file.txt',
    'npm run build',
    'SELECT * FROM users WHERE id = $1',
  ];
  for (const line of harmless) assert.deepEqual(hits(line), [], line);
});

test('空文本与脏输入都返回空', () => {
  assert.deepEqual(hits(''), []);
  assert.deepEqual(hits(undefined), []);
  assert.deepEqual(hits(null), []);
});

test('同一条规则命中多次只报一次', () => {
  assert.deepEqual(hits('rm -rf a\nrm -rf b\nrm -rf c'), ['recursive-delete']);
});

test('多种副作用并列报出', () => {
  assert.deepEqual(hits('rm -rf ./x\ngit push --force'), ['recursive-delete', 'history-rewrite']);
});

test('kind 名称用于文档与错误信息，且没有第三种档位', () => {
  assert.ok(Array.isArray(EFFECT_KINDS));
  assert.equal(new Set(EFFECT_KINDS).size, EFFECT_KINDS.length);
});

// ---- 扫描对象筛选：这是把"扫描器扫到自己"那个坑填上的一环 ----

const diff = (path, added, context = 'unchanged') =>
  ['diff --git a/' + path + ' b/' + path, '@@ -1 +1 @@', ' ' + context, '+' + added].join('\n');

test('只看新增行，上下文与删除行不触发', () => {
  const d = ['diff --git a/app.mjs b/app.mjs', '@@ -1,2 +1 @@', '-rm -rf ./dist', ' const x = 1'].join('\n');
  assert.equal(addedCode(d).includes('rm -rf'), false);
});

test('测试、fixtures、文档、规则表本身都不算被执行的动作', () => {
  for (const p of ['test/effects.test.mjs', 'tests/a.mjs', 'test/fixtures/cmd.sh', 'docs/PRD.md', 'src/observe/effects.mjs']) {
    assert.equal(addedCode(diff(p, 'rm -rf ./x')).includes('rm -rf'), false, p);
  }
});

test('业务代码里的删除命令照常算数', () => {
  const out = addedCode(diff('scripts/cleanup.mjs', 'rm -rf ./cache'));
  assert.match(out, /rm -rf \.\/cache/);
  assert.deepEqual(scanEffects(out), ['recursive-delete']);
});

test('多文件混排时只保留被执行的那些，并带上所属路径', () => {
  const out = addedCode([diff('test/a.test.mjs', 'rm -rf /'), diff('run/deploy.sh', 'vercel --prod')].join('\n'));
  assert.doesNotMatch(out, /rm -rf/);
  assert.match(out, /run\/deploy\.sh\nvercel --prod/);
});

test('非 diff 输入不会炸', () => {
  assert.equal(addedCode(''), '');
  assert.equal(addedCode(undefined), '');
});
