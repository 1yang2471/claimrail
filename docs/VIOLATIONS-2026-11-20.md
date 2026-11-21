# 第一例真实拦截复盘（violations.jsonl 第一条记录）

> 回答 EVAL-2026-11-13 §6 排好的下一步："等第一次真实拦截发生（violations.jsonl 第一条记录），复盘续轮行为——补上防御价值闭环的最后一块实证。"

## 记录原文（可回验）

```json
{"at":"2026-11-20T18:05:41.975Z","reason":"stale","changed":[".github/workflows/ci.yml","src/commands/hook.mjs","src/observe/git.mjs","src/observe/pixel.mjs","src/observe/web.mjs"],"changedTotal":9}
```

（+0800 = 2026-11-21 02:05:41。`changed` 是前 5 个文件，`changedTotal` 9。）

## 时间线（全部可回验）

- baseline 停在 `7be6301`（0.2.9 发布提交，11-13）：0.2.9 之后的发布惯例「chore: baseline 前移」断档——0.2.9 之后的已提交工作（11-14~11-18，`ba9b66f..f92066c`，正是被列出的那批文件）对门**持续**呈现为"工作区有改动"。
- 02:05:41 stale 拦截：9 个文件相对 stale baseline 呈现为改动，台账（`decisions.json`，mtime 2026-11-14 17:20）自上次放行后未变 → 拦一次。防死循环护栏没输：拦一次 → 续轮 → 放行+落盘，无死锁。
- 12 分钟后（02:17）delivery 成功，快照推进；台账 mtime 未动。工作树现已干净（最后提交 `f92066c`，11-18）。

## 机制判定

- **拦截本身按设计工作**；输掉的是闭环质量：旧续轮文案只说"不再重复阻断"，没要求补申报——模型把拦截当成"等待就过"，台账从未补。结论：**拦截→放行不是闭环，拦截→补申报才是**。
- 次要发现：baseline 前移是发布侧慢变量，0.2.9 之后断档，是这次 stale 拦截的土壤。0.2.10 发布提交同时前移 baseline（本批落地）。

## 修复（本批落地）

1. hook 续轮放行文案：点名 violations.jsonl、说明"这不是通过"、给出补申报动作（`src/commands/hook.mjs`；`test/delivery.test.mjs` 钉住文案）。
2. violations 的语义（"被拦一次后未改正而放行"）写进 `docs/BOUNDARIES.md`。
3. 本文档。

## 未修与理由

- violations.jsonl 不自动升级成任何惩罚：它是审计线索不是状态机（`src/delivery.mjs` 头注释），出现新记录时靠续轮文案与 reviewer 抽查；自动升级等数据积累再定（v2 数据驱动）。
