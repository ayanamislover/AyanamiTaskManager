# ATM 设计与动效改进计划

本目录记录 2026-08-08 对 AyanamiTaskManager 的只读审计及后续实现批次。计划以信息密集型桌面工具为前提：动效必须解释状态或空间关系，不能让高频导航显慢。

执行顺序：

1. [000-animation-audit.md](./000-animation-audit.md) — 已完成的机会审计、拒绝项与验收基线。
2. [001-window-brand-data.md](./001-window-brand-data.md) — 先修窗口交互、滚动、品牌、自启动、数据目录与 Agent 指南。
3. [002-motion-polish.md](./002-motion-polish.md) — 再实施克制动效，并按严格标准复核。
4. [003-final-animation-review.md](./003-final-animation-review.md) — 最终 Before/After/Why 与阻断项结论。

每批完成后必须通过定向测试、全仓静态检查、真实浏览器与 packaged Electron 验收；最终产物才允许推送 GitHub。
