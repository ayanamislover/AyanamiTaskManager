# 008 — 补齐 tabs 与通知 radio 的 roving focus

- **Status**: TODO
- **Commit**: b85aeea
- **Severity**: HIGH
- **Category**: Accessibility
- **Estimated scope**: 3–5 files, medium

## Problem

项目视图声明了 `tablist`，子按钮却没有 `role="tab"`、`aria-controls`、panel 关联或 roving tabindex（`packages/ui/src/app.tsx:4527`）：

```tsx
<div className="atm-tabs" role="tablist">
  <button aria-selected={view === "list"} onClick={() => setView("list")}>
```

通知档位的 `radiogroup`/`radio` 只支持点击，三个按钮全部进入 Tab 序列，也不处理 Arrow/Home/End（`packages/ui/src/app.tsx:2373`）：

```tsx
<button type="button" role="radio" aria-checked={selected} onClick={() => setNotificationMode(value)}>
```

## Target

两个复合控件都采用 roving tabindex：当前选中项 `tabIndex=0`，其余 `-1`。tabs 使用 `role="tab"`、稳定 id/`aria-controls` 和对应 `role="tabpanel"`/`aria-labelledby`；Left/Right、Home/End 移动焦点并激活视图。radio 使用 Left/Right/Up/Down、Home/End 移动并选择通知档位。按键更新必须即时，不添加内容切换动画。

## Repo conventions to follow

- 保留现有 `.atm-tabs`、`.atm-notification-options`、`.atm-notification-option` DOM 层级、颜色、尺寸和 motion token。
- 复用 `useId()` 生成稳定的当前实例 id；不要使用数组索引作为跨渲染 id。

## Steps

1. 页面拆分后，为项目 view tabs 添加可复用的 roving-key handler、tab/panel id 与 ARIA 关系。
2. 为通知 radio 添加同样有界且可循环的 roving handler；点击行为和三种值 `ALL|CRITICAL|OFF` 保持不变。
3. 不在通用按钮上关闭 focus ring；确认每个字段仍只有当前选项自身画一圈。
4. 增加 Playwright，覆盖鼠标、Tab、四方向键、Home/End、选中状态和焦点位置；给错误 roving index 加阳性红灯。

## Boundaries

- 不改变五个视图内容、通知持久化/API 或选中样式。
- 不增加 tab 内容 transition、高度动画或 radio 滑块动画。
- 不添加依赖；路径若因 T0249/T0250 变化，先按组件名定位。

## Verification

- **Mechanical**: `pnpm --filter @ayanami-task/ui typecheck`; `pnpm test:e2e -- --grep "roving focus"`；相关 design guard 单 worker 运行。
- **Feel check**: 一个 Tab 键只进入当前项；方向键在组内移动且不滚动页面，Home/End 到边界；焦点环与相邻自绘字段一致，reduced-motion 不改变键盘响应。
- **Done when**: tabs/radio 都通过 APG 键盘模式和 ARIA 关系断言，原点击路径无回归。
