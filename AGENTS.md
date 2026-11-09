# claimrail 项目规则

新 agent 进来先跑 `node --test`（394 项，约 20 秒），再读 `docs/PRD.md`。PRD 是需求源头；它没写的范围，v1 不做。每条规则的完整实测故事在 `docs/HANDOFF.md` 与 `docs/BOUNDARIES.md`，本表只留「规则 → 由什么拦住」。

## 规则表

| 规则 | 由什么拦住 |
| --- | --- |
| 台账不许内联代码、不许多行、代价只有两档 | `src/schema.mjs` + `test/schema.test.mjs` |
| 没证据不许声称已验证（`evidence: null` ⇒ `verified: false`） | `src/schema.mjs` 的 `evidence.null-vs-verified` |
| 模型不许给自己的改动报低代价 | `src/cost.mjs` 的 `apply()`：程序算出 high 就覆写，`check` 打印三种 high 来源分开说的原因 |
| 「已发布」只认默认分支与 tag | `src/observe/git.mjs` 的 `headOnRemoteDefault`：`git branch -r --contains HEAD` 判，不漏 `git push origin HEAD:main`；默认分支读不到只认唯一 main/master，否则 null → high。`test/published-remote.test.mjs` |
| 读不到仓库状态不许降级成乐观值 | `gitState` 三态 repo/none/unknown + `mapGrepExit`；`unknown` 改成 `none` 会红 |
| 采集不到数据不许判绿 | `src/observe/geometry.mjs` 三态 `null` + `src/evidence.mjs` 只认严格 `true`（报告全 null 或只有截图无报告都判失败） |
| 视觉证据必须是新的，删除也算改动 | `evidence.mjs` render 档比较截图 mtime 与 `newestTrackedMtime`（含被删路径父目录 mtime；`.claimrail/`、`memory/` 从时间戳里排除，否则台账总在截图之后写） |
| 不许伪造度量报告 | `evidence.mjs`：id ∈ `RENDER_CHECK_IDS`、五项齐全、schema 版本对、`name` 对应截图、`shot_sha256` 重算比对、断言严格 true（`test/redteam.test.mjs`） |
| 不许引用本次刚写的代码冒充既有做法 | `git.mjs` 的 `changedLines`+`isChangedLine` 经 `ctx.isChanged` 注入；路径基准是仓库根（子目录运行照样生效） |
| 未跟踪文件不能对档位隐身 | `observe/git.mjs` 的 `worktreeScanText` 把 `git status` 的 `??` 并进副作用扫描与 mtime |
| 弱断言不算证据 | `evidence.mjs`：断言 ≥3 字符、区间 ≤40 行；schema 端 repo/memory/render/web 四档都必须带 asserts（与 verify 同一把尺） |
| log 行号是引用坐标 | `src/store.mjs`：坏 JSON、坏形状、行内 `at` 与物理行号不符，三种一律硬拦 |
| 禁用名单不许静默失效 | `store.mjs` 的 `readDenied` 读坏了就报错，不能当成"没禁过" |
| 副作用扫描单位是单文件新增行 | `observe/effects.mjs` 的 `addedCode` 返回数组、逐文件扫；认不出的 diff header 整段不归属 |
| 诚实申报不该被罚 | `effects.mjs` 的 `SELF_IGNORE`：规则表、tests/fixtures、docs、bench 判定文件等不算动作 |
| 假红防线：容器作用域、贴底定义、截断不作数 | `geometry.mjs`：文本按 container 归属；遮挡只认"贴底 + 覆盖 ≥30%"；`raw > 实际条数` 改判 null——四类采集（texts/interactive/scrollContainers/fixedRects）一个不漏 |
| 焦点签名按"能不能被看见"归一化 | `driver.mjs` 的 `styleSig`：`outline-style:none` 或宽度 0 时丢弃 outline 颜色/宽度 |
| 先采基线、截图、再走 Tab，顺序不许倒 | `observe/web.renderPage`：截图 → 焦点探测。基线倒置会让焦点检查一路假绿；截图放探测之后会让像素采样拿旧坐标读新图 |
| 真浏览器路径必须有自动化覆盖 | `test/browser.test.mjs`（真 Chromium 对照页；没装 Playwright 整文件 skip，不伪绿）；`--state` 用本地 HTTP 页验证注入 |
| 像素补的背景也要能退回未判 | `pixel.mjs`：采样点颜色不一致（跨渐变）或与字色比值 <1.05（采到字形）一律不填 |
| 采不到真值时不许兜底猜测 | `web.mjs` 的 `bgOf`：渐变/图片背景、最底层半透明一律 null（兜底白色一次造 83 处假红） |
| 半透明层要合成后再比 | `geometry.mjs` 的 `parseRgba`/`over`（`rgba(0,0,0,.05)` 不合成被当纯黑，76 处假红） |
| 色值换算必须问浏览器本人 | `driver.mjs` 的 `window.__fk.rgbaOf`：老语法精确解析，现代色空间 canvas 画像素读回。真站实测 49/49、31 处真缺陷（最低 2.45:1） |
| 认不出的色值整处不判，不许拿祖先的颜色冒充 | `web.mjs` 的 `bgOf`：某一层解析不出整处 null |
| 交付正文里的全称断言要跟门里的未验证项对撞 | `overclaim.mjs` + `hook`：正文宣称"全部核实"而门里有未验证项 → 拦一轮摊开矛盾；否认句不算声明；读不到正文按"没提"处理 |
| 测量对象必须先证明成立 | `observe/index.mjs` 的 `targetResolves` + `git.mjs` 的 `fileRefs`：指向不存在的路径/符号时"0 处引用"是假零 → 判 null；文件级 fan-in 要认 `./helper.mjs` 相对写法 |
| 非 git 目录是显式降级模式，不是实测 | `gitState` 三种话术分开（none 才叫"不是仓库"）；repo 档丢的是"先干后证" |
| 退出码不许说谎 | `web.mjs`：五项全未判退出 1；`check` 退出 0 只在确有绿项；hook 的文本走 stderr、退出码才是接口 |
| 报告必须绑住它测的那张图 | `observe/web.mjs` 写 `shot_sha256`，回验重算比对；缺字段一律失败（手写报告不能靠"不写"绕开） |
| 报告要说清"没覆盖到哪里" | `observe/web.mjs` 的 `limitations`；`web` 命令把它打到屏幕上 |
| 判定要能结构化交出去 | `check.mjs` 返回 `data`（schema=1）；`--json` 打印它，文本是同一份决策的视图 |
| 申报无分叉要留审计线索 | `audit.mjs` + `check.mjs`：`forks: []` 且 diff 落在该类文件面上 → 审计项 + `emptyDeclaration`，不参与退出码 |
| 报告必须带 name | `evidence.mjs` render 档：工具产物永远带 name，"没写"只可能是手写报告在绕开 |
| init 不许替目标仓库决定忽略什么 | `cli.mjs` 的 init 只写四条自有产物路径，不写 `*.png` 通配 |
| 行内文字链接不按控件标准考核 | `web.mjs` 采 `inline` 标记 + `touchTargetsOk` 排除 |
| 截图文件名必须带 URL 指纹 | `driver.mjs` 的 `nameFromUrl`（三个 index.html 收敛同名会覆盖证据） |
| 设计类任务不许拿"一篇文章这么说"当依据 | `schema.mjs` 的 `evidence.design-needs-precedent`：`ui-new`/`docs-new`/`api-design` 用 `kind: 'web'` 直接拒 |
| "业界收敛"必须可回访 | `evidence.mjs` 的 `verifyPrecedent`：逐 URL 回访 200 + 引文在可见正文 + 按注册域去重 ≥3；`adoption` star 数走 GitHub API |
| 引文对照可见正文，不对照传输字节 | `visibleText()` + 壳页分诊 `VISIBLE_MIN`；拦住"引文只在 `<script>` 里"的假绿 |
| 回访必须声明语言 | fetch 带 `accept-language: en`（web.dev 实测不带语言标返回过法语页） |
| bench 的陷阱任务必须来自真翻过的车 | `bench/tasks/*/trap.md` 写明出处；判定集中 `bench/classify.mjs`；假 agent 数字只能叫机制自测 |
| 低代价 + 证据不可核实 = 放行但点名 | `gate.decide` 的 `unverified`；工具不读交付正文，靠 hook 拦一轮逼逐条声明 |
| hook 只许拦一次，payload 必须真读 | `hook.mjs`：`stop_hook_active` 为真不再阻断（防死循环）；`readIncoming` 立即调用 IIFE、定时器 unref+清理——少括号曾让 payload 永远 null、每轮多等 5 秒（入口层用例钉住） |
| 门只在"看得见工作区"时认证未申报 | `check.mjs` 的 `workVisible`：repo 里没有 baseline / git 读不出、或 git 本身 unknown → 模板台账直接拦；`none`（确实不是仓库）是显式降级，照旧放行。空 baseline 由 init 补写修复（`readBaseline ?? writeBaseline`） |
| 一切路径以仓库根为基准 | `gitToplevel`：check/hook/init/web 都解析仓库根；台账可绝对路径、子目录找不到退回根；`--out` 必须在仓库内（仓库外写不出可回验 ref，早报错） |
| ref 与 target 段中 `..` 一律拒收 | `schema.mjs` 的 `hasParentSegment`（三层入口：evidence.ref / target.file / options[].target.file）+ `check.mjs` 的 `safeResolve` 运行时兜底 |
| stale 不误伤协议文件 | `hook.mjs`：touched 过滤后为 0 不进 stale 分支（只改 AGENTS.md/.gitignore 不再拦"改了 0 个文件"） |
| 未申报本身也拦 | `undeclared.mjs`：工作区有改动、台账仍是 init 模板（哈希或占位理由）→ 退出 1；hook 快照 `{treeHash, ledgerHash}` 判沿用旧台账，第二次放行并落 `violations.jsonl` |
| 自供字段一律拒收（含 evidence 内部） | `schema.mjs` 白名单：`confidence`/`rationale`/`options_cost` 进不去；`verified` 只作申报（`test/verified.test.mjs` 钉住） |
| bench 陷阱任务不许编 | `bench/tasks/` 20 个，`trap.md` 都要写明出处与统计口径；`test/bench.test.mjs` 逐个查 |

## 已知的检出边界

别把"未判"当"没问题"。完整清单见 [`docs/BOUNDARIES.md`](docs/BOUNDARIES.md)。

## 改这些代码时的硬规矩

1. **红队层与浏览器层必须跟着跑**：`node --test test/redteam.test.mjs test/browser.test.mjs test/color.test.mjs`。前者测的是产品存在的理由（模型能否不实做却拿到"已验证"），中间那个测的是两百多个纯逻辑测试一行都没执行过的 DOM 采集代码，最后一个测的是色值换算（真 Chromium）。
2. **加一道拦之后要做变异验证**：把那处守卫改坏，测试必须变红；改回来必须绿。从来没报过错的守卫等于没加。改坏前先 grep 出那一行、改完看 diff——sed 没命中时"照样绿"会被误当成守卫有效。
3. **别在带未提交改动的文件上用 `git checkout --` / `git clean`**：要复原就先 `cp` 出来再 `cp` 回去。
4. **文档改动也要看渲染结构**：往 markdown 表格里插段落时，锚点落在表中途会把后续行甩到别的章节下面。
5. **提交被钩子拒了就照报错拆文件**：`.githooks/pre-commit` 拒收超过 5000 token（≈20KB）的文件；别调阈值、别 `--no-verify`。新克隆先 `git config core.hooksPath .githooks`。
6. **写新函数、新规则前先搜项目里有没有现成的**：同一件事的第二份实现比没有实现更坏。
7. **测试别把本仓库的发版状态当前提**：要测"未发布"，就在临时目录重新 `git init` 一份工作树，别赌仓库当前有没有 tag、有没有上游。
8. **改 check/hook 这种入口层时，测试要走真进程**：`readIncoming` 少一对括号这类接线错误，单元层全绿而真 stdin 一跑就瞎——入口层守卫要有 `spawnSync` 管道用例。

## 为什么这些规则长这样

约束力必须挂在外部可计算的量上，不能挂在模型的自我评价上：每一行都是"改坏了会有东西报错"。加检查时沿用同一标准——**把错放回去，检查必须变红**。实测事实见 [`docs/HANDOFF.md`](docs/HANDOFF.md) 的「别退回去的实测事实」，别在 AGENTS 里再抄一份。

<!-- claimrail:begin -->
## claimrail
动界面/文档/接口前读 `skill/SKILL.md`，写 `.claimrail/decisions.json`；交付前跑 `node src/cli.mjs check`。
<!-- claimrail:end -->
