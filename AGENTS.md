# claimrail 项目规则

新 agent 进来先跑 `node --test`（333 个，约 30 秒），再读 `docs/PRD.md`。PRD 是需求源头，十四轮盘问的结论都在里面；它没写的范围，v1 不做。

## 规则表

| 规则 | 由什么拦住 |
| --- | --- |
| 台账不许内联代码、不许多行、不许两档以外的代价档位 | `src/schema.mjs` + `test/schema.test.mjs` |
| 没证据不许声称已验证（`evidence: null` ⇒ `verified: false`） | `src/schema.mjs` 的 `evidence.null-vs-verified` |
| 模型不许给自己的改动报低代价 | `src/cost.mjs` 的 `apply()`：程序算出 high 就覆写，且 `check` 打印覆写原因 |
| 「已发布」只认默认分支与 tag | `src/observe/git.mjs` 的 `headOnRemoteDefault`：返回上游名（如 `origin/main`）表示已发布；功能分支已推送不算；已合并进默认分支的提交仍算（`merge-base --is-ancestor`）；默认分支读不出来时只认 main/master 且上游同名，其余 `null` → high。`test/published-remote.test.mjs`；变异：退回"任何推送" → 红 3、去掉 main/master 兜底 → 红 2、去掉合并判定 → 红 1、理由句退回 → 红 1 |
| 读不到仓库状态不许降级成乐观值 | `src/observe/git.mjs` 的 `mapGrepExit` + `test/observe.test.mjs` 非 git 目录用例（已用变异验证：`unknown` 改成 `none` 会红两条） |
| 采集不到数据不许判绿 | `src/observe/geometry.mjs` 三态 `null` + `src/evidence.mjs` 只认严格 `true`（报告全 null 或只有截图无报告都判失败） |
| 视觉证据必须是新的 | `src/evidence.mjs` render 档比较截图 mtime 与 `newestTrackedMtime`（该函数对大仓库不再交 null：上限 200000，实测 6000 文件 148ms）；`.claimrail/`、`memory/` 从时间戳里排除，否则台账总在截图之后写，每条 render 证据都会先天"过时"，报告层的伪造检查永远轮不到 |
| 不许伪造度量报告 | `src/evidence.mjs`：id 必须 ∈ `RENDER_CHECK_IDS`、五项齐全、`report_schema` 版本对、`name` 与截图同名、断言项必须严格 true（`test/redteam.test.mjs`） |
| 不许引用本次刚写的代码冒充既有做法 | `observe/git.mjs` 的 `changedLines` + `isChangedLine`，经 `cli.makeCtx` 注入 `ctx.isChanged`（`test/redteam.test.mjs`） |
| 未跟踪文件不能对档位隐身 | `observe/git.mjs` 的 `worktreeScanText` 把 `git status --porcelain -z` 的 `??` 并进副作用扫描与 mtime（`test/redteam.test.mjs`） |
| 弱断言不算证据 | `src/evidence.mjs`：断言 ≥3 字符、区间 ≤40 行、行号 ≥1 且不倒序；schema 端同规则（`test/evidence.test.mjs`、`test/redteam.test.mjs`） |
| log 行号是引用坐标 | `src/store.mjs`：坏 JSON、坏形状、行内 `at` 与物理行号不符，三种一律硬拦（删一行即让全部既有引用悄悄改指） |
| 禁用名单不许静默失效 | `src/store.mjs` 的 `readDenied` 读坏了就报错，不能当成"没禁过"（否则被用户作废的规则会复活） |
| 副作用扫描单位是单文件新增行 | `src/observe/effects.mjs` 的 `addedCode` 返回数组、`scanDiff` 逐文件扫；认不出的 diff header 整段不归属。跨文件拼接会把两个无关文件缝成一条 `recursive-delete` |
| 诚实申报不该被罚 | `effects.mjs` 的 `SELF_IGNORE` 含 `.claimrail/`、`memory/`、`docs/`、`README/AGENTS.md`、测试与 fixtures、规则表自身 |
| 前端检查默认跑多视口 | `src/commands/web.mjs` 的 `web` 默认 `390x700,1280x800`。注意：`--viewport` 可以覆盖成单个，所以这条是默认值约束，不是硬拦 |
| 假红防线：容器作用域、贴底定义、截断不作数 | `src/observe/geometry.mjs`：文本按 `container` 归属比较；遮挡只认"贴底 + 覆盖宽度 ≥30%"的条；`raw > 实际条数` 时改判 `null`（`test/geometry.test.mjs`） |
| 焦点签名按"能不能被看见"归一化 | `src/observe/driver.mjs` 的 `styleSig`：`outline-style:none` 或宽度为 0 时丢弃 outline 颜色/宽度。变异验证：取消归一化 → `test/browser.test.mjs` 红（`a{outline:none}` 又被判成"焦点可见"） |
| 先采基线、再走 Tab，顺序不许倒 | `src/observe/driver.mjs` 交出 `focusProbe` 回调，`renderPage` 在 `evaluate(collectInPage)` 之后才调用它。倒过来会让"未聚焦基线"带着焦点，焦点检查一路判绿 |
| 真浏览器路径必须有自动化覆盖 | `test/browser.test.mjs`（真 Chromium 打开对照页；没装 Playwright 则整文件 skip，不伪绿）。`--state` 另用本地 HTTP 页验证 cookie + localStorage 确实注入，变异 `storageState`→`zzState` 测试红、恢复绿 |
| 副作用扫描不许扫到规则表和测试数据 | `src/observe/effects.mjs` 的 `addedCode` 排除 test/fixtures/docs/规则表自身 |
| 偏好 log 只追加，规则是缓存 | `src/store.mjs` 坏行直接报错（行号是引用坐标，跳过一行会让所有 `log#n` 错位） |
| 像素补的背景也要能退回未判 | `src/observe/pixel.mjs` 的 `applyPixelBackgrounds`：采样点颜色不一致（跨渐变）、或读到的"底色"与字色比值 <1.05（说明采到的是字形本身）一律不填，留 `null`。变异：去掉 1.05 守卫 → `test/pixel.test.mjs` 红；拆掉 `renderPage` 里的补背景调用 → `test/browser.test.mjs` 红 |
| 采不到真值时不许兜底猜测 | `web.mjs` 的 `bgOf`：渐变/图片背景、最底层半透明一律 `null`（真站实测：兜底白色一次造 83 处假红） |
| 半透明层要合成后再比 | `geometry.mjs` 的 `parseRgba`/`over`；背景自己半透明则未知（真站实测：`rgba(0,0,0,.05)` 被当纯黑，76/103 假红） |
| 色值换算必须问浏览器本人 | `driver.mjs` 的 `window.__fk.rgbaOf`：老语法（`rgb()`/`rgba()`/`transparent`）走精确解析，现代色空间（`oklch()`/`lab()`/`color()`/`color-mix()`）在 canvas 上画一个像素再读回来。为什么不全走像素：8 位回读会把半透明量化到 1/255，实测同一处比值会漂 0.047（`rgba(10,20,30,.5)`：3.483 → 3.529）。为什么不能只读字符串：Chrome 把 `oklch()` 原样回显（`fillStyle` 与注册 `<color>` 属性都试过），只有像素是权威。真站实测：`iana.org/help/example-domains` 49 处文本里 40 处文字色是 `oklch()`，改前只判 9 处、改后判满 49 处并抓出 31 处真实缺陷（最低 2.45:1，改前正被"未判"盖住）。`test/color.test.mjs` 三条；变异：去掉像素回退 → 红 2，去掉 `CSS.supports` 守卫 → 红 1（无效值会凭空报出 `rgb(0,0,0)`） |
| 认不出的色值整处不判，不许拿祖先的颜色冒充 | `web.mjs` 的 `bgOf`：某一层 `backgroundColor` 解析不出来就整处 `null`（旧实现 `continue` 掉那一层，于是把祖先的底色当成了这一层的底色）。`test/color.test.mjs`；变异：`if (!c)` 改成 `if (c === undefined)` → 红 |
| 交付正文里的全称断言要跟门里的未验证项对撞 | `src/overclaim.mjs` + `src/commands/check.mjs` 的 `hook`：宿主 Stop 事件带 `last_assistant_message`（依据：产品自带 `resources/glm/zcode.cjs` 构造 payload 的那段）。正文宣称"全部核实"而门里有未验证项 → 拦一轮并摊开矛盾；正文已逐条声明 → 放行；读不到正文 → 明说读不到，按"没提"处理，不冒充看过。**否认句不算声明**："本次交付没有任何未验证的事项"里也有"未验证"三字，纯关键词判断会被它骗过去。`test/overclaim.test.mjs`；变异：去掉否定守卫 → 红，去掉"声明优先" → 红 |
| 测量对象必须先证明成立 | `src/observe/index.mjs` 的 `targetResolves` + `src/observe/git.mjs` 的 `fileRefs`：target 是模型填的，指向不存在的路径/符号时"0 处引用"是假零，而 fanIn 正是便宜/贵的输入之一 → 判 null（按 high）。文件级 fan-in 要认 `./helper.mjs` 这种相对写法（拿仓库相对路径精确匹配会把三处 import 算成 0）。`test/observe.test.mjs`；变异：去掉检查 → 红，退回只按路径匹配 → 红 |
| 四类采集都要认截断 | `src/observe/geometry.mjs` 的 `truncated()`：以前只判 texts 与 interactive，滚动容器与固定元素被截断时仍报"已核 60 个滚动区"——页面上固定元素超过 40 个很常见，被丢掉的那条压内容就永远查不到。现在四类一个都不漏。`test/geometry.test.mjs`；变异：去掉任一条守卫 → 红 |
| 透明文字没有对比度可言 | `geometry.mjs` 的 `contrastOk`：`rgba(0,0,0,0)` 合成到底色上得到 1.00，报"不足 4.5:1"是纯假红（sr-only、图标字体常见）。它不算合格，也不冒充"已核"。`test/geometry.test.mjs`；变异：去掉守卫 → 红 |
| 非 git 目录是显式降级模式，不是实测 | `src/observe/git.mjs` 的 `gitState` 分三种：repo / none（确实不是仓库）/ unknown（git 本身用不了：坏 GIT_DIR、safe.directory）。三者文案必须不同——把"仓库读不出来"说成"这里不是仓库"会把人指去 `git init` 一个本来就是仓库的目录。降级时要说清丢的是什么：repo 档仍读得了文件与行，丢的是"先干后证"（引用的行是不是本次刚写的）。`test/cli.test.mjs`；变异：不区分 none/unknown → 红 |
| 退出码不许说谎 | `src/commands/web.mjs`：五项全未判时退出码是 1（这份报告本来就不能当证据），不是 0；`claimrail check` 退出码 0 只在"确实有绿项"时成立。`test/web.test.mjs` |
| 报告必须绑住它测的那张图 | `src/observe/web.mjs` 写 `shot_sha256`；`src/evidence.mjs` 回验时重算截图哈希（`ctx.shotHash`）比对。只靠文件名 + mtime 不够：换一张图或换一份同名报告都能混过去。缺 `shot_sha256` 一律失败（手写报告不能靠"不写"绕开）。`test/evidence.test.mjs`、`test/web.test.mjs`；变异：去掉缺字段守卫 / 去掉哈希比对 / 报告不写哈希 → 各红一次 |
| 报告要说清"没覆盖到哪里" | `src/observe/web.mjs` 的 `limitations`：四类采集截断、未判底色、采样疑似压字、像素采样关闭/失败、焦点没探或只探了一部分。`web` 命令把它打到屏幕上——只写进 report.json 等于没写。`test/web.test.mjs`；变异：去掉一条 → 红 |
| 判定要能结构化交出去 | `src/commands/check.mjs` 返回 `data`（schema=1：action / metrics / degraded / overrides / questions / unverified / violations / notEnabled / no_fork_reason / emptyDeclaration）；`--json` 在入口打印它，文本是同一份决策的视图。`test/args.test.mjs`、`test/hook.test.mjs`；变异：删解析 / 删 data / 删入口分支 → 各红 |
| 申报无分叉要留审计线索 | `src/audit.mjs` + `src/commands/check.mjs`：`forks: []` 且本次 diff 落在该类文件面上时，`check` 打印审计项、`--json` 给出 `emptyDeclaration`（touched / touchedTotal / reason）；不参与 action 与退出码。refactor 故意没有面——它的面是任意代码，命中等于没区分度。`test/audit.test.mjs`；变异：关掉计算 → 红 4、去掉面过滤 → 红 6、去掉上屏 → 红 4、去掉 `no_fork_reason` → 红 1 |
| 报告必须带 name | `src/evidence.mjs` 的 render 档：报告不带 `name` 就当"不是同一次采集"——工具自己的产物永远带 name，"没写"只可能是手写报告在绕开这道检查。`test/evidence.test.mjs`；变异：name 变回可选 → 红 |
| init 不许替目标仓库决定忽略什么 | `src/cli.mjs` 的 `init`：只写 `memory/` 与 `.claimrail/shots/`，不再写 `*.png` 通配——那会把用户仓库里所有真实图片一起静默排除在提交之外。`test/cli.test.mjs`；变异：写回 *.png → 红 |
| 行内文字链接不按控件标准考核 | `web.mjs` 采 `inline` 标记 + `geometry.touchTargetsOk` 排除（真站实测：16 处假红） |
| 截图文件名必须带 URL 指纹 | `driver.mjs` 的 `nameFromUrl`（真站实测：三个 index.html 收敛同名，前一份证据被后一份覆盖） |

| 设计类任务不许拿"一篇文章这么说"当好设计依据 | `src/schema.mjs` 的 `evidence.design-needs-precedent`：`ui-new`/`docs-new`/`api-design` 的 `kind: 'web'` 直接拒；必须给 `precedent`（`test/precedent.test.mjs`，变异验证：改成 `if (false)` → 红） |
| "业界收敛"必须可回访 | `src/evidence.mjs` 的 `verifyPrecedent`：逐个 URL 回访 200 + 引文出现在页面**可见正文** + 按注册域去重 ≥3（`MIN_SOURCES`，变异验证：降到 1 → 红 3 条）；`adoption` 的 star 数从 GitHub API 读，不达门槛或返回非 JSON 都判失败 |
| 引文对照可见正文，不对照传输字节 | `evidence.mjs` 的 `visibleText()`（去 script/style/注释/标签 + 解实体）+ 壳页分诊 `VISIBLE_MIN`。真网络实测 24 URL：17 个可选出引文，其中 9 个原始 HTML 直接命中、**8 个被行内标签切开**、0 个靠实体解码救回。拦住"引文只出现在 `<script>` 字符串里"这类假绿。测试：`test/precedent.test.mjs` 三条 + `test/evidence.test.mjs` web 档一条；变异验证：`visibleText` 退回 `norm(html)` → 红 4 条，只去掉脚本剥离 → 红 2 条 |
| 采不到正文的页面要说"读不到"，不许算成编造 | `evidence.mjs` 的壳页分诊（可见正文 < `VISIBLE_MIN` 字符）。实测 `m3.material.io` 200 + 62KB HTML 只剩 15 字符、`developer.apple.com` 剩 38 字符——设计系统站普遍是 SPA。老实 agent 与编造 agent 必须拿到不同判词；要真判这一类得渲染，与对比度像素采样同列 v2 |
| 回访必须声明语言 | `src/cli.mjs` 的 fetch 带 `headers: {'accept-language': 'en'}`（实测 web.dev 不带语言标返回过法语页，英文原句在自己引过的那篇上匹配不上）。`test/cli.test.mjs` 起本地 http server 断言收到该头；变异验证：删掉该行 → 红 |
| bench 的陷阱任务必须来自真翻过的车 | `bench/tasks/*/trap.md` 要写"为什么这不是编的任务"并指向实测出处；假 agent 跑出的数字只能叫机制自测，不得进发布文案（`test/bench.test.mjs` 钉住"无分叉盲区必须被计入静默塌缩"，防止把已知漏洞算成已拦）。**交付但被列进"交付末尾未验证"（`surfaced`）不算静默塌缩**，单独计 `deliveredSurfaced`；真模型的文字判定要先排除"模型把错误结论引出来再否定"（`bench/classify.mjs` 的 `noticed` 关键词），否则会把反驳算成主张 |
| 低代价 + 证据不可核实 = 放行但点名 | `gate.decide`：`!evidenceOk && cost !== 'high'` 进 `unverified`，交付说明里必须列出"欠一次人工检查"。这是设计，不是漏拦——但**工具不读交付正文**：真模型实测在门已点名的情况下仍写"3 个来源的引文全部当场核实"。别把"末尾点名"说成"正文也诚实" |
| 壳页能不能核实，取决于台账里写哪个 URL | `m3.material.io` / `developer.apple.com` 的 HTML 是 SPA 壳（可见正文 15/39 字符），但 Apple 文档另有 JSON 数据接口能取到正文。当前 `verifyPrecedent` 只回访台账给的 URL：写壳页 URL 这一票就不成立，写数据接口 URL 才能核（v2 再考虑自动找接口） |
| init 要给宿主留指路 | `src/cli.mjs` 的 `writeAgentsPointer`：目标仓库 AGENTS.md 里写 marker 块（`<!-- claimrail:begin/end -->`，幂等、不动原有内容）。真机实测：ZCode 0.17.1 无头、技能已加载、Skill 工具可调，光靠 description 连跑三次设计任务都不加载 claimrail；写入指路后同一任务产出 3 条分叉台账、自跑 check（退出码 0）与 web 双视口。`test/cli.test.mjs` 两条；变异：关掉写入 → 红 2 |
| 交付前钩子只许拦一次 | `src/cli.mjs` 的 `hook()`：Stop 事件读 stdin 的 `stop_hook_active` / `stopHookActive`，**续过一轮后不再阻断**（否则永远拦 = 死循环）；无台账的仓库静默放行。**放行判定必须排在未验证声明之前**：`check` 退出码 0 但有未验证条目时也拦一轮（把条目递给模型去声明"这条没能验证，原因是 X"）——真模型实测会在末尾点名照挂的情况下写"全部核实"。`test/cli.test.mjs` 五条；变异：去掉 `continuedBefore` 守卫 → 红 3；去掉未验证分支 → 红 1。真机接线：用户级 `~/.zcode/cli/config.json` 的 Stop 钩子，第一次回答被拦后模型续一轮、改成"卡在分叉，请定 A/B" |
| 自供字段一律拒收（含 evidence 内部） | `src/schema.mjs` 的 `field.unknown` 与 `evidence.field.unknown`：只认白名单键。`confidence`/`rationale`/`options_cost` 都进不去 |

## 已知的检出边界

别把"未判"当"没问题"。完整清单见 [`docs/BOUNDARIES.md`](docs/BOUNDARIES.md)。

## 改这些代码时的硬规矩

1. **红队层与浏览器层必须跟着跑**：`node --test test/redteam.test.mjs test/browser.test.mjs test/color.test.mjs`。前者测的是产品存在的理由（模型能否不实做却拿到"已验证"），中间那个测的是两百多个纯逻辑测试一行都没执行过的 DOM 采集代码，最后一个测的是色值换算（真 Chromium）。
2. **加一道拦之后要做变异验证**：把那处守卫改坏，测试必须变红；改回来必须绿。从来没报过错的守卫等于没加。已验证：`mapGrepExit` 的 `unknown`、`ls-files -z`（承重是 `-z`，`core.quotepath=false` 只是冗余）、未跟踪并入扫描、log 行号自校验、先干后证、header fail-closed、自供字段拒收、逐候选真算、焦点签名归一化。
3. **别在带未提交改动的文件上用 `git checkout --` / `git clean`**：这一条是踩过代价的——用 `git checkout` 复原一个被 sed 改过的文件时，把同一文件里未提交的正经改动一起打回了上个提交，靠重写才恢复。要复原就先 `cp` 出来再 `cp` 回去。
4. **变异要先确认它真的生效**：有一次 sed 的匹配串没命中，测试"照样绿"被误当成守卫有效。先 grep 出那一行、改完看 diff、再跑，才叫验证。
5. **文档改动也要看渲染结构**：往 markdown 表格里插段落时，锚点落在表中途会把后续行甩到别的章节下面（本轮真实发生过一次，靠复读才发现）。
6. **提交被钩子拒了就照报错拆文件**：`.githooks/pre-commit` 拒收超过 5000 token（≈20KB）的文件；别调阈值、别 `--no-verify`，按功能拆。新克隆先 `git config core.hooksPath .githooks`。
7. **写新函数、新规则前先搜项目里有没有现成的**：同一件事的第二份实现比没有实现更坏——两处都会被人当成权威。
8. **测试别把本仓库的发版状态当前提**：`observe.test.mjs` 原来直接拿本仓库当"无 tag 的干净仓库"样本，打上 `0.1.0` 后两条测试当场变红。要测"未发布"，就在临时目录重新 `git init` 一份工作树，别赌仓库当前有没有 tag、有没有上游。

## 为什么这些规则长这样

约束力必须挂在外部可计算的量上，不能挂在模型的自我评价上。上面每一行都是"改坏了会有东西报错"，而不是"文档里写着不要这样做"。加检查时请沿用同一标准：**把错放回去，检查必须变红**；从来没报过错的检查等于没加。

三处踩过的事实，别退回旧写法：

- `scrollbar-width: none` 不画滚动条、`scrollbar-gutter: stable` 已预留位——这两种都没有压在内容上的条带。
- headless Chromium 用覆盖式滚动条渲染（`offsetWidth - clientWidth === 0` 且 `scrollbar-width: auto`），所以"保留默认滚动条"不是修法。
- 容器自己的 sticky 子元素（日期分隔条）必然与容器矩形重叠，不按 `inside` 排除就会造出很常见的假红。
