# claimrail 是什么（新用户介绍）

> 一句话：**AI 在规格没写清楚的地方会默默选一个做法；claimrail 让它把这个选择写下来，程序算改回来的代价、回访它声称的证据，红的交不出去。**
>
> 它不教 AI 有品味。它只做一件事——**让 AI 在没依据的时候，不再伪装成有依据。**

## 它在解决什么问题

规格没写完时，AI 不会停下来问，它会输出"自己见过最多的那个做法"，然后交一个看起来已经想清楚的成品。岔路口被走掉了，而且**没有任何地方记录"这里曾经有过岔路口"**。

于是你会遇到这些话，而且没法当场分辨真假：

- "业界都这么做。"——真的查过，还是记忆里最常见？
- "改回来很容易。"——还是它已经推上了主干？
- "截图证明没问题。"——那张截图是这次的，还是上一次的？
- "我参考了仓库里的做法。"——还是它刚写的那段代码？
- "我记得你否决过 X。"——还是它编的？

claimrail 把"交付前"变成一个**有退出码的关卡**：以上每一句都必须落到可回验的依据上。**代价高又没依据**的选择会被拦住（`block`/`halt`）——它列出来问你，一次问完；**代价低、没依据**的选择不拦交付，但会进末尾的"未验证"清单、Stop 钩子还会逼交付说明逐条声明。红了不许交。

## 它怎么工作（三根支柱）

1. **决策台账**：AI 动手前先把"这次有哪些分叉、候选是什么、选了哪个"写进 `.claimrail/decisions.json`。没申报的分叉是这套机制**最主要、也最无从统计**的缺口，所以**不写就交不出去**（工作区有改动而台账还是模板 → `check` 退出 1）。

2. **程序算代价**：AI 只能把"改回来的代价"往高报；真正的档位由程序读 fan-in（多少处引用）、是否已发布到默认分支或打了 tag、有没有外部副作用算出来。AI 报低会被程序覆写并当场打印。取不到值一律按高处理——**读不到不许降级成乐观值**。

3. **可回验证据**：每条依据分五档，程序逐条重查：

   | 档位 | 什么时候用 | 程序怎么查 |
   | --- | --- | --- |
   | `repo` | 仓库里已有先例 | 重读 `file:line`；本次新增/修改的行不算"既有做法" |
   | `memory` | 你以前否决/点名过的东西 | `log#n` 必须存在且内容对得上 |
   | `render` | 真浏览器跑出来的报告 | 截图必须晚于最后一次代码改动；报告要绑住这张图（哈希重算比对），未判项（`null`）不作数 |
   | `precedent` | 设计类任务、本地无依据时 | 逐 URL 回访，引文必须出现在页面**可见正文**；按注册域去重后 ≥3 个独立域名 |
   | `web` | 单一来源补充说明 | 回访 200；设计类任务用这一档会被直接拒（一篇文章不算依据） |

   设计类任务（`ui-new` / `docs-new` / `api-design`）**用 `web` 档会被 schema 直接拒**；本地两档（`repo`/`memory`）拿不到依据时，协议要求走 `precedent` 而不是直接采用"最常见做法"——这正是用来对抗"AI 交出自己见得最多的那个"的一档。（注意：这是对 AI 的协议要求；程序层面真正强制的只有"设计类不能用单篇 `web` 收场"。）

   > `precedent` 和 `web` 要真回访时必须显式加 `--allow-net`——这是外发查询，默认需要你同意；不加，这两档一律判"未获同意"、等于没证据。

## 快速上手（从零到第一次绿色交付）

前提：一个 git 仓库，Node 20+（`package.json` 的 `engines` 要求）。

```bash
git clone https://github.com/1yang2471/claimrail.git
cd claimrail && npm install && npm link     # 让 claimrail 命令进 PATH
```

在**你自己的仓库**里：

```bash
claimrail init        # 写台账模板 + 往 AGENTS.md 写指路段 + 记一个起点（baseline）
                      # 顺手读一下它打印的"数据去向"——哪进 git、哪不进，都写明了

# ……让 AI（或你自己）干活……

claimrail check       # 交付前校验。退出码 0 才放行；台账还是模板会拦
```

第一次准会撞墙，这是设计如此。墙面长这样：

```
【未申报 · 台账仍是 init 模板】
工作区有改动（1 个文件）：app.ts
写 .claimrail/decisions.json：有分叉就写 forks；没有就写 "forks": [] 和 no_fork_reason。
无分叉的活最省事：把台账里 no_fork_reason 的占位行改成你的原因，改完重跑 check。
不要求你想清楚每个分叉，只要求把"这次有没有分叉"写下来。
```

改一下那行占位文字，重跑 `check`，就绿了。

要动前端/界面时，加一步真浏览器检查：

```bash
claimrail web --url http://localhost:5173/        # 双视口截图 + 五项几何检查（需 playwright）
```

五项检查：滚动条压字、触摸目标尺寸、对比度、焦点可见、底栏遮挡。每个视口末尾会给一行 **`可引用`**，里面是可直接粘贴进台账的 `evidence`（`ref` + 只有程序判绿的 `asserts`）——照抄它，别自己写；把 `null`（未判）写成"已验证"是这套机制最不能出现的造假。

## 拦什么（对照表）

| 你听到的声称 | 程序怎么核 |
| --- | --- |
| "业界都这么做" | 回访 ≥3 个独立域名；引文必须出现在页面可见正文，只出现在 `<script>` 里不算 |
| "改回来很容易" | 代价由程序从 fan-in、是否已发布、有无副作用算出；AI 只能往上调 |
| "截图证明没问题" | 截图必须晚于最后一次代码改动；报告里的未判项（`null`）不作数 |
| "参考了仓库里的做法" | 重读 `file:line`；本次新增/修改的行不算既有做法 |
| "我记得你否决过 X" | `log#n` 必须存在且内容对得上；行号错位直接报错 |
| "本任务没有分叉" | 台账仍是模板而 diff 非空 → 退出 1。写了 `forks: []` + `no_fork_reason` 算已申报；若 diff 又落在该类文件面上，打印审计项留痕（程序判不了"有没有分叉"，只让逃逸可统计） |

## 偏好闭环（越用越贴你）

```bash
claimrail record --key card-gap --what "卡片上下间距至少 16px" --why "贴太紧"
claimrail rules                 # 现行规则 + 原始否决 + 来源
claimrail invalidate <key>      # 作废一条规则；原始 log 一条不动（log 是真相，规则是缓存）
```

同一条否决命中两次才升格成规则——一次随口的吐槽不该被永久固化。它记住的不是"人类一般喜欢什么"，而是**"这个人在这个仓库里拒绝过什么"**。

## 接进 AI Agent

两步，第一步必做：

- **指路（`init` 自动写）**：往目标仓库 `AGENTS.md` 写一段带 marker 的指路，让 agent 跑 `claimrail skill` 读协议。这条命令从安装包自身打印，所以 Python / Go 仓库（没有 `node_modules`）同样成立。实测：只靠 skill 描述触发不了，写进 `AGENTS.md` 才管用。
- **Stop 钩子（可选）**：挂在宿主的"一轮响应结束"事件上。退出码 2 = 拦住并续一轮，stderr 交给模型去修。没初始化过的仓库静默放行；`stop_hook_active` 为真时不再重复阻断（防死循环）。

## 它**不**做什么（诚实边界）

- **不教 AI 有品味**，只逼它在没依据时说出来。品味决策仍要你来定。
- **SPA 壳页够不着**：`m3.material.io` 200 + 62KB HTML，可见正文只剩 15 个字符——设计系统站普遍如此，`precedent` 这档没法核实它们。
- **引文命中 ≠ 页面在推荐该做法**：实测有两处命中的是例外条款。程序判不了语气，`url + quote` 留给 reviewer 抽查上下文。
- **报告的落盘链防的是不一致，不是防伪造**：`shot_sha256` 挡得住手写报告、旧报告换新图，但直接改报告 JSON 的内容不在防御范围——威胁模型是"不合作但不攻击"。
- **对比度在磨砂/渐变背景上**、采样点跨渐变、文字压在花哨图片上时，报"未判"而不是"合格"。
- 需要你真实凭据的私有产品页没跑过；需要登录的本地站已实测。

## 谁适合用

- 用 AI 写代码、又不想在交付时被"我已经验证过了"糊弄的人；
- 团队里要让 AI 的产出可 review、可追责的人；
- 做 CI：`claimrail check` 用退出码说话，约束力不依赖任何人的记性（npm 发布后 `npx claimrail check`；当前未发布，先按上面源码安装）。

## 数字

- `node --test`：417 项，415 通过 + 2 skip（两条真网络烟测默认关），0 失败。
- 基准：20 个陷阱任务 × 2 臂（普通提示 vs `init` + 协议提示），模型 `workbuddy-ai/deepseek-v4.1-flash-sg`。off 臂交付 12/20、静默塌缩 4/12；on 臂交付 6/20、静默塌缩 0/6、`check` 拦住 9/20。数据与口径见 `README.zh-CN.md` 的基准一节（单一模型、每对一次，是方向性数字，不是通用塌缩率）。

---

## English

**One line:** where the spec is silent, AI silently picks a variant; claimrail makes it write the choice down, has a program compute what it costs to undo, re-verifies the evidence it claims, and blocks red deliveries. It doesn't teach taste — it stops AI from *pretending to have grounds when it doesn't*.

**How it works (three pillars):** a decision ledger (`.claimrail/decisions.json`) that must be written or nothing ships; a program-computed cost (fan-in, published-to-default-branch, side effects — the model may only raise it); and five re-verifiable evidence tiers (`repo` / `memory` / `render` / `precedent` / `web`), each re-checked by the program.

**Quick start:** `npm link` from a checkout, then `claimrail init` in your repo → work → `claimrail check` (exit 0 ships). For UI work add `claimrail web --url …` (two viewports + five geometry checks).

**What it catches:** "everyone does it", "easy to revert", "the screenshot proves it", "I followed the existing pattern", "I remember you rejected X", "there are no forks" — each pinned to evidence a program re-checks.

**What it does NOT do:** teach taste; reach SPA shell pages; judge whether a quote is a recommendation or an exception clause; protect the report file's *content* against editing (the threat model is "uncooperative, not attacking"); judge contrast over gradients. See `docs/BOUNDARIES.md`.
