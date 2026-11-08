import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { launchBrowser, openPage } from '../src/observe/driver.mjs';
import { renderPage } from '../src/observe/web.mjs';

// 第三方真实登录门的闭环。之前只验证过"cookie/localStorage 注入进去了"和"本地起的
// 登录门能过"；换成真实第三方站点才知道 state 到底顶不顶用。
//
// 站点用 saucedemo.com（一个公开的练习用电商站）。账号是它自己**在登录页上公示**的
// 演示账号，不是任何人的私密凭据；要用别的就设 FK_DEMO_USER / FK_DEMO_PASS。
// 真网络只在显式开启时跑：默认不外发任何东西。
const BASE = 'https://www.saucedemo.com';
const DEMO_USER = process.env.FK_DEMO_USER ?? 'standard_user';
const DEMO_PASS = process.env.FK_DEMO_PASS ?? 'secret_sauce';
const netOn = process.env.FK_NET === '1';

let chromiumOk = true;
try {
  await import('playwright');
} catch {
  chromiumOk = false;
}

test('真网络（FK_NET=1 才跑）：第三方登录门——匿名被挡，--state 才拿到受保护内容', async (t) => {
  if (!chromiumOk) return t.skip('没装 Playwright，跳过真浏览器层');
  if (!netOn) return t.skip('设 FK_NET=1 才跑，默认不外发');

  const dir = await mkdtemp(join(tmpdir(), 'claimrail-login-'));
  const browser = await launchBrowser();
  try {
    // 1) 匿名访问受保护页：被挡回登录页，一个商品都看不到
    const anon = await openPage(browser, { url: `${BASE}/inventory.html`, viewport: '1280x800', timeoutMs: 30000 });
    assert.ok(!anon.page.url().includes('inventory.html'), `匿名没被挡：${anon.page.url()}`);
    assert.equal(await anon.page.locator('.inventory_item').count(), 0, '匿名看到了受保护内容');
    assert.ok(await anon.page.locator('#login-button').isVisible(), '匿名页不是登录页');
    await anon.context.close();

    // 2) 真登录一次，把 storage state 落盘（cookie 只落在临时目录，不进仓库）
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const login = await ctx.newPage();
    await login.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // 先确认用的是这个站点自己公示的演示账号——凭据不是我编的
    const hint = (await login.textContent('#login_credentials')).replace(/\s+/g, ' ');
    assert.ok(hint.includes(DEMO_USER), `登录页没公示这个账号：${hint.slice(0, 80)}`);
    await login.fill('#user-name', DEMO_USER);
    await login.fill('#password', DEMO_PASS);
    await login.click('#login-button');
    await login.waitForURL(/inventory\.html/, { timeout: 30000 });
    const statePath = join(dir, 'state.json');
    await ctx.storageState({ path: statePath });
    await ctx.close();

    // 3) 把 state 交给工具：才拿到受保护内容，而且采集得动
    const authed = await openPage(browser, { url: `${BASE}/inventory.html`, state: statePath, viewport: '1280x800', timeoutMs: 30000 });
    assert.ok(authed.page.url().includes('inventory.html'), `带 state 仍被踢走：${authed.page.url()}`);
    await authed.page.waitForSelector('.inventory_item', { timeout: 20000 });
    assert.ok((await authed.page.locator('.inventory_item').count()) >= 1, '带 state 没看到受保护内容');

    const report = await renderPage(authed.page, { outDir: dir, name: 'inventory' });
    await authed.context.close();
    assert.ok(report.counts.texts >= 10, `受保护页采集到的文本太少：${JSON.stringify(report.counts)}`);
    assert.ok(report.counts.interactive >= 5, '受保护页没采到可交互元素');
    assert.equal(report.checks.length, 5, '五项检查没跑齐');
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
});
