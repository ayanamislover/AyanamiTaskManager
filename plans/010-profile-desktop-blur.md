# 010 — 实测 sticky 与 frameless blur 再决定降级

- **Status**: TODO
- **Commit**: b85aeea
- **Severity**: MEDIUM
- **Category**: Performance
- **Estimated scope**: measurement first; at most 3 files if evidence is red

## Problem

高频滚动内容上方的 sticky topbar 和固定窗口控件使用 blur，静态代码提示可能在集成显卡/高分屏上增加合成成本，但目前没有运行时红灯。当前位置：

```css
/* packages/ui/src/styles.css:190 — current */
.atm-topbar {
  background: color-mix(in srgb, var(--atm-bg) 88%, transparent);
  backdrop-filter: blur(14px);
}

/* apps/desktop/src/window-chrome.css:94 — current */
.atm-window-chrome {
  backdrop-filter: blur(16px) saturate(1.08);
}
```

项目已有 `prefers-reduced-transparency` 与 forced-colors fallback，所以不能凭代码存在 blur 就删除材质。

## Target

先在 packaged Electron 的 1366、1920、3440 三种视口，以长任务列表连续滚动 10 秒，记录 frame time、dropped frames、GPU/compositor activity 与设备信息。只有 blur-on 相比同候选 blur-off 的 p95 frame time 增幅超过 20% 或出现连续可见掉帧，才实施降级：topbar 改为不透明 `var(--atm-bg)`，window chrome 改为 `var(--atm-surface)`，并保持边框/阴影；否则关闭本计划为“测量通过，无源码改动”。

## Repo conventions to follow

- 必须从同一 commit 的 packaged candidate 对比，数据脚本只保存浅层数字/字符串 DTO。
- 现有 `prefers-reduced-transparency: reduce` 与 `forced-colors: active` 规则是正确先例，不得删除。

## Steps

1. 建立固定数据量与滚动脚本，分别采集 blur-on/off；不要把 Electron/Process 对象直接送入 JSON。
2. 保存原始数字、聚合方法、视口/缩放/设备和候选 hash；计算 p50/p95/dropped frames。
3. 仅在阈值红灯时改上述两个 selector，并加设计守卫与 light/dark 截图；若通过，写明无代码变更。
4. reduced-transparency 和 forced-colors 各实测一次，确认 fallback 仍生效。

## Boundaries

- 不使用 WMI/CIM，不序列化复杂 .NET 对象，不以进程存活代替 UI 性能证据。
- 不改变背景颜色、边框、阴影或尺寸，除非阈值要求关闭 blur。
- 不添加动画或依赖；不得只凭 Lighthouse/静态扫描作结论。

## Verification

- **Mechanical**: packaged candidate hash 与测量报告一致；浅层报告 schema test；若改 CSS，运行 desktop design guard、UI/desktop typecheck 与单 worker E2E。
- **Feel check**: 10%/100% 缩放观察 sticky topbar 与三键胶囊，滚动时无闪烁、拖影或材质断层；reduced-transparency 立即成为不透明表面。
- **Done when**: 三视口同候选 A/B 证据完成，并按明确阈值作出“保留”或“降级”决定。
