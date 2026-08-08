# 绫波任务管理器

AyanamiTaskManager 是面向本地 Agent 工作流的 Windows 项目进度控制台。它使用一个全局 Registry 与每项目独立 SQLite，桌面 UI、11 个紧凑 MCP 工具、CLI 和本地 HTTP 共享同一套应用服务。

核心能力包括目标/里程碑/任务管理、Session 与 claim 协作、项目记录和交接、中文搜索、实时事件、在线备份恢复、导入导出、保存视图、工程统计以及托盘通知。默认只监听本机回环地址，并以本地令牌鉴权。

## 开发

```powershell
pnpm install
pnpm test
pnpm typecheck
pnpm dev
```

开发态 Web 界面固定监听 `http://127.0.0.1:9999`；daemon API 仍使用独立的本机运行时端口。

正式数据默认位于 `%LOCALAPPDATA%\AyanamiTaskManager`。开发和测试可通过 `AYANAMI_TASK_DATA_DIR` 指向隔离目录。

## 命令

```powershell
pnpm atm -- status
pnpm atm -- project list
pnpm atm -- doctor
```

完整用户说明见 `docs/user-guide.md`，Agent 接入见 `docs/agent-integration.md`，架构与数据边界见 `docs/architecture.md` 和 `docs/data-model.md`。

## 验收与发布

```powershell
pnpm test:e2e
pnpm benchmark
pnpm release
```

`pnpm release` 会运行完整门禁，生成并验证 Squirrel 安装版和 portable ZIP，随后写入 `release/`。最终结论、原始日志、benchmark、三种 smoke 和宽屏截图位于 `release/test-report/`；发布步骤见 `docs/release-checklist.md`。
