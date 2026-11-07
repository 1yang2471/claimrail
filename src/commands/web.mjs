// web 命令：起浏览器、按视口采集、渲染一屏报告。
// 从 cli.mjs 拆出来是因为提交钩子按 token 拒收超大文件——这一段没有自己的状态，
// 只依赖 driver 与 web 观察层，单独成文件不引入任何第二份实现。
import { join } from 'node:path';

import { renderPage } from '../observe/web.mjs';
import { openPage, launchBrowser, parseViewports, nameFromUrl } from '../observe/driver.mjs';

export async function web({ url, state, viewport = '390x700,1280x800', out = join('.forklight', 'shots'), name, cwd = process.cwd() } = {}) {
  if (!url) return { code: 1, text: '用法：forklight web --url <地址> [--viewport 390x700,1280x800] [--state 登录态.json] [--out .forklight/shots]' };

  let browser;
  try {
    browser = await launchBrowser();
  } catch (err) {
    return { code: 1, text: `浏览器没起来：${err.message}` };
  }

  const blocks = [];
  let red = false;

  try {
    for (const vp of parseViewports(viewport)) {
      let session;
      try {
        session = await openPage(browser, { url, state, viewport: vp });
      } catch (err) {
        blocks.push(`${vp}：页面没打开 —— ${err.message}`);
        red = true;
        continue;
      }

      try {
        const base = name ?? nameFromUrl(url);
        const vlabel = String(vp).replace(/×/g, 'x');
        const shotName = `${base}@${vlabel}`;
        const report = await renderPage(session.page, {
          outDir: join(cwd, out),
          name: shotName,
          label: `${url} @ ${vlabel}`,
          focusProbe: session.focusProbe,
        });

        const ref = join(out, `${shotName}.png`).replaceAll('\\', '/');
        const green = report.checks.filter((c) => c.ok === true).map((c) => c.id);
        const undecided = report.checks.filter((c) => c.ok === null).map((c) => c.id);
        if (report.checks.some((c) => c.ok === false)) red = true;

        blocks.push(
          [
            `${vp} · 容器 ${report.counts.scrollContainers} · 文本 ${report.counts.texts} · 可交互 ${report.counts.interactive}（真实 Tab 探到 ${report.counts.focusProbed}）· 固定条 ${report.counts.fixedRects} → ${ref}`,
            ...report.checks.map((c) => `  ${c.ok === true ? '✓' : c.ok === false ? '✗' : '–'} ${c.id}${c.detail ? `：${c.detail}` : ''}`),
            // 只许引用绿的项。把"未判"写成"已验证"是这套机制最不能出现的事。
            green.length ? `  可引用：{ "kind": "render", "ref": "${ref}", "asserts": [${green.map((g) => `"${g}"`).join(', ')}] }` : '  没有一项真的判过——这份报告不能当证据',
            undecided.length ? `  未判（不作数）：${undecided.join('、')}` : '',
            // 像素补背景要说出来：读者得知道这一项是读截图读出来的，不是读样式读出来的
            report.pixelBackgrounds?.filled
              ? `  像素补背景：${report.pixelBackgrounds.filled}/${report.pixelBackgrounds.total} 处（CSS 采不到色值的）`
              : '',
            report.pixelBackgrounds?.inkSuspected
              ? `  采样疑似压到字形、退回未判：${report.pixelBackgrounds.inkSuspected} 处`
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      } finally {
        await session.context.close().catch(() => {});
      }
    }

    return { code: red ? 1 : 0, text: `${url}\n\n${blocks.join('\n\n')}` };
  } finally {
    await browser.close().catch(() => {});
  }
}
