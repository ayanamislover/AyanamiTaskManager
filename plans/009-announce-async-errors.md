# 009 — 向辅助技术播报异步错误

- **Status**: TODO
- **Commit**: b85aeea
- **Severity**: MEDIUM
- **Category**: Accessibility
- **Estimated scope**: 4–7 feature files after extraction, small

## Problem

Agent 管理、设置和四个业务弹窗的 mutation 错误以普通 `<div>` 动态挂载，屏幕阅读器不会可靠播报。代表代码在 `packages/ui/src/app.tsx:2324`；同类还位于 2476、2654、3015、3185、3370、3608：

```tsx
{
  manageIntegration.error ? <div className="atm-inline-error">{message}</div> : null;
}
```

同文件 2121/2221 已有正确的 `role="alert"` 先例，当前实现不一致。

## Target

所有 mutation 异步失败使用一个共享 `InlineError` 原语，输出 `role="alert"` 与 `aria-live="assertive"`，保留 `.atm-inline-error` 外观。相同错误重复发生时仍需可被重新播报；不要用视觉动画来替代语义。

## Repo conventions to follow

- 复用现有错误文案归一化方式：`error instanceof Error ? error.message : String(error)`。
- 沿用既有 `atm-inline-error` 颜色、间距与 reduced-motion 行为，不另造 toast。

## Steps

1. 页面拆分后在 primitives 中建立 `InlineError`，支持 `unknown` error 和稳定的可访问语义。
2. 替换上述七处动态错误，并扫描全部生产 TSX，统一同根因的遗漏；保留已有正确 alert。
3. 增加组件/Playwright 断言：失败后 alert 出现、文本正确、重复失败可再次观察，成功后清除。
4. 加静态守卫或阳性 fixture，确保动态 `.atm-inline-error` 不会再缺少 alert 语义。

## Boundaries

- 不改变 mutation、重试、错误文案、Notice 队列或布局。
- 不增加 shake、flash、自动滚动或退出动画。
- 不添加依赖；路径漂移时按 mutation 名重新定位。

## Verification

- **Mechanical**: `pnpm --filter @ayanami-task/ui typecheck`; focused UI/desktop tests single worker; `pnpm test:e2e -- --grep "异步错误播报"`。
- **Feel check**: 使用辅助技术/Accessibility tree 触发两次同类失败，确认每次都有 alert 事件；视觉上不抖动、不改变表单尺寸策略，reduced-motion 无差异。
- **Done when**: 所有生产 mutation 错误共享一个语义原语，静态阳性对照能验红。
