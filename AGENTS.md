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

## 改这些代码时的两条硬规矩

1. **红队层必须跟着跑**：`node --test test/redteam.test.mjs`。它测的是这个产品存在的理由（模型能否不实做却拿到"已验证"）。以前 170 多个测试全是老实 ctx 的用例，结果外部审查当场复现出三条伪造路径——测试守的是正常请求，不是主张。
2. **加一道拦之后要做变异验证**：把那处守卫改坏，测试必须变红；改回来必须绿。从来没报过错的守卫等于没加。已验证过：`mapGrepExit` 的 `unknown`、`ls-files -z`（承重是 `-z`，`core.quotepath=false` 只是冗余）、未跟踪并入扫描、log 行号自校验、先干后证、header fail-closed。
3. **别在带未提交改动的文件上用 `git checkout --` / `git clean`**：这一条是踩过代价的——用 `git checkout` 复原一个被 sed 改过的文件时，把同一文件里未提交的正经改动一起打回了上个提交，靠重写才恢复。要复原就先 `cp` 出来再 `cp` 回去。
| 副作用扫描不许扫到规则表和测试数据 | `src/observe/effects.mjs` 的 `addedCode` 排除 test/fixtures/docs/规则表自身 |
| 前端检查默认跑多视口 | `src/cli.mjs` 的 `web` 默认 `390x700,1280x800`。注意：`--viewport` 可以覆盖成单个，所以这条是默认值约束，不是硬拦 |
| 偏好 log 只追加，规则是缓存 | `src/store.mjs` 坏行直接报错（行号是引用坐标，跳过一行会让所有 `log#n` 错位） |

## 为什么这些规则长这样

约束力必须挂在外部可计算的量上，不能挂在模型的自我评价上。上面每一行都是"改坏了会有东西报错"，而不是"文档里写着不要这样做"。加检查时请沿用同一标准：**把错放回去，检查必须变红**；从来没报过错的检查等于没加。

三处踩过的事实，别退回旧写法：

- `scrollbar-width: none` 不画滚动条、`scrollbar-gutter: stable` 已预留位——这两种都没有压在内容上的条带。
- headless Chromium 用覆盖式滚动条渲染（`offsetWidth - clientWidth === 0` 且 `scrollbar-width: auto`），所以"保留默认滚动条"不是修法。
- 容器自己的 sticky 子元素（日期分隔条）必然与容器矩形重叠，不按 `inside` 排除就会造出很常见的假红。
