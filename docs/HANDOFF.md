# 交接（2026-11-06）

新会话先读 `docs/PRD.md`（需求源头，14+ 轮逐条盘问的结论，含明确排除项）和 `AGENTS.md`（每条规则由什么拦住 + 已知检出边界）。本文件只是路标，不复述它们。

## 一句话

forklight 不让 AI 变有品味，它让 AI 在没依据的时候**不再伪装成有依据**：交付前由程序算改回来的代价、回访证据，红的不许交。承重前提——约束力只能挂在外部可计算的量上，不能挂在模型自评上。

## 现状

- 15 个模块 / 1400+ 行 src / `node --test` 234 项（233 通过 + 1 skip，真网络烟测默认关）/ 6 条命令：`init check web record rules invalidate`
- 提交到 `de2cb59`（交接文档）之后是本轮：precedent 档真实测量 + 三处修正（`git log -1`）。已装 Playwright + Chromium（optional peerDependency，本机 devDependency）
- 测试分四层：纯逻辑（gate/cost/evidence/geometry/focus/memory/schema）、真 git 仓库端到端（redteam）、真 Chromium（browser）、CLI 闭环（cli/store）

## 别退回去的实测事实

- headless Chromium **用覆盖式滚动条**渲染（`offsetWidth-clientWidth === 0` 且 `scrollbar-width: auto`）。"保留默认滚动条"不是修法，`scrollbar-gutter: stable` + 右内边距才是。
- `scrollbar-width: none` 不画条、`scrollbar-gutter: stable` 已留位 → 都没有压在内容上的条带，别判红。
- 承重的是 `ls-files -z`（`core.quotepath=false` 只是冗余）。
- 采不到实色背景必须返回 null。兜底白色曾一次造 83 处假红；`rgba(0,0,0,.05)` 不合成会被当纯黑，造 76 处。
- 遮挡只认"贴底 + 覆盖宽度 ≥30%"的条；容器自己的 sticky 子元素（`inside`）必须排除。
- 先采未聚焦基线，再走 Tab。顺序倒过来焦点检查一路假绿。
- 台账自身从 `lastChangeMs` 里排除，否则每条 render 证据先天"过时"，报告层检查永远轮不到执行。
- 自供字段一律拒收（`options_cost`/`confidence`/`rationale`）；候选代价由程序逐候选 observe 真算，算不出就打「规则四未启用」。
- 引文核实必须对照**可见正文**，不是传输字节（24 个真实设计文档 URL 实测：17 个可选出引文，其中 9 个原始 HTML 直接命中、8 个被行内标签切开、0 个靠实体解码救回）。按原始 HTML 匹配还反过来漏一类假绿：引文只在 `<script>` 字符串里出现也算"页面上有"。
- 壳页判"正文读不到"、不判"编造"：`m3.material.io` 200 + 62KB HTML 只剩 15 个可见字符，`developer.apple.com` 剩 38 个。设计系统站普遍是 SPA，这一档现在够不着它们。
- 回访必须带 `accept-language: en`——实测 web.dev 不带语言标返回过法语页，英文原句在自己刚引过的那篇上匹配不上。
- "业界都这么做"这句话本身有时就是不成立的：触摸目标尺寸实测 24 CSS px（WCAG）/ 44pt（Apple）/ 48dp（Material）/ 1cm×1cm（NN/g，物理量纲）。这种分叉正确申报是"各家数字不一致，我选 X 因为 Y"。
- 引文命中 ≠ 页面在推荐该做法。实测两处命中是例外条款（W3C "cannot use color alone to achieve 3:1…"、SC 2.5.8 "links within paragraphs…do not need to meet the 24 by 24 css pixels…"）。程序判不了语气，别把这一档说成"程序已经确认业界支持"。

## 下一步（按此顺序，别先做 bench）

0. ~~验 `precedent` 档是真依据还是自我安慰~~ —— **已验完（2026-11-06，24 个真实文档 URL）**。结论：不是自我安慰，门保持强制、没降级成"尽力核实"；但按实测改了三处（可见正文匹配、壳页分诊、`accept-language`），改前 6 条主张放行 0 条、改后 4 条。数字与理由见 `AGENTS.md` 规则表与"别退回去的实测事实"。剩下的口子是语义级的（引文命中≠页面推荐），已列入检出边界，别再重跑这轮测量。
   - **补测（2026-11-07）**：口味/信息架构类主张 4 条 × 4 域名（无硬数字锚点：单列表单、卡片 vs 表格、侧边 vs 顶部导航、空状态 CTA）。放行 2/4；没过的是**到达性**问题（medium.com/uxdesign.cc 403、adamsilver.io fetch failed、m3 壳页），不是门太严。这一档对无硬数字的设计主张同样成立，"强制"继续保留。测量脚本同 `scripts/precedent-measure.mjs` 的方法。
1. **起 dev server 跑真 SPA**（Shinsekai/frontend；Vite，需装依赖）。当前 `file://` 打开是空白页 → 五项全未判。真实前端 + `--state` 登录态至今零覆盖。
2. **bench：有/无协议对照，拿到静默塌缩率与打断中位数**。陷阱任务要来自第 1 步真翻过的车，不要新编。发布文案那句对比必须有数字，没有就照实写"尚未测量"。
3. **hook 接线**（PostToolUse → `forklight check`），否则约束力仍依赖 agent 自觉。
4. **把 `skill/SKILL.md` 真装进一个 agent 的 skills 目录**跑一轮，验证 description 真会触发。
5. README / LICENSE / `0.1.0` tag。只 commit，push 要用户明说。

## 已知未修

- 对比度在磨砂+渐变设计上覆盖率极低（真站 7/111），要判得靠截图像素采样 → v2。
- 非 git 目录三个输入全 null → 一切判 high，工具近乎失明；要么发布时写明边界，要么设计显式非 git 降级模式（新需求，需用户拍板）。
- `newestTrackedMtime` 有 5000 文件上限，超限返回 null（保守但会让大 monorepo 的 render 证据全失效）。
- `storageState` 登录态：代码在，一次没实测。

## 干活规矩

交差按 prove-it 格式：做了什么 / 测试命令与结果 / 截图或产物 / 没验证到的。新加每道守卫都要变异验证（改坏必须红，改回必须绿；先确认 sed 真命中了那一行）。清理临时产物时删除范围和统计范围分开写，路径全字面。往 markdown 表格插内容后复读一遍，别把行甩到别的章节下面。每个任务收尾必须 commit，不留脏工作区。
