# forklight

规格没写完时，AI 会输出它见过最多的做法，然后交一个看起来已经想清楚的成品。岔路口被走掉了，也没有任何地方记录"这里曾经有过岔路口"。

forklight 在交付前把门关上：AI 必须先写一份决策台账（哪些分叉、候选是什么、选了哪个、凭什么）；程序算改动的代价、回访声称的证据；校验不过，交付不出去。

它不教 AI 有品味。它让 AI 在没依据的时候不再伪装成有依据。

## 拦什么

| 声称 | 程序怎么核 |
| --- | --- |
| "业界都这么做" | 回访 ≥3 个独立域名；引文必须出现在页面可见正文，只出现在 `<script>` 里不算 |
| "改回来很容易" | 代价由程序从 fan-in、是否已发布、有无外部副作用算出；模型只能上调 |
| "截图证明没问题" | 截图必须晚于最后一次代码改动；报告里的未判项（`null`）不作数 |
| "参考了仓库里的做法" | 重读 `file:line`；本次新增/修改的行不算既有做法 |
| "我记得你否决过 X" | `log#n` 必须存在且内容对得上；行号错位直接报错 |
| "本任务没有分叉" | 门看不见。这是目前唯一已知的洞，只能用 `no_fork_reason` 做统计审计，不假装能拦 |

## 用法

```bash
node src/cli.mjs init              # 写台账模板 + AGENTS.md 指路段 + 记 baseline
node src/cli.mjs check             # 交付前校验；退出码 0 才放行
node src/cli.mjs web --url http://127.0.0.1:5173/   # 双视口截图 + 五项几何检查（需 playwright）
node src/cli.mjs record --key ui.spacing --what "别用覆盖式滚动条" --why "压住右对齐气泡"
node src/cli.mjs rules             # 现行规则 + 原始否决 + 来源
node src/cli.mjs invalidate <key>  # 作废一条规则；原始 log 一条不动
```

`check` 默认不联网。`precedent` / `web` 两档要真回访时加 `--allow-net`——这是外发查询，默认需要你同意。

`web` 依赖 Playwright（`peerDependencies` 里的可选项）。没装时 `web` 明确报错，不会伪绿。

### 接进 agent

`init` 会往目标仓库的 `AGENTS.md` 写一段带 marker 的指路（幂等、不动原有内容）。这是实测能让 agent 主动加载协议的接法：只靠 skill description，ZCode 0.17.1 连跑三次设计任务都没加载 forklight。

Stop 钩子（ZCode 的 `~/.zcode/cli/config.json`）：

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "Stop": [
        {
          "hooks": [
            { "type": "command", "command": "node \"<repo>/src/cli.mjs\" hook", "timeout": 30 }
          ]
        }
      ]
    }
  }
}
```

`hook` 从 stdin 读事件；退出码 2 = 拦住并续一轮，stderr 交给模型去修。没有台账的仓库静默放行；`stop_hook_active` 为真时不再重复阻断，否则会打成死循环。

## 基准：尚未测量

PRD 要求 20–30 个陷阱任务，才能对外引用"静默塌缩率"。现在 `bench/tasks/` 有 6 个来自真实翻车的任务；真实模型只跑过小样本（本地 Anthropic 兼容网关，`autoclaw-cn/zai_glm-5.3-flash`），够看方向，不够写文案。

假 agent 跑出的数字只用于机制自测，不是模型的行为分布。

**所以：发布文案里的对比数字，尚未测量。** 原始记录在 `docs/HANDOFF.md`，没有挑好的数字。

## 已知边界

- 非 git 目录：三个代价输入全取不到 → 一切判 high，工具近乎失明。
- 对比度在磨砂 / 渐变背景上覆盖率极低（真站 7/111）。没报红不代表合格，是判不了；要判得靠截图像素采样（v2）。
- SPA 壳页读不到正文：`m3.material.io` 200 + 62KB HTML，可见正文只剩 15 个字符。设计系统站普遍如此，`precedent` 这档现在够不着它们。
- 引文命中 ≠ 页面在推荐该做法。实测有两处命中的是例外条款；`url + quote` 留给 reviewer 抽查上下文，这是这一档唯一的人防线。
- 真实受保护页面的登录闭环尚未跑过（`--state` 注入 cookie / localStorage 已在本地页验证）。
- `newestTrackedMtime` 有 5000 文件上限，超限返回 `null`——大 monorepo 的 render 证据会全失效。

## 开发

```bash
node --test    # 250 项：纯逻辑 / 真 git 仓库 / 真 Chromium / CLI 闭环
```

真 Chromium 层在没装 Playwright 时整文件 skip，不伪绿。改代码前读 `AGENTS.md`：每条规则都标了由什么拦住，以及"改坏必须红"的变异验证要求。

## 许可

MIT，见 [LICENSE](LICENSE)。