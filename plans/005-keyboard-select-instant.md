# 005 — 让键盘下拉保持即时

- **Status**: TODO
- **Commit**: 9e1f7c8
- **Severity**: HIGH
- **Category**: Purpose & Frequency
- **Estimated scope**: 3 files, small

## Problem

`packages/ui/src/app.tsx` 的 `AtmSelect` 不区分输入模态；鼠标点击和 ArrowDown/ArrowUp 都调用
同一个 `openAt()`。因此键盘发起的高频筛选也总会播放 160ms opacity + translate/scale 入场。

```tsx
// packages/ui/src/app.tsx — current
onClick={() => (open ? closeAndFocusTrigger() : openAt(selectedIndex))}
onKeyDown={(event) => {
  if (event.key === "ArrowDown") openAt(selectedIndex);
  else if (event.key === "ArrowUp") openAt(selectedIndex);
}}
```

## Target

- `openAt(index, modality)` 显式接收 `"pointer" | "keyboard"`。
- root 用 `data-open-input="pointer|keyboard"` 暴露当前打开方式。
- pointer 打开继续使用 160ms `var(--atm-ease-out)`；keyboard 打开时 popover 与 caret 立即到最终态，
  `transition: none`，焦点仍落在正确 option。
- 关闭、选择、外部点击、Escape、Arrow 键导航与 ARIA 语义保持不变。

## Repo conventions to follow

- 命令面板已有 `transition: none`，证明高频键盘入口保持即时是现有约定。
- pointer select 入场继续沿用 `scale(0.98)`、±4px 与
  `var(--atm-duration-hover) var(--atm-ease-out)`。

## Steps

1. 先在 `apps/desktop/e2e/desktop.spec.ts` 添加 RED：鼠标打开时 computed transition duration 非零；
   键盘 ArrowDown 打开时 popover 与 caret 的 transition duration 为 0s，option 焦点正确。
2. 在 `AtmSelect` 保存最近一次 open modality，调用点分别传 pointer/keyboard，并输出 data attribute。
3. 在 `packages/ui/src/styles.css` 点名 keyboard-open 的 popover 与 caret 禁用 transition。
4. 验证 Escape/选择后焦点恢复，鼠标再次打开会恢复 pointer 动效。

## Boundaries

- 不移除鼠标入场动效。
- 不改 option 列表、筛选逻辑、快捷键或焦点环。
- 不添加全局输入模态侦测库。

## Verification

- **Mechanical**: `pnpm test:e2e -- --grep "键盘下拉保持即时"`；
  `pnpm --filter @ayanami-task/ui typecheck`。
- **Feel check**: 以 10% 动画速度分别点击和按 ArrowDown 打开同一筛选；鼠标路径有短空间提示，
  键盘路径立即出现且无闪跳。
- **Done when**: RED→GREEN，六个工具栏下拉均复用同一组件并同时获得该行为。
