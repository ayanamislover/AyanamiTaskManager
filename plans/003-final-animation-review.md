# 最终动效严格复核

> 2026-08-27 final：1.0.16 终审发现的三处遗漏已由 004–006 收口并重新实测；
> 本结论绑定 `db562e1`、`e19f227` 及下列证据。最终 1.0.17 安装包仍须通过发布总门禁。

## Before / After / Why

| Area                | Before                                                   | After                                                                                                              | Why                                      |
| ------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Window chrome       | 整个 topbar 是 draggable，三键叠在其上且样式像原生拼接块 | 只有 breadcrumb 可拖；控制层及后代显式 no-drag/pointer；独立 surface capsule，120–160ms color/press                | 先保证真实命中，再给清晰、克制的物理反馈 |
| Scrollbar           | document rail 紧贴 frameless resize edge                 | `.atm-main` 内部滚动，距边缘 7px；ATM token thumb、hover/active 轨道                                               | 避免 resize hit-test 抢占，视觉融入应用  |
| Task drawer         | 瞬时出现、无 backdrop，却声明 aria-modal                 | 全视口 backdrop、背景滚动锁、右侧 220ms ease-drawer 入场                                                           | 来源/去向与右侧工作区一致，层级可理解    |
| Ordinary modal      | 表单弹层瞬时挂载                                         | backdrop opacity + modal opacity/scale(.96→1)，220ms ease-out                                                      | 偶发层级变化需要短暂空间说明             |
| Command palette     | 即时打开                                                 | 明确排除 modal transition                                                                                          | 高频键盘入口不能被动效拖慢               |
| Notice              | 右下角瞬时出现                                           | 220ms opacity + 16px bottom-origin translate                                                                       | 让保存/复制反馈可察觉，但不打断阅读      |
| Skeleton            | background-position + ease-in-out 持续 repaint           | 伪元素 transform、1.35s linear、no-preference gate                                                                 | 常速循环更自然，并只触发合成             |
| Focus / preferences | 半透明低对比 focus；reduce 时全局 0.01ms                 | 不透明 focus token；reduce 仅去位移/缩放/shimmer，保留 160ms opacity/color；transparency/forced-colors 有 fallback | 保留状态可理解性和平台可访问性           |
| Theme switch        | 部分表面插值、部分瞬切                                   | 切换时临时禁用 transition，双 frame 后恢复                                                                         | 主题成为原子状态变化，避免视觉撕裂       |

## 阻断项扫描

- 无 `transition: all` 或 `transition-property: all`。
- 无纯 `ease-in`、`scale(0)`、弹跳/旋转或一次性交互超过 300ms。
- 无 height/width/top/left/margin/padding 布局动画。
- 位移/缩放均有 `prefers-reduced-motion` 降级；hover 位移仅细指针启用。
- Ctrl/Cmd+K、主导航、列表和空状态保持即时，无装饰性 stagger。
- 1.0.16 packaged Electron 基线已用真实鼠标坐标验证三键、scrollbar 轨道与 thumb；关闭后 daemon
  健康并可恢复窗口。004–006 的源码候选另经完整 Playwright 14/14 复核，最终 1.0.17 会再跑安装版门禁。

## Final evidence

- `pnpm test:e2e`：14/14；含鼠标/ArrowDown/Enter 自绘下拉双路径、reduced motion、暗黑主题、
  Agent 聚合、时间线、工程统计和 1366/1920/3440 密度。
- `design-system-guards.test.ts` + `notice-lifecycle.test.ts`：7/7；关键 mutation 均先验红。
- 严格扫描：`transition: all`、裸 `ease-in`、`scale(0)`、布局属性 transition、生产 `<select>` 均 0 命中。
- 目视截图：`e2e-project-1920.png`、`e2e-theme-dark.png`、`e2e-custom-select-dark.png`。

## Verdict

**PASS（source candidate）**。reduced-motion 漏项、键盘打开下拉入场与 Notice 计时器竞争均已
按 004–006 修复并通过真实浏览器复核。抽屉/Notice 立即安全关闭、不引入 exit presence 是 002
中已记录的有意复杂度取舍；工程统计继续默认折叠且不为内容区增加动画，避免重新引入卡顿。
