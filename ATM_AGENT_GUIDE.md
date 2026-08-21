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

## Claude Desktop 怎么接入

在“设置 → Agent 接入”选择“安装 Claude 配置”，ATM 会备份并最小合并 `%APPDATA%\Claude\claude_desktop_config.json`，然后重启 Claude Desktop。打包版 stdio 使用 `resources/mcp-stdio.cjs`；不要把 Windows GUI EXE 直接当作 stdio 命令。

## Claude Code 怎么接入

Claude Code 与 Claude Desktop 是两条不同的路径：它**从不读** `claude_desktop_config.json`，MCP 注册在 `%USERPROFILE%\.claude.json`（user scope）。规则 `~/.claude/CLAUDE.md` 与技能 `~/.claude/skills` 两者共用，装一次即可。

在“设置 → Agent 接入”选择“安装 Claude Code 配置”。ATM 不会自己改写 `~/.claude.json`——该文件由 Claude Code 持有并高频整体重写，第三方读-改-写会吞掉对方的更新；安装一律通过调用 `claude` CLI 完成，找不到 CLI 时明确报错而不是退化成直接改文件。等价的手工命令：

```powershell
claude mcp add-json ayanami-task-manager '{"command":"<ATM.exe>","args":["<resources\\mcp-stdio.cjs>"],"env":{"ELECTRON_RUN_AS_NODE":"1"}}' --scope user
```

用 stdio 而不是 streamable-http：后者要把 endpoint 和 token 写进配置，而两者每次 daemon 重启都会变，配置随即失效。

## atm\_\* 工具地图

| 目的                             | 工具                                               |
| -------------------------------- | -------------------------------------------------- |
| 开始、恢复 working set、结束     | `atm_begin`、`atm_brief`、`atm_end`                |
| 查找与创建任务                   | `atm_task_list`、`atm_task_get`、`atm_task_create` |
| 领取、启动、阻塞、验证、完成任务 | `atm_task_patch`                                   |
| 给检查项打勾并挂证据             | `atm_checklist`                                    |
| 写阶段进度与关键证据             | `atm_progress_add`、`atm_record`                   |
| 搜索历史与增量同步               | `atm_search`、`atm_delta`                          |

所有写操作使用唯一 `op_id`；重试同一写请求时复用原 `op_id`。任务变更携带最新 `expected_version`，发生版本冲突后先重新读取。进度摘要上限 500 字，应一次写清结果、证据和下一步，不贴原始日志。

## 最短工作流

1. `atm_begin(project_code, agent_id, role)`，正常开工只发起一个语义请求，并直接使用返回的 brief。需要崩溃恢复的控制器必须额外传稳定 `op_id`；响应未知或冷启动时以完全相同的请求重试，ATM 会在现有项目内返回同一 Session。
2. 根据 brief 按需调用 `atm_task_list`；只有需要单项完整上下文时才调用 `atm_task_get`。
3. 开始实现前按下方“任务拆分”规则确认 WorkItem 粒度，再领取具体任务。
4. `atm_task_patch(claim)` → `atm_task_patch(start)`；并行 Agent 各领不同任务。
5. 完成一个有意义阶段后写 `atm_progress_add`；事实、决策、风险写 `atm_record`。
6. 验收后 `atm_task_patch(verify)` → `atm_task_patch(complete)`。
7. 无论成功、暂停或阻塞，最后都调用 `atm_end`；计划换代使用 `retired` 和 predecessor/handoff。

正常开工不要在 `atm_begin` 后紧接 `atm_brief`。只有发生上下文压缩（compaction）、长时间离开，或明确需要恢复 working set 时才调用 `atm_brief`。

`atm_begin(op_id=...)` 的原子键作用域是 `(project, op_id)`。它要求项目已经存在且可解析；不得把 quick task 或自动创建项目混入这次原子恢复。调用方必须验证返回的 `atomicBegin.operationId` 及 `CREATED|RECOVERED` disposition；缺失回执表示服务端没有证明原子能力。同一 `op_id` 的请求身份发生变化会得到 `IDEMPOTENCY_CONFLICT`，不能改 key 或退化为枚举 Session 后猜测。

### 完成闸门

`complete` 依次检查：检查项 → 证据 → 子任务 → 阻塞 → 依赖 → 验收，任何一道不过都抛 `COMPLETION_GATE_FAILED: <原因>`。逐条的出路：

| 报错                                     | 含义与出路                                                                                                                                                                                                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checklist incomplete`                   | 还有检查项停在 TODO/DOING。用 `atm_checklist` 逐条置 `DONE` 或 `SKIPPED`。`id` 与 `expected_version` 取自 `atm_task_get(view="context")`——`core` 视图不返回 `checklist`；`expected_version` 是**检查项自己**的版本、新建为 `0`，不是任务的版本。                                       |
| `evidence required` / `evidence missing` | 该检查项标了「需要证据」。要么带 `evidence` 挂上真证据，要么置 `SKIPPED`——跳过的必证项不再要求证据。不要为了打勾而编证据。                                                                                                                                                             |
| `child incomplete`                       | 还有子 WorkItem 不在 DONE/CANCELLED。                                                                                                                                                                                                                                                  |
| `blocker active`                         | 这条来自**独立的 blocker 记录**，由带非空 `blocker` 的 `atm_progress_add` 写入，和任务行上的 `blocked_reason` 不是一回事。`blocker: null` 只表示「这次不新写」，不会关掉已有的那条。用 `atm_task_patch(reopen)`，或对已在进行中的任务再 `start` 一次——「接着做」即意味着阻塞不再成立。 |
| `dependency not ready`                   | 有 BLOCKS 关系的前置任务尚未 DONE。                                                                                                                                                                                                                                                    |
| `verification required`                  | 任务要求验收，先 `verify` 再 `complete`。                                                                                                                                                                                                                                              |

### MCP 没有的能力走 REST

少数能力目前只有 REST 入口，例如创建 Objective / Milestone（`POST /api/v1/projects/{code}/objectives`、`.../milestones`）。REST 与 MCP 用同一个 `endpoint` 和 token（见「ATM 服务如何发现」），写操作同样需要 `session` 与唯一 `op_id`。

方法用错会返回 **405** 并在 `allow` 头和错误信息里列出该路径接受的方法——看到 405 是「方法不对」，看到 404 才是「路径不存在」，不要因为 404 就去猜别的路径名。

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
