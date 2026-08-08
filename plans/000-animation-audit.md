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
