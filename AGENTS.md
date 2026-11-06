# forklight 项目规则

新 agent 进来先跑 `node --test`（177 个，约 1.5 秒），再读 `docs/PRD.md`。PRD 是需求源头，十四轮盘问的结论都在里面；它没写的范围，v1 不做。

## 规则表

| 规则 | 由什么拦住 |
| --- | --- |
| 台账不许内联代码、不许多行、不许两档以外的代价档位 | `src/schema.mjs` + `test/schema.test.mjs` |
| 没证据不许声称已验证（`evidence: null` ⇒ `verified: false`） | `src/schema.mjs` 的 `evidence.null-vs-verified` |
| 模型不许给自己的改动报低代价 | `src/cost.mjs` 的 `apply()`：程序算出 high 就覆写，且 `check` 打印覆写原因 |
| 读不到仓库状态不许降级成乐观值 | `src/observe/git.mjs` 的 `mapGrepExit` + `test/observe.test.mjs` 非 git 目录用例（已用变异验证：`unknown` 改成 `none` 会红两条） |
| 采集不到数据不许判绿 | `src/observe/geometry.mjs` 三态 `null` + `src/evidence.mjs` 只认严格 `true`（报告全 null 或只有截图无报告都判失败） |
| 视觉证据必须是新的 | `src/evidence.mjs` render 档比较截图 mtime 与 `newestTrackedMtime`；`.forklight/`、`memory/` 从时间戳里排除，否则台账总在截图之后写，每条 render 证据都会先天"过时"，报告层的伪造检查永远轮不到 |
| 不许伪造度量报告 | `src/evidence.mjs`：id 必须 ∈ `RENDER_CHECK_IDS`、五项齐全、`report_schema` 版本对、`name` 与截图同名、断言项必须严格 true（`test/redteam.test.mjs`） |
| 不许引用本次刚写的代码冒充既有做法 | `observe/git.mjs` 的 `changedLines` + `isChangedLine`，经 `cli.makeCtx` 注入 `ctx.isChanged`（`test/redteam.test.mjs`） |
| 未跟踪文件不能对档位隐身 | `observe/git.mjs` 的 `worktreeScanText` 把 `git status --porcelain -z` 的 `??` 并进副作用扫描与 mtime（`test/redteam.test.mjs`） |
| 弱断言不算证据 | `src/evidence.mjs`：断言 ≥3 字符、区间 ≤40 行、行号 ≥1 且不倒序；schema 端同规则（`test/evidence.test.mjs`、`test/redteam.test.mjs`） |
| log 行号是引用坐标 | `src/store.mjs`：坏 JSON、坏形状、行内 `at` 与物理行号不符，三种一律硬拦（删一行即让全部既有引用悄悄改指） |
| 禁用名单不许静默失效 | `src/store.mjs` 的 `readDenied` 读坏了就报错，不能当成"没禁过"（否则被用户作废的规则会复活） |
| 副作用扫描单位是单文件新增行 | `src/observe/effects.mjs` 的 `addedCode` 返回数组、`scanDiff` 逐文件扫；认不出的 diff header 整段不归属。跨文件拼接会把两个无关文件缝成一条 `recursive-delete` |
| 诚实申报不该被罚 | `effects.mjs` 的 `SELF_IGNORE` 含 `.forklight/`、`memory/`、`docs/`、`README/AGENTS.md`、测试与 fixtures、规则表自身 |
| 前端检查默认跑多视口 | `src/cli.mjs` 的 `web` 默认 `390x700,1280x800`。注意：`--viewport` 可以覆盖成单个，所以这条是默认值约束，不是硬拦 |
| 假红防线：容器作用域、贴底定义、截断不作数 | `src/observe/geometry.mjs`：文本按 `container` 归属比较；遮挡只认"贴底 + 覆盖宽度 ≥30%"的条；`raw > 实际条数` 时改判 `null`（`test/geometry.test.mjs`） |
| 焦点签名按"能不能被看见"归一化 | `src/observe/driver.mjs` 的 `styleSig`：`outline-style:none` 或宽度为 0 时丢弃 outline 颜色/宽度。变异验证：取消归一化 → `test/browser.test.mjs` 红（`a{outline:none}` 又被判成"焦点可见"） |
| 先采基线、再走 Tab，顺序不许倒 | `src/observe/driver.mjs` 交出 `focusProbe` 回调，`renderPage` 在 `evaluate(collectInPage)` 之后才调用它。倒过来会让"未聚焦基线"带着焦点，焦点检查一路判绿 |
| 真浏览器路径必须有自动化覆盖 | `test/browser.test.mjs`（真 Chromium 打开对照页；没装 Playwright 则整文件 skip，不伪绿）。`--state` 另用本地 HTTP 页验证 cookie + localStorage 确实注入，变异 `storageState`→`zzState` 测试红、恢复绿 |
| 副作用扫描不许扫到规则表和测试数据 | `src/observe/effects.mjs` 的 `addedCode` 排除 test/fixtures/docs/规则表自身 |
| 前端检查默认跑多视口 | `src/cli.mjs` 的 `web` 默认 `390x700,1280x800`。注意：`--viewport` 可以覆盖成单个，所以这条是默认值约束，不是硬拦 |
| 偏好 log 只追加，规则是缓存 | `src/store.mjs` 坏行直接报错（行号是引用坐标，跳过一行会让所有 `log#n` 错位） |
| 采不到真值时不许兜底猜测 | `web.mjs` 的 `bgOf`：渐变/图片背景、最底层半透明一律 `null`（真站实测：兜底白色一次造 83 处假红） |
| 半透明层要合成后再比 | `geometry.mjs` 的 `parseRgba`/`over`；背景自己半透明则未知（真站实测：`rgba(0,0,0,.05)` 被当纯黑，76/103 假红） |
| 行内文字链接不按控件标准考核 | `web.mjs` 采 `inline` 标记 + `geometry.touchTargetsOk` 排除（真站实测：16 处假红） |
| 截图文件名必须带 URL 指纹 | `driver.mjs` 的 `nameFromUrl`（真站实测：三个 index.html 收敛同名，前一份证据被后一份覆盖） |

| 设计类任务不许拿"一篇文章这么说"当好设计依据 | `src/schema.mjs` 的 `evidence.design-needs-precedent`：`ui-new`/`docs-new`/`api-design` 的 `kind: 'web'` 直接拒；必须给 `precedent`（`test/precedent.test.mjs`，变异验证：改成 `if (false)` → 红） |
| "业界收敛"必须可回访 | `src/evidence.mjs` 的 `verifyPrecedent`：逐个 URL 回访 200 + 引文出现在页面**可见正文** + 按注册域去重 ≥3（`MIN_SOURCES`，变异验证：降到 1 → 红 3 条）；`adoption` 的 star 数从 GitHub API 读，不达门槛或返回非 JSON 都判失败 |
| 引文对照可见正文，不对照传输字节 | `evidence.mjs` 的 `visibleText()`（去 script/style/注释/标签 + 解实体）+ 壳页分诊 `VISIBLE_MIN`。真网络实测 24 URL：17 个可选出引文，其中 9 个原始 HTML 直接命中、**8 个被行内标签切开**、0 个靠实体解码救回。拦住"引文只出现在 `<script>` 字符串里"这类假绿。测试：`test/precedent.test.mjs` 三条 + `test/evidence.test.mjs` web 档一条；变异验证：`visibleText` 退回 `norm(html)` → 红 4 条，只去掉脚本剥离 → 红 2 条 |
| 采不到正文的页面要说"读不到"，不许算成编造 | `evidence.mjs` 的壳页分诊（可见正文 < `VISIBLE_MIN` 字符）。实测 `m3.material.io` 200 + 62KB HTML 只剩 15 字符、`developer.apple.com` 剩 38 字符——设计系统站普遍是 SPA。老实 agent 与编造 agent 必须拿到不同判词；要真判这一类得渲染，与对比度像素采样同列 v2 |
| 回访必须声明语言 | `src/cli.mjs` 的 fetch 带 `headers: {'accept-language': 'en'}`（实测 web.dev 不带语言标返回过法语页，英文原句在自己引过的那篇上匹配不上）。`test/cli.test.mjs` 起本地 http server 断言收到该头；变异验证：删掉该行 → 红 |
| 自供字段一律拒收（含 evidence 内部） | `src/schema.mjs` 的 `field.unknown` 与 `evidence.field.unknown`：只认白名单键。`confidence`/`rationale`/`options_cost` 都进不去 |

## 已知的检出边界（别把"未判"当"没问题"）

- `contrast-ok` 在磨砂卡片 + 渐变背景的设计上覆盖率极低（真站 7/111）。这类页面对比度没报红不代表合格，是**判不了**；要判得靠截图像素采样（v2）。
- 非 git 目录里三个代价输入全部取不到 → 一切按 high。forklight 在 git 之外基本失明，这是边界不是特性。
- 没有 dev server / 登录态时，SPA 只会得到"五项全未判"，且报告不可引用（0 项绿）。工具不会替你把服务起起来。Shinsekai 真 Vite SPA 已实测：双视口各有触摸目标红（13/12 处），scrollbar/focus 绿，对比度/底部遮挡未判；首次依赖预构建时宽屏 `networkidle` 20 秒超时，预热后重跑成功。绿、红、未判必须分开报告。
- 引文核实只保证**可见正文里有这串字**，不保证那个页面在推荐这个做法。实测 24 个 URL 里有两处命中的是例外条款：W3C 用色页的 "an author cannot use color alone to achieve 3:1 contrast…"、SC 2.5.8 的 "links within paragraphs of text do not need to meet the 24 by 24 css pixels requirements…"。语气程序判不了，台账里的 `url + quote` 就是留给 reviewer 抽查上下文的——这是这一档唯一的人防线，别把它当程序保证。
- "≥3 独立域名推荐同一做法"在数字本身不收敛的主张上不该成立：触摸目标尺寸实测是 24 CSS px（WCAG 2.2 AA）/ 44pt（Apple）/ 48dp（Material）/ 1cm×1cm（NN/g，物理尺寸）。这种分叉该申报的是"各家数字不一致，我选 X 因为 Y"，硬凑"业界都这么做"会被回访戳穿。
- 反爬站回访直接 403（实测 stackoverflow 的问答页）。不伪造浏览器 UA 去绕——这类来源就是不可核实，换静态文档站。补测又见 Medium 系（medium.com、uxdesign.cc）对无浏览器指纹的回访一律 403，`adamsilver.io` 用 undici 直连 fetch failed：**口碑好的 UX 文章有一批永远够不着**，凑不齐 3 域时先检查是不是撞了这类站，而不是急着说"业界不收敛"。
- 分叉型主张（"A 还是 B"）的证据可以引**任一候选方向**的句子，但必须写清支持的是哪个候选；NN/g 谈数据表格的 "unlike with a card-based UI…" 不是支持卡片的票。口味类 4 主张 × 4 域名补测虽有 2/4 通过字串回验，自动筛选混入标题/FAQ 和语义不符的引文，**不等于 2 条主张有三域同向推荐**；强制 precedent 的口味类有效性尚未证实。

## 改这些代码时的硬规矩

1. **红队层与浏览器层必须跟着跑**：`node --test test/redteam.test.mjs test/browser.test.mjs`。前者测的是产品存在的理由（模型能否不实做却拿到"已验证"），后者测的是两百多个纯逻辑测试一行都没执行过的 DOM 采集代码。
2. **加一道拦之后要做变异验证**：把那处守卫改坏，测试必须变红；改回来必须绿。从来没报过错的守卫等于没加。已验证：`mapGrepExit` 的 `unknown`、`ls-files -z`（承重是 `-z`，`core.quotepath=false` 只是冗余）、未跟踪并入扫描、log 行号自校验、先干后证、header fail-closed、自供字段拒收、逐候选真算、焦点签名归一化。
3. **别在带未提交改动的文件上用 `git checkout --` / `git clean`**：这一条是踩过代价的——用 `git checkout` 复原一个被 sed 改过的文件时，把同一文件里未提交的正经改动一起打回了上个提交，靠重写才恢复。要复原就先 `cp` 出来再 `cp` 回去。
4. **变异要先确认它真的生效**：有一次 sed 的匹配串没命中，测试"照样绿"被误当成守卫有效。先 grep 出那一行、改完看 diff、再跑，才叫验证。
5. **文档改动也要看渲染结构**：往 markdown 表格里插段落时，锚点落在表中途会把后续行甩到别的章节下面（本轮真实发生过一次，靠复读才发现）。

## 为什么这些规则长这样

约束力必须挂在外部可计算的量上，不能挂在模型的自我评价上。上面每一行都是"改坏了会有东西报错"，而不是"文档里写着不要这样做"。加检查时请沿用同一标准：**把错放回去，检查必须变红**；从来没报过错的检查等于没加。

三处踩过的事实，别退回旧写法：

- `scrollbar-width: none` 不画滚动条、`scrollbar-gutter: stable` 已预留位——这两种都没有压在内容上的条带。
- headless Chromium 用覆盖式滚动条渲染（`offsetWidth - clientWidth === 0` 且 `scrollbar-width: auto`），所以"保留默认滚动条"不是修法。
- 容器自己的 sticky 子元素（日期分隔条）必然与容器矩形重叠，不按 `inside` 排除就会造出很常见的假红。
