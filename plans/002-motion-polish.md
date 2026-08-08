# Apple / Emil 风格的克制动效实施

## 目标

让界面在空间、材质、反馈和可访问性上更完整，但保持专业控制台的速度。所有动效只使用 transform/opacity 或短 color/background/border transition。

## 实现

1. 在 `tokens.css` 建立统一 duration/easing/focus/scrollbar token；保留现有紫色品牌交互色。
2. 普通 modal 使用 opacity + scale(.96) 的短入场；`.atm-command` 明确排除。
3. TaskDrawer 增加 backdrop、背景交互锁与右侧进入；若退出延迟卸载会显著增加复杂度，先确保可中断的 entry 与立即安全关闭，再以真实测试决定是否引入 presence state。
4. Notice 使用 bottom-origin 的短反馈；不做队列重排动画，除非先统一其状态生命周期。
5. Skeleton 改为 transform 驱动的伪元素 shimmer。
6. hover motion 仅细指针启用，press 使用轻微 scale；focus 使用高对比静态 ring。
7. reduced-motion 保留 opacity/color，移除位移/缩放/shimmer；reduced-transparency/forced-colors 使用不透明表面和系统色。
8. 主题切换原子化：切换瞬间禁用 transition，再在两个 animation frame 后恢复。

## 严格 Review

最终 diff 逐项检查目的、物理直觉、空间一致性、频率、时长、曲线、可中断性、键盘路径、性能属性及 reduced-motion。输出 Before/After/Why 表；发现阻断项必须修复并重测后才可发布。
