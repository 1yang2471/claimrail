# 交接（2026-11-06）

新会话先读 `docs/PRD.md`（需求主体：问题、方案、用户故事、实现决策）与 `docs/PRD-notes.md`（测试决策、排除项、复核笔记），再读 `AGENTS.md`（每条规则由什么拦住 + 已知检出边界）。本文件只是路标，不复述它们。

## 一句话

forklight 不让 AI 变有品味，它让 AI 在没依据的时候**不再伪装成有依据**：交付前由程序算改回来的代价、回访证据，红的不许交。承重前提——约束力只能挂在外部可计算的量上，不能挂在模型自评上。

## 现状

- 15 个模块 / 1400+ 行 src / `node --test` 235 项（234 通过 + 1 skip，真网络烟测默认关）/ 6 条命令：`init check web record rules invalidate`
- 提交基线 `de2cb59`；之后本轮三条：precedent 实测修正 / 口味类补测降级 / 真 SPA + `--state` 实测（`git log --oneline -4` 可查）。已装 Playwright + Chromium（optional peerDependency，本机 devDependency）
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
   - **补测（2026-11-07）**：口味/信息架构类主张 4 条 × 4 域名（单列表单、卡片 vs 表格、侧边 vs 顶部导航、空状态 CTA）。自动引文筛选下 `verify()` 放行 2/4，另有 medium.com/uxdesign.cc 403、adamsilver.io fetch failed、m3 壳页。但筛选混入标题/FAQ 和与候选方向不符的句子；**2/4 只代表引文字串命中，不证明三个来源在推荐同一做法**。本轮不能据此宣称口味类的强制 precedent 已获验证；PRD 的现行门保持不变，是否改成"尽力核实 + 覆盖率上报"仍待人工核对真实引文上下文。
1. ~~起 dev server 跑真 SPA~~ —— **已跑（2026-11-07）**。Shinsekai/frontend 用 `pnpm install --frozen-lockfile --trust-lockfile --ignore-scripts --fetch-timeout=900000` 安装（用户明确批准跳过 pnpm 的 lockfile 策略重放，lockfile 的 tarball 完整性仍核验）；Vite `http://127.0.0.1:5173/`。首次冷启动双视口里 1280 宽的 `networkidle` 超时；依赖预构建完成后重跑，390×700 / 1280×800 两份报告都成功生成。分别有 13 / 12 个触摸目标短边不足 44px，CLI **退出 1**；scrollbar 和真实 Tab 焦点检查各两项绿，对比度（渐变）和底部遮挡（无固定条）均未判。Chromium 页面正文是聊天/设置页，`pageerror` 为空，不是 `file://` 空白壳。截图/报告在 `.forklight/shots/127_0_0_1_5173-hP_EiHv5@{390x700,1280x800}.{png,report.json}`（gitignore）。Shinsekai 本身无登录门；另加真浏览器自动化测试证明 `--state` 把 cookie + localStorage 都注入了浏览器上下文，变异 `storageState`→`zzState` 红、恢复绿；**真实受保护页面的登录闭环仍未测**。
2. **bench：有/无协议对照，拿到静默塌缩率与打断中位数**。陷阱任务要来自第 0、1 步真翻过的车，不要新编。发布文案那句对比必须有数字，没有就照实写"尚未测量"。
   - **tracer bullet 已跑（2026-11-07）**：`src/bench.mjs` + `bench/tasks/` 三个任务（已发布仓库自报 low、旧截图冒充新证据、申报"无分叉"绕开台账）。假 agent 跑出的机制数字：off 交付 3/3、静默塌缩 3；on 交付 1/3、拦住 2、静默塌缩 1、打断中位数 1。**漏的那 1 条是已知盲区**（口头申报无分叉），bench 如实计入，不藏。
   - **这些数只能说明门对这三种形状有效，不能进发布文案**：agent 是确定性的假 agent，量的是机制不是模型行为；额外耗时中位数也没测（假 agent 不耗时）。要把"模型静默塌缩率"写进文案，先扩到 20-30 个任务并换成真实模型重跑。
3. ~~hook 接线（PostToolUse → `forklight check`）~~ —— **已接（2026-11-07，用户级 Stop）**。位置：`~/.zcode/cli/config.json`（实际 `D:\dev-cache\zcode-home\cli\config.json`）的 `hooks.enabled + events.Stop`，命令 `node "D:/workspace/forklight/src/cli.mjs" hook`（原文件备份在 `config.json.bak-forklight-20261107`）。选择 Stop 而非 PostToolUse 的依据：Claude Code / ZCode 的 Stop + 退出码 2 语义就是"拦住并续一轮，stderr 交给模型修"，正是交付前检查的标准位置；PostToolUse 每次编辑都跑会制造噪音。两个护栏写进 `hook()`：无台账仓库静默放行、`stop_hook_active` 为真时不再重复阻断（防死循环）。真机验证：一次"只回答两个字"的请求被拦后续一轮，模型改成「forklight 卡在滚动区分叉，请定 A/B」。**注意**：ZCode 的**工作区**配置钩子要一次性信任（`security/workspace-hook-trust-v1.json`，按摘要绑定），headless 下未信任会被静默跳过；config 钩子不写进 debug 日志，只能靠行为证据。
4. ~~把 `skill/SKILL.md` 真装进一个 agent 的 skills 目录，验证 description 真会触发~~ —— **已装并验证（2026-11-07）**。skill 通过 junction 装到 `D:/agent-skills/forklight`（ZCode/CodeBuddy/Trae 共用），`zcode skills list` 可见。**结论：description 单独触发不了**——真模型（ZCode 0.17.1 无头）在"把保存按钮改成固定底栏"上连跑两次设计任务都照做、台账一字不写，即使技能描述已加入"动手前先加载"、且确认 Skill 工具可调。改由 `forklight init` 往目标仓库 AGENTS.md 写 marker 指路段后，同一 prompt 立刻写出 3 条分叉台账（含 repo/memory 证据与一条 `evidence: null`），自跑 `forklight check` 退出码 0、`forklight web` 出双视口报告并说明"未判"项。两级验收（硬：台账落盘可校验；强：跑通 check 闭环）都过。
5. README / LICENSE / `0.1.0` tag。只 commit，push 要用户明说。

## 已知未修

- 对比度在磨砂+渐变设计上覆盖率极低（真站 7/111），要判得靠截图像素采样 → v2。
- 非 git 目录三个输入全 null → 一切判 high，工具近乎失明；要么发布时写明边界，要么设计显式非 git 降级模式（新需求，需用户拍板）。
- `newestTrackedMtime` 有 5000 文件上限，超限返回 null（保守但会让大 monorepo 的 render 证据全失效）。
- `storageState` 已在真 Chromium + 本地 HTTP 页验证 cookie/localStorage 注入（变异验证红/绿）；**真实需要登录的产品页尚未跑**。Shinsekai 本身无登录门，不要把注入测试说成登录闭环。

## 干活规矩

交差按 prove-it 格式：做了什么 / 测试命令与结果 / 截图或产物 / 没验证到的。新加每道守卫都要变异验证（改坏必须红，改回必须绿；先确认 sed 真命中了那一行）。清理临时产物时删除范围和统计范围分开写，路径全字面。往 markdown 表格插内容后复读一遍，别把行甩到别的章节下面。每个任务收尾必须 commit，不留脏工作区。
