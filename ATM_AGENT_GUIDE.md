# ATM Agent 快速入门

## ATM 是什么

AyanamiTaskManager（ATM）是本机 Agent 项目的任务控制面：统一保存目标、任务、Session、进度、证据、阻塞和交接。它不是聊天记录或日志仓库；只在工作状态有实际变化时写入。

## ATM 服务如何发现

正式数据默认位于 `%LOCALAPPDATA%\AyanamiTaskManager`；显式设置 `ATM_DATA_DIR` 时以该目录为准。读取 `<数据目录>\runtime\daemon.json` 获得 `endpoint`，并读取同目录 `local.token` 鉴权。服务只监听 `127.0.0.1`；不要猜端口，也不要把 token 写入仓库、日志、对话或 ATM 记录。`output/` 下的数据只用于测试。

## ATM 未运行怎么办

已安装环境直接启动 AyanamiTaskManager 桌面应用；窗口关闭到托盘后服务仍运行。源码环境在仓库根目录执行 `pnpm dev`。随后用 `pnpm atm status` 或 `pnpm atm doctor` 验证。若 runtime 指向已退出进程，先“完全退出”旧应用再重新启动，不要复用过期 endpoint/token。

## Codex 怎么接入

在 ATM 的“设置 → Agent 接入”选择“安装 Codex 配置”，ATM 会备份并最小合并 `%USERPROFILE%\.codex\config.toml`。配置变化后让 Codex 重新加载 MCP。项目规则应包含：

> 执行项目前先访问 ATM 工具，并阅读 %LOCALAPPDATA%\AyanamiTaskManager\ATM_AGENT_GUIDE.md；后续所有任务执行均依赖 ATM。

## Claude 怎么接入

在“设置 → Agent 接入”选择“安装 Claude 配置”，ATM 会备份并最小合并 `%APPDATA%\Claude\claude_desktop_config.json`，然后重启 Claude Desktop。打包版 stdio 使用 `resources/mcp-stdio.cjs`；不要把 Windows GUI EXE 直接当作 stdio 命令。

## atm\_\* 工具地图

| 目的                             | 工具                                               |
| -------------------------------- | -------------------------------------------------- |
| 开始、恢复 working set、结束     | `atm_begin`、`atm_brief`、`atm_end`                |
| 查找与创建任务                   | `atm_task_list`、`atm_task_get`、`atm_task_create` |
| 领取、启动、阻塞、验证、完成任务 | `atm_task_patch`                                   |
| 写阶段进度与关键证据             | `atm_progress_add`、`atm_record`                   |
| 搜索历史与增量同步               | `atm_search`、`atm_delta`                          |

所有写操作使用唯一 `op_id`；重试同一写请求时复用原 `op_id`。任务变更携带最新 `expected_version`，发生版本冲突后先重新读取。进度摘要上限 500 字，应一次写清结果、证据和下一步，不贴原始日志。

## 最短工作流

1. `atm_begin(project_code, agent_id, role)`，每个 Session 只调用一次，并直接使用返回的 brief。
2. 根据 brief 按需调用 `atm_task_list`；只有需要单项完整上下文时才调用 `atm_task_get`。
3. 开始实现前按下方“任务拆分”规则确认 WorkItem 粒度，再领取具体任务。
4. `atm_task_patch(claim)` → `atm_task_patch(start)`；并行 Agent 各领不同任务。
5. 完成一个有意义阶段后写 `atm_progress_add`；事实、决策、风险写 `atm_record`。
6. 验收后 `atm_task_patch(verify)` → `atm_task_patch(complete)`。
7. 无论成功、暂停或阻塞，最后都调用 `atm_end`；计划换代使用 `retired` 和 predecessor/handoff。

正常开工不要在 `atm_begin` 后紧接 `atm_brief`。只有发生上下文压缩（compaction）、长时间离开，或明确需要恢复 working set 时才调用 `atm_brief`。

### 任务拆分

开始实现前先判断当前 WorkItem 是否可在一个独立工作阶段内完成。
若任务包含多个独立交付物、多个验证阶段、明显跨模块，或预计需要较长连续开发，不要直接执行该大任务；先用 `atm_task_create` 拆成多个可独立完成和验收的子 WorkItem，再领取具体子任务执行。

Objective / Milestone / EPIC 用于表达目标和范围，不应作为长期直接执行单元。
拆分应按“可交付结果 + 可验证验收”划分，而不是机械按文件拆分。

## 完整文档在哪

- Agent 协议与协作细节：`%LOCALAPPDATA%\AyanamiTaskManager\docs\agent-integration.md`
- 用户操作：`%LOCALAPPDATA%\AyanamiTaskManager\docs\user-guide.md`
- 故障排查：`%LOCALAPPDATA%\AyanamiTaskManager\docs\troubleshooting.md`
- 架构与数据边界：`%LOCALAPPDATA%\AyanamiTaskManager\docs\architecture.md`、`%LOCALAPPDATA%\AyanamiTaskManager\docs\data-model.md`
- 发布验收：`%LOCALAPPDATA%\AyanamiTaskManager\docs\release-checklist.md`
- 最新在线版本：`https://github.com/ayanamislover/AyanamiTaskManager`
