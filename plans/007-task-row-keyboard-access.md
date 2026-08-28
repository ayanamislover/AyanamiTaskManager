# 007 — 给任务表格提供真实键盘入口

- **Status**: TODO
- **Commit**: b85aeea
- **Severity**: HIGH
- **Category**: Accessibility
- **Estimated scope**: 3–5 files, small

## Problem

跨项目任务表和项目任务表都只在 `<tr>` 上监听点击；鼠标能打开任务，Tab、Enter 和 Space 无法到达同一动作。当前位置是 `packages/ui/src/app.tsx:1411` 与 `packages/ui/src/app.tsx:4199`：

```tsx
<tr key={task.key} onClick={() => onTask(task.project, task.key)}>
```

```tsx
<tr key={task.id} onClick={() => openTask(task.key)}>
```

## Target

保留表格语义和整行鼠标命中；在首列任务标题内放置语义化 `button`，复用同一 open handler。按钮必须可 Tab 到达、Enter/Space 原生激活、有只画一次的 `:focus-visible` 环，并用任务标题和 key 提供可访问名称。不要给 `<tr>` 强行加 `role="button"`。

## Repo conventions to follow

- 复用 `--atm-focus` / `--atm-ring-primary`；谁画可见焦点，谁负责移除内层重复 `box-shadow`。
- 视觉上继续沿用 `.atm-row-title` 与 `.atm-key`，不能把表格改成卡片或改变列宽。

## Steps

1. 页面拆分完成后，在跨项目任务和项目任务两个 feature 内抽一个轻量 `TaskRowOpenButton` 或等价原语；按钮只负责 open action 和可访问名称。
2. 保留 `<tr onClick>` 的鼠标路径；按钮点击必须避免同一 action 因冒泡执行两次。
3. 在拆分后的 primitives/table 样式中加入与现有表格一致的无背景按钮和单一 focus ring。
4. 增加 Playwright：Tab 到两个入口，Enter/Space 分别打开正确 drawer，Escape 后焦点回到触发按钮；鼠标整行点击仍有效。

## Boundaries

- 不改变任务查询、排序、筛选、drawer 生命周期或表格列。
- 不给行添加 hover 位移或入场动画。
- 不添加依赖；若 T0249/T0250 后路径变化，先重新定位这两个表格再编辑。

## Verification

- **Mechanical**: `pnpm --filter @ayanami-task/ui typecheck`; `pnpm exec vitest run apps/desktop/test/design-system-guards.test.ts --maxWorkers=1 --no-file-parallelism`; `pnpm test:e2e -- --grep "任务表格键盘入口"`。
- **Feel check**: 只用键盘进入两个表格；焦点只出现一圈且不改变行高，Enter/Space 打开正确任务，Escape 回到原触发点。reduced-motion 下行为相同。
- **Done when**: 两处鼠标与键盘路径都由真实测试覆盖，表格语义和视觉密度不变。
