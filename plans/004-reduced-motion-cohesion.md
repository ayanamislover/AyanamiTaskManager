# 004 — 补齐减少动态并统一动效节奏

- **Status**: TODO
- **Commit**: 9e1f7c8
- **Severity**: MEDIUM
- **Category**: Accessibility / Cohesion
- **Estimated scope**: 4 files, small

## Problem

`packages/ui/src/styles.css` 的 reduced-motion 只覆盖普通导航按钮、通用按钮、项目卡、
modal、drawer、notice 和 select，遗漏同样会缩放、位移或旋转的 disclosure、设置入口、
通知选项、工程统计箭头和排序箭头。`apps/desktop/src/window-chrome.css` 的窗口按钮按压为
`scale(0.94)`，也偏离应用通用的 `scale(0.97)`。

```css
/* packages/ui/src/styles.css — current */
.atm-nav button:active,
.atm-nav-disclosure:active,
.atm-sidebar-settings:active { transform: scale(0.97); }

@media (prefers-reduced-motion: reduce) {
  .atm-nav button:active,
  .atm-button:active { transform: none; }
}

/* apps/desktop/src/window-chrome.css — current */
.atm-window-button:active { transform: scale(0.94); }
```

另外 select 的 `160ms` 和部分常驻箭头旋转直接使用 `--atm-ease-out`，没有消费已经存在的
`--atm-duration-hover` / `--atm-ease-in-out`。

## Target

- reduced-motion 下，所有 press scale、caret/disclosure/sort rotation 或 translate 都变为
  `transform: none`；保留 `160ms` opacity/color/background/border 反馈。
- 窗口按钮统一为 `scale(0.97)`、`120ms var(--atm-ease-out)`。
- 常驻控件的旋转/形态变化使用 `var(--atm-ease-in-out)`；select 和 reduced-motion 不再硬编码
  `160ms`，统一使用 `var(--atm-duration-hover)`。
- 不添加 layout animation，不改变颜色、间距、DOM 或信息架构。

## Repo conventions to follow

- Token 位于 `packages/ui/src/tokens.css`：`--atm-duration-press: 120ms`、
  `--atm-duration-hover: 160ms`、`--atm-ease-in-out: cubic-bezier(0.77, 0, 0.175, 1)`。
- 普通按钮以 `packages/ui/src/styles.css` 的 `.atm-button:active { scale(0.97) }` 为准。
- reduced-motion 保留 opacity/color，移除位置变化，不使用全局 `transition: none`。

## Steps

1. 先在 `apps/desktop/test/design-system-guards.test.ts` 增加会对现状变红的静态守卫，逐个点名
   reduced-motion 必须覆盖的类、窗口按钮目标 scale 和禁止硬编码的 select duration。
2. 修改 `packages/ui/src/styles.css`，补齐 reduced-motion 选择器，并把常驻旋转换为
   `--atm-ease-in-out`、硬编码 160ms 换为 token。
3. 修改 `apps/desktop/src/window-chrome.css`，把窗口按钮按压统一为 `scale(0.97)`。
4. 逐条把一个遗漏重新写回，确认守卫会红，再恢复正确实现。

## Boundaries

- 不改 React 状态或 DOM。
- 不给工程统计、任务对账内容区增加高度动画。
- 不添加依赖，不动颜色、尺寸和业务行为。

## Verification

- **Mechanical**: `pnpm exec vitest run apps/desktop/test/design-system-guards.test.ts`；
  `pnpm --filter @ayanami-task/ui typecheck`；`pnpm --filter @ayanami-task/desktop typecheck`。
- **Feel check**: 开启 DevTools `prefers-reduced-motion: reduce`，逐个点击工作区、设置、通知档位、
  工程统计、排序和窗口三键；确认无位移/缩放/旋转，但颜色和焦点反馈仍在。
- **Done when**: 静态守卫验红有效，真实 reduced-motion 路径无遗漏，窗口按钮与通用按钮节奏一致。
