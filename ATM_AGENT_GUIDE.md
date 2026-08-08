# ATM Agent 快速入门

## ATM 是什么

AyanamiTaskManager（ATM）是本机 Agent 项目的任务控制面：统一保存目标、任务、Session、进度、证据、阻塞和交接。它不是聊天记录或日志仓库；只在工作状态有实际变化时写入。

## ATM 服务如何发现

正式数据默认位于 `%LOCALAPPDATA%\AyanamiTaskManager`；显式设置 `ATM_DATA_DIR` 时以该目录为准。读取 `<数据目录>\runtime\daemon.json` 获得 `endpoint`，并读取同目录 `local.token` 鉴权。服务只监听 `127.0.0.1`；不要猜端口，也不要把 token 写入仓库、日志、对话或 ATM 记录。`output/` 下的数据只用于测试。

## ATM 未运行怎么办

已安装环境直接启动 AyanamiTaskManager 桌面应用；窗口关闭到托盘后服务仍运行。源码环境在 `R:\Project_All\AyanamiTaskManager` 执行 `pnpm dev`。随后用 `pnpm atm status` 或 `pnpm atm doctor` 验证。若 runtime 指向已退出进程，先“完全退出”旧应用再重新启动，不要复用过期 endpoint/token。

## Codex 怎么接入

在 ATM 的“设置 → Agent 接入”选择“安装 Codex 配置”，ATM 会备份并最小合并 `%USERPROFILE%\.codex\config.toml`。配置变化后让 Codex 重新加载 MCP。项目规则应包含：

> 执行项目前先访问 ATM 工具，并阅读 R:\Project_All\AyanamiTaskManager\ATM_AGENT_GUIDE.md；后续所有任务执行均依赖 ATM。

## Claude 怎么接入

在“设置 → Agent 接入”选择“安装 Claude 配置”，ATM 会备份并最小合并 `%APPDATA%\Claude\claude_desktop_config.json`，然后重启 Claude Desktop。打包版 stdio 使用 `resources/mcp-stdio.cjs`；不要把 Windows GUI EXE 直接当作 stdio 命令。

## atm\_\* 工具地图

| 目的                             | 工具                                               |
| -------------------------------- | -------------------------------------------------- |
| 开始、恢复、结束 Session         | `atm_begin`、`atm_brief`、`atm_end`                |
| 查找与创建任务                   | `atm_task_list`、`atm_task_get`、`atm_task_create` |
| 领取、启动、阻塞、验证、完成任务 | `atm_task_patch`                                   |
| 写阶段进度与关键证据             | `atm_progress_add`、`atm_record`                   |
| 搜索历史与增量同步               | `atm_search`、`atm_delta`                          |

所有写操作使用唯一 `op_id`；重试同一写请求时复用原 `op_id`。任务变更携带最新 `expected_version`，发生版本冲突后先重新读取。进度摘要上限 500 字，应一次写清结果、证据和下一步，不贴原始日志。

## 最短工作流

1. `atm_begin(project_code, agent_id, role)`，每个 Session 只调用一次。
2. `atm_brief` → `atm_task_list(ready_only=true)`。
3. `atm_task_patch(claim)` → `atm_task_patch(start)`；并行 Agent 各领不同任务。
4. 完成一个有意义阶段后写 `atm_progress_add`；事实、决策、风险写 `atm_record`。
5. 验收后 `atm_task_patch(verify)` → `atm_task_patch(complete)`。
6. 无论成功、暂停或阻塞，最后都调用 `atm_end`；计划换代使用 `retired` 和 predecessor/handoff。

## 完整文档在哪

- Agent 协议与协作细节：`docs/agent-integration.md`
- 用户操作：`docs/user-guide.md`
- 故障排查：`docs/troubleshooting.md`
- 架构与数据边界：`docs/architecture.md`、`docs/data-model.md`
- 发布验收：`docs/release-checklist.md`
