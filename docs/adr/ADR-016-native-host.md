# ADR-016：原生宿主 + 系统 WebView2 替代 Electron

状态：Accepted（取代 [ADR-003](./ADR-003-electron-hosted-service.md) 与 [ADR-011](./ADR-011-forge-release.md)）

1.x 的安装体积约 450 MB，其中 Electron 可执行文件 225 MB、`app.asar` 86 MB；常驻内存里 Chromium 的浏览器进程与 GPU 进程占大头，而 ATM 只需要一扇窗、一个托盘和一个本机服务。外壳因此换成自写的原生宿主，界面交给系统已有的 WebView2，业务核心不重写。

## 决定

- **宿主**（Rust，`apps/desktop/native/host`）：单实例、窗口、托盘、登录自启动、通知、更新桥与安装状态准入。只做壳，不含业务逻辑；Renderer 的 `window.ayanamiDesktop` 与 1.x Preload 暴露的方法同名同形，界面代码不需要改。
- **core**：原 Electron Main 里的 TS 服务（Fastify、数据库管理器、Agent 接入、诊断）由 esbuild 打成单文件，跑在随包的 Node（`runtime\atm-core.exe`）上，由宿主拉起和看护。领域与应用服务一行不动，`better-sqlite3` 保留，只带运行时部分与 win32-x64 预编译。
- **安装器**（`atm-setup.exe`）：事务式安装、更新、修复与卸载，取代 Squirrel；每一步写日志、可回滚，从 1.x 迁移时可回到 Electron 版。安装根的启动器在事务未完成时挡住启动。
- **发布产物**：`atm-setup.exe`、更新包 `atm-<v>-win-x64.zip` 与其清单 `.json`、portable ZIP；打包时按内容策略与构建机路径扫描校验（见 [open-source-preflight.md](../open-source-preflight.md)）。
- **MCP**：原生 shim `resources\atm-mcp.exe` 是默认桥；它缺失时回落到宿主自己的 `--mcp-stdio`。

不保留浏览器访问：生产宿主不开调试端口，并清掉从环境变量注入的 WebView2 参数；只有 `smoke` feature 构建的测试宿主开 CDP，供打包烟测驱动真实界面。

## 结果

版本目录约 95 MB，更新包约 37 MB。凭证边界不变：用户凭证只在 core 内存里，宿主与 Renderer 都拿不到（见 [security-model.md](../security-model.md)）。

代价是多了一个需要自己维护的原生工作区（`apps/desktop/native`）和一台事务状态机，以及对系统 WebView2 版本的依赖——安装器预检最低版本，不满足就不动任何文件。

## 依赖理由

- `wry` / `tao`：Tauri 维护的 WebView2 封装与窗口事件循环，Windows 上直接对接 WebView2，不带浏览器内核。
- `tray-icon`：与 `tao` 同一维护方的托盘实现。
- `webview2-com` / `windows` / `windows-sys`：WebView2 frame 事件、Toast 通知与 Win32 调用；版本与 `wry` 锁在一起，不引入第二份。
- `zip` / `sha2`：安装器解包更新包并逐文件校验清单哈希。
- `serde` / `serde_json`：安装状态、日志与清单的读写。
