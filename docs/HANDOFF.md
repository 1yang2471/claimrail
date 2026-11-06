# 交接（2026-11-06）

新会话先读 `docs/PRD.md`（需求源头，14+ 轮逐条盘问的结论，含明确排除项）和 `AGENTS.md`（每条规则由什么拦住 + 已知检出边界）。本文件只是路标，不复述它们。

## 一句话

forklight 不让 AI 变有品味，它让 AI 在没依据的时候**不再伪装成有依据**：交付前由程序算改回来的代价、回访证据，红的不许交。承重前提——约束力只能挂在外部可计算的量上，不能挂在模型自评上。

## 现状

- 15 个模块 / 1400+ 行 src / `node --test` 229 项（228 通过 + 1 skip，真网络烟测默认关）/ 6 条命令：`init check web record rules invalidate`
- 提交到 `1720357`。已装 Playwright + Chromium（optional peerDependency，本机 devDependency）
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

## 下一步（按此顺序，别先做 bench）

1. **验 `precedent` 档到底是真的还是我写来自我安慰的**（需用户同意发真网络请求，`FK_NET=1`）。要回答的是：真实设计文档里能不能找到 ≥3 个独立域名、且引文可回访核实地在推荐同一做法？普遍引文对不上（重排/JS 渲染/付费墙）就该改成"尽力核实 + 覆盖率如实上报"，而不是强制。
2. **起 dev server 跑真 SPA**（Shinsekai/frontend；Vite，需装依赖）。当前 `file://` 打开是空白页 → 五项全未判。真实前端 + `--state` 登录态至今零覆盖。
3. **bench：有/无协议对照，拿到静默塌缩率与打断中位数**。陷阱任务要来自第 1、2 步真翻过的车，不要新编。发布文案那句对比必须有数字，没有就照实写"尚未测量"。
4. **hook 接线**（PostToolUse → `forklight check`），否则约束力仍依赖 agent 自觉。
5. **把 `skill/SKILL.md` 真装进一个 agent 的 skills 目录**跑一轮，验证 description 真会触发。
6. README / LICENSE / `0.1.0` tag。只 commit，push 要用户明说。

## 已知未修

- 对比度在磨砂+渐变设计上覆盖率极低（真站 7/111），要判得靠截图像素采样 → v2。
- 非 git 目录三个输入全 null → 一切判 high，工具近乎失明；要么发布时写明边界，要么设计显式非 git 降级模式（新需求，需用户拍板）。
- `newestTrackedMtime` 有 5000 文件上限，超限返回 null（保守但会让大 monorepo 的 render 证据全失效）。
- `storageState` 登录态：代码在，一次没实测。

## 干活规矩

交差按 prove-it 格式：做了什么 / 测试命令与结果 / 截图或产物 / 没验证到的。新加每道守卫都要变异验证（改坏必须红，改回必须绿；先确认 sed 真命中了那一行）。清理临时产物时删除范围和统计范围分开写，路径全字面。往 markdown 表格插内容后复读一遍，别把行甩到别的章节下面。每个任务收尾必须 commit，不留脏工作区。
