# UI 动效机会审计

## 结论

AyanamiTaskManager 已接近适合专业控制台的克制程度。保留即时的主导航和 Ctrl/Cmd+K 命令面板；只为偶发、需要空间解释的界面增加短动效。窗口三键和滚动条属于交互缺陷，优先级高于装饰性 polish。

## 通过 Gate 的机会

| 优先级 | 位置与触发                                             | 当前问题                                               | Motion recipe                                                                      | Reduce 模式          |
| ------ | ------------------------------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------------- | -------------------- |
| P0     | `apps/desktop/src/window-chrome.css`：窗口三键         | 控件叠在整块 draggable topbar 上；真实用户反馈无法点击 | 拖拽区、控制区明确分离；按钮只做 120–160ms color/background 与 `scale(.97)` press  | 不做位移，仅保留颜色 |
| P0     | `packages/ui/src/styles.css`：右侧页面滚动             | document scrollbar 紧贴 frameless resize edge          | 改为 inset 的内部 `.atm-main` 滚动容器，定制 thumb/track；不对滚动本身加动画       | 相同                 |
| P1     | `app.tsx:1596,3693` / `styles.css:857`：任务详情       | 模态抽屉瞬时出现且缺少遮罩，空间来源不明               | backdrop opacity 180ms；drawer 从右侧进入 220–280ms，`--atm-ease-drawer`；背景锁定 | 仅 opacity 160ms     |
| P1     | `app.tsx:674,1943,2062` / `styles.css:774`：普通 modal | 瞬时挂载，层级跳变                                     | backdrop opacity 180ms；modal opacity + scale(.96→1) 220ms；命令面板排除           | 仅 opacity 160ms     |
| P1     | `app.tsx:1372,1587,3521,3702` / `styles.css:919`：通知 | 两处来源重叠且瞬时挂载                                 | 统一外观；bottom-origin opacity/translate 180–240ms，可中断                        | 仅 opacity 160ms     |
| P2     | `styles.css:396-415`：skeleton                         | `background-position` 持续重绘且使用 ease-in-out       | 伪元素 transform 扫过，1.35s linear；只在 no-preference 运行                       | 静态骨架             |
| P2     | 全局 hover/press                                       | 原始 duration/ease 分散，触摸端 hover 未门控           | 集中 duration/easing token；hover 仅 `(hover:hover) and (pointer:fine)`            | 去掉 transform       |

共享 token：

- `--atm-duration-press: 120ms`
- `--atm-duration-hover: 160ms`
- `--atm-duration-surface: 220ms`
- `--atm-ease-out: cubic-bezier(0.23, 1, 0.32, 1)`
- `--atm-ease-in-out: cubic-bezier(0.77, 0, 0.175, 1)`
- `--atm-ease-drawer: cubic-bezier(0.32, 0.72, 0, 1)`

## 可访问性与性能阻断项

- `styles.css:33` 的半透明 focus ring 对比度不足；改用不透明 primary strong，并为 forced-colors 提供系统色。
- `styles.css:1035` 不再把所有 transition/animation 归零；只移除位移、缩放和 shimmer，保留短 opacity/color 反馈。
- TaskDrawer 若继续声明 `aria-modal`，必须有全屏 backdrop、背景 pointer/wheel 阻断与滚动锁。
- topbar/window chrome 的 blur 在 reduced-transparency/forced-colors 下关闭。
- 全局快捷键必须避开 input/textarea/select/contenteditable 和已有 modal，防止叠层焦点争抢。

## 明确拒绝

- Ctrl/Cmd+K 命令面板：键盘高频入口，保持即时。
- 主导航与页面 route transition：每日高频且内容密集，运动会让界面显慢。
- 列表 stagger、空状态装饰、skeleton 完成后额外入场：没有足够功能价值。
- 大面积主题 tween：主题应原子切换，避免部分表面先后插值。
- 弹跳、旋转、品牌角色动画：与控制台任务无关。

## 验收基线

真实浏览器覆盖 light/dark/reduced-motion/forced-colors 可行项；packaged Electron 实测三键、拖动、双击最大化、四边 resize、滚动条点击和拖拽、关闭到托盘。严格复核禁止 `transition: all`、`ease-in`、`scale(0)`、布局属性动画以及无 reduced-motion 降级。

## 2026-08-28 HEAD 复核（`b85aeea`）

本轮按 Purpose/Frequency、Easing/Duration、Physicality、Interruptibility、Performance、Accessibility 与 Cohesion 重新扫描。静态扫描继续为：生产代码无 `transition: all`、裸 UI `ease-in`、`scale(0)` 或布局属性动画；自绘下拉的鼠标/键盘输入模态与 reduced-motion 降级仍在。

选入后续计划的四项是：两处任务表格缺少键盘入口（007）、tabs 与自绘 radio 缺少 roving focus（008）、多处异步错误未向辅助技术播报（009），以及 sticky topbar/frameless chrome 的 blur 需要真实滚动性能测量（010）。前三项直接影响可达性，第四项先测后改，不能凭静态猜测破坏既有材质。

再次拒绝以下候选：

- 主导航、设置入口与项目卡的 120–160ms color/press/hover 反馈：004 已明确统一其节奏与 reduced-motion 行为；它们不是 route/content transition，删除会重新推翻已验收的触控反馈。
- modal、drawer、select 与 Notice 的 exit presence：002/003 已明确选择“进入有空间提示、关闭立即安全卸载”，在没有可证明问题前不为退出延迟引入状态机。
- 把 hover/color 从共享 `--atm-ease-out` 改成裸 `ease`：会破坏现有 token vocabulary，且没有可观察缺陷。
- 工程统计/MCP 诊断内容区入场：用户要求这些重内容默认折叠以避免卡顿；不增加内容高度或 presence 动画。
- 设置预览、命令面板、筛选、排序、tab 内容和列表 stagger：前者收益低，其余均是高频功能数据，保持即时。
- drawer backdrop 的 `180ms`：这是 000/002 中原始 recipe 的有意值，不把“没有 token”本身当作用户可感知缺陷。
