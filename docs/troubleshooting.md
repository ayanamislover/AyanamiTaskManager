# 排障指南

## 先运行健康检查

```powershell
& "$env:LOCALAPPDATA\AyanamiTaskManager\current\AyanamiTaskManager.exe" --cli status
& "$env:LOCALAPPDATA\AyanamiTaskManager\current\AyanamiTaskManager.exe" --cli doctor
```

`status` 从 `%LOCALAPPDATA%\AyanamiTaskManager3\runtime\daemon.json` 发现并探测当前服务，报告 SQLite 版本、项目总数与按 lifecycle（`ACTIVE`、`ARCHIVED`、`TRASHED`）的计数和转换状态；`doctor` 在此之外只读检查本地文件：转换清单 `conversion.json`、是否在等用户选择数据来源或从备份恢复、`runtime\daemon.json`、单库 `data\atm.sqlite` 的 `quick_check`、`backups\` 下的整库备份数和保活状态，发现的问题列在 `problems` 里。服务没在运行时用 `--cli doctor --offline`：不连服务，不改数据目录里的任何文件。服务连不上时 `status`、`doctor` 以退出码 4 结束，并附上同一份本地检查。CLI 没有 endpoint/token 命令行参数，也不要把 token 粘贴到 issue、日志或命令行。

## 应用无法启动

1. 确认 Windows 版本和磁盘可写；
2. 检查 `%LOCALAPPDATA%\AyanamiTaskManager3\logs`（`host.log`、`lifecycle.ndjson`）与 `%LOCALAPPDATA%\AyanamiTaskManager3\runtime` 下的 `daemon.json`、`startup-state.json`；
3. 确认没有另一个实例占用运行时端口；第二实例正常情况下会唤起现有窗口；
4. 若最近升级后的数据转换失败，或窗口提示数据库读不出，先把 `%LOCALAPPDATA%\AyanamiTaskManager3` 整个复制一份留存，不要删除数据库；读不出时按下文[数据库读不出](#数据库读不出)处理；
5. portable 包请确认完整解压，`resources\atm.exe`、`resources\atm-mcp.exe` 未被杀毒软件隔离。

`pnpm test:e2e` 用的 Vite 开发服务器固定使用 `127.0.0.1:9999`。若 Vite 报端口占用，先关闭占用 9999 的旧进程；不要把生产服务的动态端口改成 9999。

## 需要选择数据来源

经安装器回退到 2.x 并在 2.x 中改过数据后再升级，ATM 会自动以 2.x 为准重新转换，当前 3.0 的数据封存在 `%LOCALAPPDATA%\AyanamiTaskManager3\superseded\`，不会询问；回退后没在 2.x 写过则无损接回 3.0（见[用户指南](user-guide.md#从-2x-升级与回退)）。只有 3.0 判断不了该用哪一边的数据时（例如没经安装器回退就运行了 2.x、2.x 的数据目录里多了不认识的文件、数据无法比较），窗口才会显示「需要选择数据来源」，托盘也会提示。选之前 ATM 不读写任何项目数据，Agent 连不上（报 `ATM_SOURCE_CONFLICT`）。

- 「沿用 3.0」：继续用 3.0 里的数据，2.x 期间的修改不会带过来；2.x 的数据原样留着。
- 「从 2.x 重新转换」：以 2.x 为准重新转换；当前 3.0 的数据封存在 `%LOCALAPPDATA%\AyanamiTaskManager3\superseded\`，不删除。

两边的数据在选之前都不会被改。页面下方的「原因（原文）」是诊断用的原文，求助时可以附上。

## 数据库读不出

已发布的 3.0 数据库（`%LOCALAPPDATA%\AyanamiTaskManager3\data\atm.sqlite`）缺失或读不出时，ATM 不服务，不改写数据库和备份，也不新建空库（只在 `runtime\` 记下这一状态，日志照常写）：宿主隔几秒再试两次，仍读不出才在窗口显示「数据库读不出，需要从备份恢复」，托盘也会提示。页面列出 `backups\` 下的每份整库备份：能不能用、不能用的原因，并标出恢复命令默认用的那一份（最新一份可用的）。

1. 从托盘菜单选「完全退出」。恢复时 ATM 不能开着，否则命令以退出码 5 拒绝，什么都不改。
2. 打开 PowerShell，运行页面给出的命令（形如 `& '<…\resources\atm.exe>' recover --offline`，页面上可以一键复制）。在命令末尾加 `--list` 只列出每份备份的问题、不做恢复；加 `--from <ID>` 改用列表里别的一份。
3. 按提示输入备份 ID 确认。当前的数据（库、`-wal`、附件，整体）移进 `%LOCALAPPDATA%\AyanamiTaskManager3\quarantine\`，不删除；备份之后的修改不会回来，Agent 需要按 Agent Guide 重做。
4. 恢复完成后重新打开 ATM。

页面显示没有整库备份、或命令报告没有可用的备份时，不要删除数据目录，先把 `%LOCALAPPDATA%\AyanamiTaskManager3` 整个复制一份留存，再求助。

恢复之前，Agent 经 MCP 收到错误码 `DATABASE_DAMAGED`：`fix.kind` 是 `ask_user`，不可重试，应转告用户按上面的步骤处理，恢复完成后再原样重发。CLI 报 `ATM_DATABASE_DAMAGED`（退出码 4），`--cli doctor --offline` 把它列在 `problems` 里。这一状态记在 `%LOCALAPPDATA%\AyanamiTaskManager3\runtime\damaged.json`（不含令牌）：宿主重试两次仍读不出才写，恢复成功或下次启动能正常服务时删除。手工删掉它不会让库变好，下次启动仍读不出时会再写一次。这份状态里记着写下它的 ATM 进程。那个进程还在运行时，MCP 与 CLI 立刻报上面的错误码；它已经退出（这是上一次运行留下的），MCP 与 CLI 不直接当真：先唤醒 ATM，等它重新判定——仍读不出就重写这份状态并报错误码；库已经在 ATM 外换回好的，它就删掉这份状态、照常服务。等满（MCP 读约 45 秒、写约 30 秒，CLI 45 秒）这份状态还在，照样报错误码。找不到桌面端（开发构建）或拉不起来时不等，直接报。

## 崩溃后自动恢复

安装版由 setup 注册一个当前用户的计划任务「AyanamiTaskManager 保活」：登录期间每 5 分钟运行一次安装目录下的 `AyanamiTaskManager.exe --ensure-running`。它只做判定，立刻退出：

| 情况                                         | 结果                                                 |
| -------------------------------------------- | ---------------------------------------------------- |
| 安装、更新、修复或卸载还没结束（事务屏障在） | 什么都不做，不跑恢复，不弹窗                         |
| 当前安装的不是 3.x（回滚到了 2.x）           | 什么都不做；setup 回滚时会删除或恢复这个任务         |
| ATM 在运行                                   | 什么都不做（不记日志）                               |
| 本次登录里用户从托盘“完全退出”过             | 不启动，直到用户自己启动 ATM 或重新登录              |
| 30 分钟内异常退出 3 次（熔断）               | 不启动，直到用户自己启动 ATM；那一次会弹通知说明原因 |
| 其他                                         | 以 `--background` 启动当前版本                       |

因此崩溃后最迟约 5 分钟恢复：等待下一次触发（≤ 5 分钟）+ 判定（毫秒级）+ 启动到服务健康。关机、注销结束的进程不算异常退出；setup 停止 ATM 也不算用户退出。

查看现状：

```powershell
AyanamiTaskManager.exe --cli doctor --offline
```

输出里的 `keepalive` 一节：`auto_recovery` 只在任务注册成功、没有熔断、本次登录没有从托盘退出时为 `true`，否则 `reason` 说明原因（任务注册失败时是失败原文）。`recent_abnormal_exits` 是 30 分钟内的异常退出次数。这一节不计入 `problems`：便携版、开发构建本来就没有自动恢复，熔断与用户退出是有意的停手。

相关文件（都不含令牌）：

- `%LOCALAPPDATA%\AyanamiTaskManager3\logs\keepalive.log`：每次启动、熔断、用户退出、屏障在的判定（超过 64 KiB 轮转一份）；
- `%LOCALAPPDATA%\AyanamiTaskManager3\runtime\keepalive.json`：熔断状态；`runtime\user-quit.json`：托盘退出标记（记的是那一次登录）；
- 安装目录 `state\keepalive-task.json`：setup 最近一次注册或删除任务的结果。

熔断后由用户启动的那一次会在 `lifecycle.ndjson` 记一条 `keepalive.reset`（`abnormalExits` 为此前的异常退出次数）。不要手工删除这些文件来“解除”熔断：自己从开始菜单启动一次即可，并先按下一节查清反复退出的原因。

## 窗口或托盘意外消失

先区分窗口隐藏到托盘与整个进程结束，托盘图标可能延迟刷新，不能据此确定退出时刻或关联另一个应用。

桌面主实例在 `%LOCALAPPDATA%\AyanamiTaskManager3\logs` 保存 `lifecycle.ndjson`（含轮转文件，最多 3 × 256 KiB）和 `lifecycle-state.json`；`%LOCALAPPDATA%\AyanamiTaskManager\logs` 里的 `lifecycle-core*` 与 `lifecycle.ndjson` 是 2.x 和 1.x 留下的旧记录：

- `startup` / `ready`：本次进程及启动方式；每分钟 `heartbeat` 记录进程 RSS 与最后存活时间。
- `shutdown.begin` / `shutdown.complete` / `exit`：正常退出链。退出码为 0 且服务关闭成功，才记录 `clean=true`。
- `session-end`：Windows 正在结束会话（关机、重启或注销）。系统随后很快终止进程，退出链往往来不及走完，所以这一条是收到通知时同步写下的最后标记。
- `exception` / `bootstrap.failed`：异常类型、错误码与消息指纹；不保存原始异常消息、堆栈、令牌或任务正文，也不吞掉未捕获异常。
- `previous.unclean`：下一次启动发现上个主实例缺少正常退出记录。可能是外部终止、断电或崩溃，**它本身不是根因**。日志不可写或磁盘已满时也可能缺少证据。
- `previous.session-end`：上个主实例的最后标记是 `session-end`，即它是随 Windows 关机/注销结束的。这是**已解释**的终止，不记 `previous.unclean`；证据字段（`previousRunId`、`previousPid`、`previousAt`）保持一致，只是结论不同。若关机被取消、进程继续运行，之后任何一条记录（最迟一分钟后的 `heartbeat`）都会覆盖该标记，真正的外部终止仍然记 `previous.unclean`。

提供版本、故障的大致时刻和上述日志即可；不要附带 `runtime\daemon.json`（包含本地令牌）或 `data\atm.sqlite`。诊断文件写入失败不会阻止应用运行。此记录功能不能倒推安装前的退出原因，也不等于修复了导致退出的问题。

### 关闭 Agent 后 ATM 也消失

`atm-mcp.exe` 与 CLI 唤醒桌面端用的是普通的后台启动（`CREATE_NO_WINDOW`、自成进程组，不弹控制台窗口），它**不**保证子进程脱离宿主的 kill-on-close Job。由 Agent 唤醒、
或由 Agent 终端直接启动的 ATM，都可能随宿主一起结束。从开始菜单或登录自启启动的 ATM 不受影响。

曾经用「注册当前用户按需计划任务」来绕开这一点，已撤回：那串行为（程序启动带编码命令的
PowerShell 去注册并运行计划任务）与恶意软件的持久化手法无法区分，卡巴斯基按行为检测报
`PDM:Trojan.Win32.Generic`。不为了躲过检测而改写实现。

**因此：不要从 Agent 终端启动生产 ATM**，部署后请由用户从开始菜单启动，或等它被正常唤醒。
3.x 安装版的「保活」任务（见[崩溃后自动恢复](#崩溃后自动恢复)）与上面撤回的做法不同：它由安装器在安装时
通过任务计划程序接口注册一次，程序运行时不注册、不启动 PowerShell。被连带终止的实例会在 5 分钟内由它在任务里重新启动。
已知的一次实例消失（2026-09-23 05:18 本地）就是这样来的：该实例是 09-22 由 Agent 部署时
从自己的终端启动的，宿主关闭时被连带终止。更早的几次没有诊断日志，原因仍未确定。

诊断日志 `%LOCALAPPDATA%\AyanamiTaskManager3\logs\lifecycle.ndjson` 的 `startup` 事件记录了每次启动的 `background` 与 `agentWake`，
`previous.unclean` 记录上一次是否非正常结束。排查实例消失时先看这两项，再下结论。

注意 `previous.unclean` 曾经把**正常关机**也算在内：2026-09-23 18:15 本地用户正常关机，
ATM 的最后一条心跳在 28 秒前，退出链没走完，下次启动就记成了 `previous.unclean`——
读起来像"有东西杀了它"，实际上没有。现已改为在收到 Windows 会话结束通知时同步写下
`session-end`，下次启动据此记 `previous.session-end`。因此**早于该修复的历史日志里，
`previous.unclean` 不能直接当作异常终止的证据**，要另行核对系统日志的关机事件（1074 / 6006）。

运行描述符（`runtime/daemon.json`）在 ATM 被强制结束后会残留，其中的 PID 可能已被别的进程复用。
桥接因此不只看 PID：向记录的端点连接被拒时，视为该实例已失效，唤醒一次并等待新实例发布后重试
这一次请求；请求已送达后才断开的情况不会重试，避免重复投递。

## MCP 无法连接

- 桌面设置中重新运行“连接测试”；
- 确认配置使用 packaged stdio bridge；手工复制的 Streamable HTTP 配置只对当前运行实例有效；
- Windows packaged stdio 使用 `%LOCALAPPDATA%\AyanamiTaskManager\current\resources\atm-mcp.exe`，参数只有 `--profile <name>`，不带环境变量；不能直接把 GUI EXE 当 stdio；
- 若 `atm-mcp.exe` 不见了（常见于被杀毒软件隔离），先从隔离区还原，再重启 Agent 客户端；3.0 没有别的 stdio 入口可以回落，Agent 配置里的路径不用改；
- 2.x 写进配置的旧入口（`AyanamiTaskManager.exe --mcp-stdio`、`mcp-stdio.cjs`、`ayanami-task-manager-actions`、没有 `--profile` 的 `ayanami-task-manager`）会在 ATM 启动时被改成 `atm-mcp.exe --profile core|memory`，改之前留一份 `.bak-` 备份；没接入过 ATM 的客户端不会被改。改完要重启 Agent 客户端；
- bridge 的 stderr 里 `ATM_RUNTIME_UNAVAILABLE` 表示 45 秒内没等到 daemon 发布，`ATM_RUNTIME_DESCRIPTOR_INVALID` 表示 `runtime/daemon.json` 内容不合法（不会等待），`MCP_PROFILE_INVALID` 表示 `--profile` 写错；
- `ATM_SOURCE_CONFLICT` 表示 ATM 在等用户在窗口里选择数据来源（见[需要选择数据来源](#需要选择数据来源)），bridge 不等待、直接返回；写调用得到的错误信封是 `SERVICE_UNAVAILABLE`，说明里写明在等用户选择，用户处理后原样重发；
- `DATABASE_DAMAGED` 表示数据库读不出、要用户先从备份恢复（见[数据库读不出](#数据库读不出)）。写下它的 ATM 还在运行时 bridge 立刻报、不等待；上一次运行留下的，bridge 先唤醒 ATM、等它重新判定（拉不起 ATM 时直接报）。重试没有用；
- 设置了 `ATM3_DATA_DIR` 时，bridge 读取的是该目录下的 `runtime/daemon.json`，须与桌面端一致；
- `401` 表示 token 错误或已随 daemon 重启过期；优先重载 stdio bridge，手工 HTTP 配置需从设置重新复制；
- `SESSION_CLOSED` 表示旧 Session 已结束，应重新 `atm_begin`；
- `SESSION_NOT_RETIRED` 表示 predecessor 没有显式退休，不可 resume。

## 任务更新失败

- `VERSION_CONFLICT`：重新读取任务，用新版本判断后重试；
- `INVALID_TRANSITION`：按错误 details 中的 `legal_operations` 选择操作；完整 canonical 状态/操作表见 [generated/work-item-operations.md](./generated/work-item-operations.md)；
- `CLAIM_CONFLICT`：任务被其他 Session 领取；等待释放或确认 lease 已过期后显式接管；
- `IDEMPOTENCY_CONFLICT`：同一 `op_id` 被用于不同请求，改用新的 `op_id`；
- `PROJECT_DB_UNAVAILABLE`：项目在垃圾箱里，只有用户能在界面恢复；Agent 不要另建项目或临时任务绕过。
- `VALIDATION_ERROR` 且指向 `summary`：单条进度摘要最多 500 字；精简日志和重复上下文后重试。

## 项目或搜索缺少数据

3.0 只有一个库，总览、项目详情和全局搜索读的是同一份数据，写入在同一个事务里提交。界面每 30 秒以及窗口重新获得焦点时重新读取。若项目写入成功但界面暂未显示：

1. 打开项目确认任务事实存在；
2. 刷新页面；
3. 运行 `doctor`；
4. 不要直接编辑数据库。

## 工程统计不可用

- `NO_SOURCE_PATH`：为项目附加源码目录；
- 目录不是 Git 工作树：初始化 Git 或改绑正确目录；
- 尚无 commit 可以统计，ATM 使用空树 baseline；不会替用户提交；
- 文件权限或 Git 命令超时只降级指标，不影响任务事务；
- 生成目录、依赖目录、lockfile、vendor、release/output 不计入 Source/Test LOC。

## 备份或恢复失败

不要手工删除 `.tmp`、WAL 或当前数据库。ATM 下次启动会清理中断临时文件，但按项目或知识库恢复应从数据工具发起；服务起不来、窗口提示数据库读不出时，按上文[数据库读不出](#数据库读不出)用 `recover --offline` 从整库备份恢复。校验失败时保留原备份与 manifest，检查磁盘空间、权限、SHA-256 和 SQLite `quick_check`。详见 [backup-recovery.md](./backup-recovery.md)。

若外部备份体积异常增大，检查工具是否跟随了 `%LOCALAPPDATA%\AyanamiTaskManager` 下的 `current` junction。该入口指向完整安装目录，
必须按“跳过重解析点/目录链接”处理；它不属于用户数据，也不应复制到另一台设备。

## 收集最小诊断材料

可共享：应用版本、错误代码、request id、`doctor` 的非敏感结果、复现步骤、是否 installer/portable。不要共享：本地 token、完整任务正文、项目数据库、用户目录清单或私有源码。
