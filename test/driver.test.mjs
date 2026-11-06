import test from 'node:test';
import assert from 'node:assert/strict';
import { nameFromUrl, parseViewports } from '../src/observe/driver.mjs';

// 这一层不起浏览器，只钉两个"会偷换证据"的纯函数。

test('不同 URL 不得收敛成同一个文件名（曾经三次跑互相覆盖）', () => {
  const urls = [
    'file:///D:/app/ui/index.html',
    'file:///D:/docs/index.html',
    'file:///D:/frontend/index.html',
    'https://ex.com/chat',
    'https://ex.com/chat/',
    'https://ex.com/chat.html',
    'https://ex.com/chat?tab=2',
  ];
  const names = urls.map(nameFromUrl);
  assert.equal(new Set(names).size, names.length, JSON.stringify(names));
});

test('同一 URL 的名字必须稳定，否则台账里的引用会随重启失效', () => {
  const u = 'http://localhost:5173/chat';
  assert.equal(nameFromUrl(u), nameFromUrl(u));
});

test('名字仍然可读：末段做前缀，指纹只当后缀', () => {
  const n = nameFromUrl('file:///D:/workspace/proj/docs/index.html');
  assert.match(n, /^index-[A-Za-z0-9_-]{8}$/);
});

test('怪 URL 不能产出空名或路径分隔符', () => {
  for (const u of ['', '/', '\\', 'http://x', 'http://x/中文 页.html']) {
    const n = nameFromUrl(u);
    assert.ok(n.length > 8, `${u} → "${n}"`);
    assert.doesNotMatch(n, /[\\/]/, u);
  }
});

test('视口列表解析支持逗号、分号与空格分隔', () => {
  assert.deepEqual(parseViewports('390x700,1280x800'), ['390x700', '1280x800']);
  assert.deepEqual(parseViewports('390x700 1280x800'), ['390x700', '1280x800']);
  assert.deepEqual(parseViewports(''), []);
});
