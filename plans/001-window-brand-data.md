# 窗口、品牌、数据与运行行为

## 目标

修复用户实际遇到的窗口控件与滚动问题，将根 `logo.png` 接入所有产品入口，让上轮 ATM 历史在正式桌面数据目录可见，并完善常驻托盘、随机延迟自启动与 Agent 必读说明。

## 实现切片

1. 窗口命中：把 topbar 默认改为 `no-drag`，只在明确的 breadcrumb/dead-space 上启用 drag；窗口控制层及全部后代强制 `no-drag`、pointer events，并留出内部 resize inset。
2. 滚动：桌面根布局锁定为视口高度，由 `.atm-main` 承担滚动；scrollbar 使用 ATM surface/border/primary token，thumb 有足够宽度和 hover/active 状态。
3. 品牌：Renderer 从根 `logo.png` 构建 URL并传入 UI；favicon、sidebar、BrowserWindow、tray、packager、Squirrel setup 全部来自同一图源派生资产。
4. 自启动：登录项参数改为 `--background --random-startup-delay`；纯函数生成有界随机延迟并有测试，第二实例前台启动可中断等待。关闭窗口只隐藏，托盘恢复或“完全退出”。
5. Agent 指南：根目录新增 `ATM_AGENT_GUIDE.md`；`AGENT_RULE_SNIPPET` 明确要求开工前访问 ATM 并阅读该文件。
6. 历史恢复：在源/目标两边创建 SQLite 在线备份和完整目录保留副本；关闭源 daemon 后，把完整 ATM 项目数据迁移到 `%LOCALAPPDATA%` 正式根，重写绝对 DB/backup path，保留目标 token，执行 quick_check 后再启动。

## 验收

- Playwright DOM click 和真实鼠标均能操作三键与 scrollbar。
- packaged Electron 证明 maximize/minimize/close-to-tray/restore，窗口关闭后 daemon 仍健康。
- EXE、installer、tray、favicon、sidebar 使用新 logo；ICO 含多分辨率。
- 正式数据目录显示 ATM 项目、上轮 DONE 任务和本轮记录，源目录与迁移前目标目录均可恢复。
- 自启动延迟边界/中断有单测，打包 smoke 不被随机延迟拖慢。
