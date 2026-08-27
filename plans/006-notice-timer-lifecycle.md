# 006 — 修正 Notice 计时器生命周期

- **Status**: DONE
- **Commit**: db562e1
- **Severity**: MEDIUM
- **Category**: Interruptibility & Timing
- **Estimated scope**: 2 files, small

## Problem

`packages/ui/src/app.tsx` 每次 `notify()` 都创建新的 2800ms timeout，但不保存和取消旧 timer。
第二条 Notice 到来后，第一条的 timer 会提前清空新消息；组件卸载时 timer 也继续存活。

```tsx
// packages/ui/src/app.tsx — current
const notify = (message: string) => {
  setNotice(message);
  window.setTimeout(() => setNotice(""), 2800);
};
```

## Target

- 只保留一个 `useRef<number | null>` timer；新消息先 clear 旧 timer，再设置完整 2800ms 生命周期。
- App 卸载时清理 timer；timer 自己执行后把 ref 归零。
- 保留现有即时安全关闭与已确定的不引入 exit-presence 取舍；本计划不增加队列或退出延迟。

## Repo conventions to follow

- 不用 keyframes；Notice 现有 entry transition 和 reduced-motion 降级保持不变。
- cleanup 写入 React effect，不在 render 路径产生副作用。

## Steps

1. 先增加 RED 测试，使用 fake timers 连续发送两条通知：第一条原到期点不能清空第二条，第二条必须
   从自身发送时刻起完整保留 2800ms；unmount 后无遗留 timer。
2. 在 `App` 中加入 timer ref、取消旧 timer、回调归零和 effect cleanup。
3. 复跑现有通知/桌面 E2E，确认 role=status 与视觉入场不变。

## Boundaries

- 不增加 Notice 队列、退出 presence、依赖或新组件。
- 不改变 2800ms 时长、文案和位置。
- 不修改 drawer/modal 生命周期；002 已记录立即安全关闭是有意取舍。

## Verification

- **Mechanical**: focused fake-timer test；`pnpm --filter @ayanami-task/ui typecheck`；相关 E2E。
- **Feel check**: 1 秒内连续触发两次保存/复制反馈，第二条从自身出现起保持完整 2.8 秒，不被第一条
  timer 提前移除。
- **Done when**: RED→GREEN，timer cleanup 可观察且 Notice 现有样式无回归。

## Result

- fake-timer 测试 2/2：替换消息拥有完整 2800ms，旧 timer 被取消，owner cleanup 后无回调。
- 相关 Playwright、UI typecheck、ESLint、Prettier 与 diff-check 通过。
