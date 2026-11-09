# 调研记录：craft-anything（2026-11-08）

读了 [storytold/craft-anything](https://github.com/storytold/craft-anything) 的公开材料（README raw 与 arsentev.ai 摘要可核实；madrobot.blog 两次超时，未采用），挑出三条能落地的做法，其余（Rust 逆向引擎、320 工具、Ghidra）判断为生态不同、不跟：

1. **落盘链**：报告写 `shot_sha256`，回验时重算截图哈希——以前只靠文件名 + mtime，换图或换同名报告都能过。
2. **limitations**：报告带"这一轮没覆盖到哪里"（四类截断、未判底色、采样压字、焦点没探），`web` 把它打到屏幕上。
3. **结构化判定**：`check` 返回 `data`（schema=1），`--json` 输出它；文本是同一份决策的视图，不各算一遍。

三处都是落盘/结构化层，没有改判定语义。测试 310 → 318；七条变异全部"改坏→红、还原→绿"。

