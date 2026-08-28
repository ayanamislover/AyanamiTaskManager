# ATM 设计与动效改进计划

本目录记录 2026-08-08 对 AyanamiTaskManager 的只读审计及后续实现批次。计划以信息密集型桌面工具为前提：动效必须解释状态或空间关系，不能让高频导航显慢。

执行顺序：

1. [000-animation-audit.md](./000-animation-audit.md) — 已完成的机会审计、拒绝项与验收基线。
2. [001-window-brand-data.md](./001-window-brand-data.md) — 先修窗口交互、滚动、品牌、自启动、数据目录与 Agent 指南。
3. [002-motion-polish.md](./002-motion-polish.md) — 再实施克制动效，并按严格标准复核。
4. [003-final-animation-review.md](./003-final-animation-review.md) — 最终 Before/After/Why 与阻断项结论。
5. [004-reduced-motion-cohesion.md](./004-reduced-motion-cohesion.md) — 补齐减少动态、token 与窗口按压节奏。
6. [005-keyboard-select-instant.md](./005-keyboard-select-instant.md) — 键盘打开自绘下拉保持即时。
7. [006-notice-timer-lifecycle.md](./006-notice-timer-lifecycle.md) — 修正连续 Notice 的 timer 竞争与清理。
8. [007-task-row-keyboard-access.md](./007-task-row-keyboard-access.md) — 让两处任务表格拥有真实键盘入口。
9. [008-roving-selection-groups.md](./008-roving-selection-groups.md) — 补齐 tabs 与通知 radio 的 roving focus。
10. [009-announce-async-errors.md](./009-announce-async-errors.md) — 统一播报异步错误。
11. [010-profile-desktop-blur.md](./010-profile-desktop-blur.md) — 先实测 sticky/frameless blur，再决定是否降级。

| 计划    | 严重度 | 状态 | 依赖             |
| ------- | ------ | ---- | ---------------- |
| 000–002 | —      | DONE | —                |
| 003     | —      | PASS | 004–006 DONE     |
| 004     | MEDIUM | DONE | —                |
| 005     | HIGH   | DONE | —                |
| 006     | MEDIUM | DONE | —                |
| 007     | HIGH   | TODO | UI 页面拆分后    |
| 008     | HIGH   | TODO | UI 页面拆分后    |
| 009     | MEDIUM | TODO | UI 页面拆分后    |
| 010     | MEDIUM | TODO | 真实桌面性能测量 |

2026-08-28 在 `b85aeea` 上复核后，没有重新打开 004–006 已关闭的 motion 决策；新计划只处理可验证的键盘/播报缺口，以及一个必须先测量再决定的合成性能风险。007–009 应在页面模块化完成后按新路径执行，010 不允许凭静态代码直接删掉现有材质。

每批完成后必须通过定向测试、全仓静态检查、真实浏览器与 packaged Electron 验收；最终产物才允许推送 GitHub。
