# 绫波任务管理器

AyanamiTaskManager 是面向本地 Agent 工作流的 Windows 项目进度控制台。它使用一个全局 Registry 与每项目独立 SQLite，桌面 UI、11 个紧凑 MCP 工具、CLI 和本地 HTTP 共享同一套应用服务。

核心能力包括目标/里程碑/任务管理、Session 与 claim 协作、项目记录和交接、中文搜索、实时事件、在线备份恢复、导入导出、保存视图、工程统计以及托盘通知。默认只监听本机回环地址，正式桌面 daemon 每次启动都会轮换本地鉴权令牌；准确保护面与非目标见 [本地安全模型](./docs/security-model.md)。

## 开发

```powershell
pnpm install
pnpm test
pnpm typecheck
pnpm dev
```

开发态 Web 界面固定监听 `http://127.0.0.1:9999`；daemon API 仍使用独立的本机运行时端口。

正式数据默认位于 `%LOCALAPPDATA%\AyanamiTaskManager`。开发和测试可通过 `ATM_DATA_DIR` 指向隔离目录。

## 命令

```powershell
pnpm atm status
pnpm atm project list
pnpm atm doctor
```

安装版启动后会把 Guide 与完整文档同步到 `%LOCALAPPDATA%\AyanamiTaskManager\`。Agent 执行项目前先阅读 `%LOCALAPPDATA%\AyanamiTaskManager\ATM_AGENT_GUIDE.md`；源码仓库内保留同名文件作为发布源。

## 验收与发布

```powershell
pnpm test:e2e
pnpm benchmark
pnpm release
```

`pnpm release` 会运行完整门禁，生成并验证 Squirrel 安装版和 portable ZIP，随后写入 `release/`。最终结论、原始日志、benchmark、三种 smoke 和宽屏截图位于 `release/test-report/`；发布步骤见 `docs/release-checklist.md`。
