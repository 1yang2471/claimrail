# claimrail

[English](README.md) | 中文

claim 是 AI 的声称：它验证过设计、看过截图、照着既有做法来的。rail 是它交付前必须过的那道栏。名字就是机制本身。

规格没写完时，AI 会输出它见过最多的做法，然后交一个看起来已经想清楚的成品。岔路口被走掉了，也没有任何地方记录"这里曾经有过岔路口"。

claimrail 在交付前把门关上：AI 必须先写一份决策台账（哪些分叉、候选是什么、选了哪个、凭什么）；程序算改动的代价、回访声称的证据；校验不过，交付不出去。

它不教 AI 有品味。它让 AI 在没依据的时候不再伪装成有依据。

## 拦什么

| 声称 | 程序怎么核 |
| --- | --- |
| "业界都这么做" | 回访 ≥3 个独立域名；引文必须出现在页面可见正文，只出现在 `<script>` 里不算 |
| "改回来很容易" | 代价由程序从 fan-in、是否已推到默认分支或打 tag、有无外部副作用算出；模型只能上调 |
| "截图证明没问题" | 截图必须晚于最后一次代码改动；报告里的未判项（`null`）不作数 |
| "参考了仓库里的做法" | 重读 `file:line`；本次新增/修改的行不算既有做法 |
| "我记得你否决过 X" | `log#n` 必须存在且内容对得上；行号错位直接报错 |
| "本任务没有分叉" | 门不拦——这是唯一已知的洞。程序会记下 `no_fork_reason`；当 `forks: []` 而本次 diff 落在该类文件面上时，`check` 打印审计项、`check --json` 给出 `emptyDeclaration`（改动文件与总数）。它判不了"有没有分叉"，只让逃逸可统计 |

## 用法

安装后用 `claimrail` 命令；仓库内开发用 `node src/cli.mjs`：

```bash
claimrail init              # 写台账模板 + AGENTS.md 指路段 + 记 baseline
claimrail check             # 交付前校验；退出码 0 才放行（CI / npx 同理）
claimrail web --url http://127.0.0.1:5173/   # 双视口截图 + 五项几何检查（需 playwright）
claimrail record --key ui.spacing --what "别用覆盖式滚动条" --why "压住右对齐气泡"
claimrail rules             # 现行规则 + 原始否决 + 来源
claimrail invalidate <key>  # 作废一条规则；原始 log 一条不动
```

`check --json` 把同一份判定以结构化 JSON 交出去（给宿主和脚本用）——文本只是这份结论的视图，不是第二次计算。

`check` 默认不联网。`precedent` / `web` 两档要真回访时加 `--allow-net`——这是外发查询，默认需要你同意。

`web` 依赖 Playwright（`peerDependencies` 里的可选项）。没装时 `web` 明确报错，不会伪绿。

### 接进 agent

分两步：**指路**（必做，`init` 自动写）和**装技能**（可选，让 agent 能主动加载协议）。

**指路**：`init` 会往目标仓库的 `AGENTS.md` 写一段带 marker 的指路（幂等、不动原有内容），指向 `node_modules/claimrail/skill/SKILL.md`。这是实测能让 agent 主动加载协议的接法：只靠 skill description，ZCode 0.17.1 连跑三次设计任务都没加载 claimrail。

**装技能**（可选）：`npm install` 只把技能放在包里，**不会**注册到宿主的 skills 目录。要让 agent 能按需加载，把它链到宿主扫描的目录（以 ZCode / CodeBuddy / Trae 共用的 `~/.agents/skills` 为例）：

```bash
# Linux / macOS
ln -s "$(pwd)/node_modules/claimrail/skill" ~/.agents/skills/claimrail
# Windows（管理员或开发者模式）
mklink /D "%USERPROFILE%\.agents\skills\claimrail" "%CD%\node_modules\claimrail\skill"
```

不装也能用：`AGENTS.md` 里给的是文件路径，agent 直接读那个文件即可，只是不会在你没提到时主动加载。

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

- 非 git 目录：三个代价输入全取不到 → 一切判 high。这现在是**显式的降级模式**，不再是静默失明：报告开头就写明，并点名丢掉的是哪一条（repo 档仍读得了文件与行，但"这行是不是你刚写的"没有 git 就答不了）。git 本身用不了（坏 GIT_DIR、safe.directory）与"这里不是仓库"分成两种话——前者该修环境，后者该 git init。
- 对比度在磨砂 / 渐变背景上一度判不了（真站 111 处文本只覆盖 7 处）。现在改成读截图像素（v2）；但采样点跨在渐变上、或全落在字形上的文本，仍报"未判"而不是"合格"。
- 压在花哨图片背景上的文字报"未判"，不报"合格"。10px 棋盘背景曾被当成其中一格的颜色（报 6.80 合格，而同一处文字压在白格上只有 1.67）；现在采样点之间差得太远就整处不判。
- 现代色值写法一度整类漏判：`iana.org/help/example-domains` 一页 49 处文本里有 40 处文字色写的是 `oklch()`，报告原话却是"采不到实色背景"——把矛头指向背景，而真正读不出来的是前景。现在色值改由浏览器本人换算（在 canvas 上画一个像素再读回来），`oklch()`、`lab()`、`color()`、`color-mix()` 都能判：同一个页面从判 9 处变成判满 49 处，抓出 31 处真实缺陷，最低 2.45:1。浏览器自己也认不出的值仍然报"未判"。
- SPA 壳页读不到正文：`m3.material.io` 200 + 62KB HTML，可见正文只剩 15 个字符。设计系统站普遍如此，`precedent` 这档现在够不着它们。
- 引文命中 ≠ 页面在推荐该做法。实测有两处命中的是例外条款；`url + quote` 留给 reviewer 抽查上下文，这是这一档唯一的人防线。
- 登录闭环已在本地真实的登录门站上验证（匿名被踢到 `/login`；带 `--state` 才拿到受保护内容）。第三方真实产品页未跑——那需要你的凭据。
- `newestTrackedMtime` 要对每个跟踪文件取 mtime。上限 200000，真实项目够不着（6000 文件实测 148ms）；超过才返回 `null`，render 证据报未判而不是猜。

## 开发

```bash
node --test    # 335 项：纯逻辑 / 真 git 仓库 / 真 Chromium / CLI 闭环
```

真 Chromium 层在没装 Playwright 时整文件 skip，不伪绿。改代码前读 `AGENTS.md`：每条规则都标了由什么拦住，以及"改坏必须红"的变异验证要求。

## 许可

MIT，见 [LICENSE](LICENSE)。