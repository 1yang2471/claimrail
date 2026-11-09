// web 命令：起浏览器、按视口采集、渲染一屏报告。
// 从 cli.mjs 拆出来是因为提交钩子按 token 拒收超大文件——这一段没有自己的状态，
// 只依赖 driver 与 web 观察层，单独成文件不引入任何第二份实现。
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { renderPage } from '../observe/web.mjs';
import { openPage, launchBrowser, parseViewports, nameFromUrl } from '../observe/driver.mjs';
import { gitToplevel } from '../observe/git.mjs';

// launch / open 可注入：不然这个命令一行都测不到，只能靠真浏览器手跑——
// 退出码在这种地方最容易说谎（"五项全未判"曾经返回 0，CI 会当成检查通过）。
export async function web({
  url,
  state,
  viewport = '390x700,1280x800',
  out = join('.claimrail', 'shots'),
  name,
  cwd = process.cwd(),
  launch = launchBrowser,
  open = openPage,
  pixel = true,
} = {}) {
  if (!url) return { code: 1, text: '用法：claimrail web --url <地址> [--viewport 390x700,1280x800] [--state 登录态.json] [--out .claimrail/shots]' };

  // 截图目录与 ref 都以仓库根为基准：evidence 的 ref 必须是仓库根相对路径，
  // check 回验时才找得到它。--out 给绝对路径也行，但必须在仓库内——仓库外的
  // 绝对路径写不出可回验的 ref，早报错而不是让 mkdir 抛 ENOENT（审查实测）。
  const root = (await gitToplevel(cwd)) ?? cwd;
  const outAbs = resolve(cwd, out);
  const relOut = relative(root, outAbs);
  if (!relOut || relOut.startsWith('..') || isAbsolute(relOut)) {
    return { code: 1, text: `--out 必须落在仓库内（${outAbs} 在 ${root} 之外）：仓库外的路径写不出可回验的 ref` };
  }
  const outRel = relOut.split(sep).join('/');

  let browser;
  try {
    browser = await launch();
  } catch (err) {
    return { code: 1, text: `浏览器没起来：${err.message}` };
  }

  const blocks = [];
  let red = false;
  let judged = 0;

  try {
    for (const vp of parseViewports(viewport)) {
      let session;
      try {
        session = await open(browser, { url, state, viewport: vp });
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
          outDir: outAbs,
          name: shotName,
          label: `${url} @ ${vlabel}`,
          focusProbe: session.focusProbe,
          pixel,
        });

        // ref 用仓库根相对路径（evidence 回验按这个基准找文件）
        const ref = `${outRel}/${shotName}.png`;
        const green = report.checks.filter((c) => c.ok === true).map((c) => c.id);
        const undecided = report.checks.filter((c) => c.ok === null).map((c) => c.id);
        if (report.checks.some((c) => c.ok === false)) red = true;
        judged += green.length;

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
            // 这一轮"没覆盖到哪里"必须上屏（调研自 craft-anything 的 limitations 表达）。
            // 只写进 report.json 等于没写：交付时没人会去翻文件。
            report.limitations?.length ? `  本轮没覆盖到：${report.limitations.join('；')}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      } finally {
        await session.context.close().catch(() => {});
      }
    }

    // 退出码不许说谎：五项全未判时返回 0，CI 会当成"检查通过"。这份报告本来就不能
    // 当证据（evidence 要求至少一项严格 true），所以退出码必须是 1。
    const code = red || judged === 0 ? 1 : 0;
    const tail =
      judged === 0 && !red
        ? '退出码 1：没有任何一项真的判过——这份报告不能当证据（未判 ≠ 合格）'
        : red
          ? '退出码 1：有检查项判红'
          : '';
    return { code, text: [`${url}`, ...blocks, tail].filter(Boolean).join('\n\n') };
  } finally {
    await browser.close().catch(() => {});
  }
}
