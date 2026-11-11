---
name: claimrail
description: 在规格没定的地方留下决策台账，交付前由程序算代价、回验证据。**要动界面/页面/样式/文档/接口/组件之前先加载**；同一处存在两种以上合理写法、用户说"这不是我要的""看着不舒服""按我们的惯例来"、前端改动收尾、claimrail check 报 block 时也用。只有三类不用：改错别字、纯重命名、已知成因的 bug（这三类写 forks: [] 加一句原因）。 Leave a decision ledger wherever the spec is underspecified; a program computes cost and re-verifies evidence before delivery. Load this BEFORE touching UI/pages/styles/docs/APIs/components, when more than one reasonable implementation exists, when the user says "not what I wanted"/"looks off"/"follow our conventions", when wrapping up a frontend change, or when claimrail check blocks. Only three exceptions: typo, pure rename, bug with a known cause (write forks: [] plus a reason).
---

# claimrail：让选择留下痕迹

> 动手前先读完本文件。只要这次改动存在两种以上合理写法，就必须走协议——**哪怕你觉得它很小**。"小改动"是最常见的逃逸口，不是理由。

你在规格没写到的地方必须输出点什么，于是你会输出你见过最多的那个做法。这不是品味问题，是分布问题。这个技能把那一歩变成**看得见的决定**：先申报分叉，程序算改回来的代价，证据必须能被回访，红的不许交。

约束力不来自你把这段话读得多认真，来自 `claimrail check` 的退出码。

## 一、这次任务要不要走协议

按 `task_class` 判，别按"我觉得这次很简单"判：

- 走协议：`ui-new` `docs-new` `api-design` `refactor`
- 不走：`typo` `rename` `bugfix-known-cause`（此时写 `"forks": []` 并给一句 `no_fork_reason`）

申报无分叉不禁止，但每次都会落盘。一个类别从来不长分叉，就是在这里逃逸。

若本次 diff 落在该类的面上（UI / 文档 / 接口文件），`check` 还会把这条审计项打印出来。它不拦交付——但**台账一字未动、工作区却有改动时，`check` 会退出 1**；写一句 `forks: [] + no_fork_reason` 才算申报。审计项不是噪音，是 review 时最先看的地方。

## 二、写台账

`.claimrail/decisions.json`：

```jsonc
{
  "schema": 1,
  "task_class": "ui-new",
  "forks": [
    {
      "fork": "聊天滚动区：覆盖式滚动条还是留 gutter",
      "options": ["覆盖式", "留 gutter"],
      "picked": "留 gutter",
      "evidence": { "kind": "repo", "ref": "src/Chat.tsx:88", "asserts": ["scrollbar-gutter"] },
      "target": { "file": "src/Chat.tsx", "symbol": "MessageList" },
      "cost_if_wrong": "low",
      "verified": true
    }
  ]
}
```

规则，不是建议：

- `options` 至少两项。只写得出一种，说明你还没找到分叉，不是这里没有分叉。
- 要程序比较候选的代价：候选写成 `{ "label": "覆盖式", "target": { "file": "src/Chat.tsx" } }`——**每个候选都带 target 才算得出**；缺一个，输出只报"候选代价未算出"（合法但逃逸可统计）。
- 每个字段一行，不许内联代码。台账要进 git 给人 review。
- `cost_if_wrong` 你只能往高报。程序会算，你报低了会被覆写并打印出来——那次覆写就是你要重新想一遍的地方。
- `evidence: null` 时 `verified` 必须是 `false`。"我还没来得及查"是合法状态，"我没查但我说查了"不是。
- `verified` 只是写给人和 reviewer 看的申报，`check` 不采信它——证据照样逐条回验。别把它当免检开关。
- 不确定的分叉要写出来，哪怕你打算照默认做。**没申报的分叉是这套机制唯一抓不到的东西。**

## 三、证据分五档

本地三档优先（便宜、离线、权威），先说清它们长什么样：

- **repo**（仓库既有做法）——`{ "kind": "repo", "ref": "src/Chat.tsx:88", "asserts": ["scrollbar-gutter"] }`。
- **memory**（本仓库的历史否决）——`{ "kind": "memory", "ref": "log#16", "asserts": ["覆盖式滚动条"] }`；ref 只认 `log#n`，asserts 是 ≥3 字符、对得上那条 log 内容的要点。`claimrail record` 写的就是这个文件。
- **render**（真浏览器报告）——`{ "kind": "render", "ref": ".claimrail/shots/名字.png", "asserts": [五项检查里判绿的 id] }`；**照 `claimrail web` 输出末尾给的一行抄，不要手写**——报告里没判的项写成判了，是最不能出现的伪造。

然后：

- **precedent（业界收敛）**——**设计类任务在 `repo` 与 `memory` 都拿不到依据时，必须走这一档，不许直接采用"最常见做法"**。理由：`repo` 回答的是"这个库怎么一致"，回答不了"业界公认的好做法是什么"；绿色项目没有前者，而只对齐仓库既有水平会把产出永久钉在平均值上。这一档就是用来对抗"AI 交出自己见得最多的那个"的。

  ```jsonc
  "evidence": {
    "kind": "precedent",
    "sources": [
      { "url": "https://alpha.dev/guide", "quote": "推荐用 8pt 栅格控制列表项纵向间距" },
      { "url": "https://beta.design/guide", "quote": "…" },
      { "url": "https://gamma.io/guide",  "quote": "…" }
    ],
    "adoption": { "repo": "primer/css", "minStars": 5000 }   // 可选，star 数由 GitHub API 实测
  }
  ```

  程序怎么查它：**逐个回访，引文必须真在那一页上**；按注册域去重后 **≥3 个独立域名**（转载同一篇不算两票）；`adoption` 的数字从 API 读，不接受任何转述。所以"某产品好评率很高"这种没量纲的话在这里说不出口——这正是它以前说不出口的原因。

- **web**：单一来源的补充说明。`ui-new` / `docs-new` / `api-design` 这三类**用它会被 schema 直接拒**，因为设计决策不能靠一篇文章。

够了就停：`repo → memory → render → precedent → web`。前四档能定案就不要往下走，`web` 之外都无依据时，答案是"去问人"，不是"照默认的来"。

## 四、交付前必须过门

```
claimrail check            # 本仓库内开发时用：node src/cli.mjs check
```

- `✓ 可以交付`（退出码 0）：继续。
- `✗ 交付被拦住（block）`：它列出的分叉**先问用户再动手**，一次问完，不要拆成三轮。问题就是台账里那些 `evidence: null` 的条目。
- `check` 最多运行两次；第二次仍被拦，就停下来把要用户定的事一次问完，不要继续硬试。
- `✗ 交付被拦住（halt）`：无人值守且高代价没证据。停下报告卡在哪，不要"先按常见做法建起来回头再说"。
- 台账结构不合规：先修申报，后面什么都不用跑。

## 五、前端改动

```
claimrail web --url http://localhost:5173/chat --state .claimrail/storage.json
```

多视口是默认的（390×700 和 1280×800）——覆盖式滚动条压字这类缺陷只在窄屏出现，只跑宽屏等于放过。

五项检查是：**滚动条压字**（scrollbar-clears-text）、**触摸目标**（touch-targets-ok）、**对比度**（contrast-ok）、**焦点可见**（focus-visible-ok）、**底栏遮挡**（bottom-not-covered）。报告里 `null` 是"没判"，不是"合格"；asserts 只抄判绿的 id。

页面起不来或需要登录又没登录态：**不许静默跳过**。在交付说明里写明"这一条我没能视觉验证，原因是 X"，并跑能跑的部分。

输出末尾会给一行可直接粘贴的 `evidence`，`asserts` 里只有程序判绿的项。照抄它，不要自己列——把 `null`（未判）写成"已验证"是这套机制最不能出现的事。

## 六、被用户否决之后

```
claimrail record --key card-gap --what "卡片上下间距至少 16px" --why "贴太紧"
```

同一条命中两次才升格成规则；`claimrail invalidate <key>` 废掉一条规则，但原始 log 不动（log 是真相，规则是缓存）。

用户说"不是这个"的时候，你要记的是**要什么**（`--what`），不是他那句抱怨的原话。下次动手前先 `claimrail rules`。

`--anchor` 记的是**参照物**：用户点名"照这个做"的正例（"按我们仓库的惯例来"）。它不参与升格，不会变成规则——它的用途是下次同类分叉时点名"照 log#n 那个参照物做"，并在 `claimrail rules` 里单独一列。

## 不许做

- 不许为了过门把 `evidence` 填成看起来能回验但实际没跑过的东西——五种 kind 全部会被程序回访。`precedent` 尤其查得狠：域名会去重，引文会逐条比对原文。
- 不许把 `forks: []` 当默认答案。
- 不许在 block 时改台账措辞绕过提问，要改的是"去拿证据"或"去问人"。

---

# claimrail (English)

> Read this whole file before you start. If this change has more than one reasonable implementation, the protocol applies — **even if you think it's small**. "It's a small change" is the most common escape hatch, not a reason.

Where the spec is silent you must output something, so you output the most common thing you've seen. That is not a taste problem, it's a distribution problem. This skill turns that step into a **visible decision**: declare the fork first, let a program compute what it costs to undo, and make the evidence re-visitable. Red does not ship.

The force does not come from how carefully you read this page. It comes from `claimrail check`'s exit code.

## 1. Does this task go through the protocol?

Judge by `task_class`, never by "this one looks simple":

- Through the protocol: `ui-new` `docs-new` `api-design` `refactor`
- Not through: `typo` `rename` `bugfix-known-cause` (write `"forks": []` plus a one-line `no_fork_reason`)

Declaring "no forks" is allowed but always recorded. A category that never grows a fork is where the escape happens.

If the diff touches files of that task class (UI / docs / API), `check` also prints an audit item. It does not block delivery — but **an untouched ledger template with a non-empty diff makes `check` exit 1**; only `forks: [] + no_fork_reason` counts as a declaration. The audit item is not noise; it is the first place a reviewer looks.

## 2. Write the ledger

`.claimrail/decisions.json`:

```jsonc
{
  "schema": 1,
  "task_class": "ui-new",
  "forks": [
    {
      "fork": "Chat scroll area: overlay scrollbar or reserved gutter",
      "options": ["overlay", "reserve gutter"],
      "picked": "reserve gutter",
      "evidence": { "kind": "repo", "ref": "src/Chat.tsx:88", "asserts": ["scrollbar-gutter"] },
      "target": { "file": "src/Chat.tsx", "symbol": "MessageList" },
      "cost_if_wrong": "low",
      "verified": true
    }
  ]
}
```

Rules, not suggestions:

- `options` needs at least two entries. If you can only think of one, you haven't found the fork — it doesn't mean there isn't one.
- To let the program compare option costs: write options as `{ "label": "overlay", "target": { "file": "src/Chat.tsx" } }` — **every option needs a target or the cost can't be computed**; with one missing, the output just says the option costs couldn't be computed (legal, but it goes on the escape tally).
- One field per line, no inline code. The ledger goes into git for humans to review.
- `cost_if_wrong` can only be raised by you. The program computes its own grade; if yours is lower it gets overwritten and printed — that overwrite is the place to think again.
- When `evidence` is `null`, `verified` must be `false`. "I haven't checked yet" is a legal state; "I didn't check but said I did" is not.
- `verified` is a declaration for humans and reviewers only; `check` does not trust it — evidence is still re-verified item by item. Do not treat it as a bypass.
- Write down the forks you're unsure about, even if you plan to take the default. **An undeclared fork is the only thing this mechanism cannot catch.**

## 3. Five evidence tiers

Local tiers first (cheap, offline, authoritative). What they look like:

- **repo** (existing practice in this repo) — `{ "kind": "repo", "ref": "src/Chat.tsx:88", "asserts": ["scrollbar-gutter"] }`.
- **memory** (this repo's recorded rejections) — `{ "kind": "memory", "ref": "log#16", "asserts": ["overlay scrollbar"] }`; ref is always `log#n`, asserts are ≥3-char keys that match that log entry's content. `claimrail record` writes this file.
- **render** (real-browser report) — `{ "kind": "render", "ref": ".claimrail/shots/name.png", "asserts": [ids of checks that passed] }`; **copy the paste-ready line from the end of `claimrail web` output, never write it by hand** — writing a null (not-judged) as "verified" is the one thing this mechanism must never do.

Then:

- **precedent (industry convergence)** — for design tasks, when neither `repo` nor `memory` gives you grounds, you must use this tier; taking "the most common approach" directly is not allowed. `repo` answers "how is this codebase consistent", not "what is the accepted good practice"; a greenfield project has no former, and aligning only with the repo pins output at the average forever. This tier exists to counter "AI ships what it has seen most".

  ```jsonc
  "evidence": {
    "kind": "precedent",
    "sources": [
      { "url": "https://alpha.dev/guide", "quote": "recommends an 8pt grid for list item spacing" },
      { "url": "https://beta.design/guide", "quote": "…" },
      { "url": "https://gamma.io/guide",  "quote": "…" }
    ],
    "adoption": { "repo": "primer/css", "minStars": 5000 }   // optional; star count is read live from the GitHub API
  }
  ```

  How the program checks it: **each URL is re-fetched and the quote must actually be on that page's visible text**; deduplicated by registrable domain it needs **≥3 independent domains** (three blogs reposting one article is not three votes); `adoption` numbers are read from the API, never from a claim. So "this product has a great review score" can't be said here — which is exactly why it couldn't be said before.

- **web**: a supplementary single source. For `ui-new` / `docs-new` / `api-design` the schema **rejects** this tier outright: a design decision cannot rest on one article.

Stop when you have enough: `repo → memory → render → precedent → web`. If the first four can settle it, don't go further; when none apply, the answer is "ask a human", not "go with the default".

## 4. You must pass the gate before delivering

```
claimrail check            # inside this repo: node src/cli.mjs check
```

- `✓ 可以交付` (exit 0): continue.
- `✗ 交付被拦住（block）`: **ask the user about the listed forks before doing anything else**, all at once, not in three rounds. The questions are the `evidence: null` entries.
- `✗ 交付被拦住（halt）`: unattended, high cost, no evidence. Stop and report where you're stuck; do not "build the common version now and revisit later".
- Ledger structurally invalid: fix the declaration first, nothing else needs to run.
- Run `check` at most twice; if the second run still blocks, stop and ask everything in one go — don't keep grinding.

## 5. Frontend changes

```
claimrail web --url http://localhost:5173/chat --state .claimrail/storage.json
```

Multiple viewports are the default (390×700 and 1280×800) — defects like an overlay scrollbar covering text only show up on narrow screens, so running wide-only means letting them through.

The five checks: **scrollbar clears text** (scrollbar-clears-text), **touch targets** (touch-targets-ok), **contrast** (contrast-ok), **focus visible** (focus-visible-ok), **bottom bar not covered** (bottom-not-covered). A `null` in the report means "not judged", not "fine"; copy only the ids that actually went green into `asserts`.

If the page won't load, or needs a login you don't have: **never skip silently**. State in your delivery notes "I could not visually verify this item, because X" and run whatever you can.

The output ends with a paste-ready `evidence` line whose `asserts` contain only checks the program passed. Copy it verbatim, don't write your own — turning `null` (undecided) into "verified" is the one thing this mechanism must never do.

## 6. After the user rejects something

```
claimrail record --key card-gap --what "card vertical gap at least 16px" --why "too cramped"
```

A key must be hit twice before it becomes a rule; `claimrail invalidate <key>` retracts a rule, and the raw log stays untouched (the log is truth, rules are cache).

When the user says "not this", record **what they want** (`--what`), not their complaint verbatim. Run `claimrail rules` before your next change.

`--anchor` records a **reference** (positive example): when the user points at something to imitate ("follow our repo's convention"). It never becomes a rule — its use is naming it next time ("do it like reference log#n"), listed separately in `claimrail rules`.

## Never do this

- Never fill `evidence` with something that looks verifiable but was never run — all five kinds are re-checked by the program. `precedent` is checked hardest: domains are deduplicated and every quote is compared against the page.
- Never treat `forks: []` as the default answer.
- Never reword the ledger to get past a block; get evidence or ask a human.
