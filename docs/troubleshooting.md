# 排障指南

## 先运行健康检查

```powershell
pnpm atm status
pnpm atm doctor
```

`status` 会从 `runtime/daemon.json` 发现并校验当前服务，再检查 SQLite 能力；`doctor` 进一步验证 Registry、FTS5/trigram，以及磁盘上所有受管项目数据库（含 `ACTIVE`、`ARCHIVED`、`TRASHED`）的 `quick_check`、外键完整性和双库分离。输出按 lifecycle 给出总数与失败数，并列出失败项目；归档或移入垃圾箱不会让数据库退出健康检查。CLI 不接受持久化 endpoint/token 参数，也不要把 token 粘贴到 issue、日志或命令行。

## 应用无法启动

1. 确认 Windows 版本和磁盘可写；
2. 检查 `%LOCALAPPDATA%\AyanamiTaskManager\logs` 与数据目录 `runtime/daemon.json`；
3. 确认没有另一个实例占用运行时端口；第二实例正常情况下会唤起现有窗口；
4. 若最近迁移失败，先备份整个数据目录，不要删除数据库；
5. portable 包请确认完整解压，`resources` 和原生模块未被杀毒软件隔离。

开发态 Web 界面固定使用 `127.0.0.1:9999`。若 Vite 报端口占用，先关闭占用 9999 的旧开发进程；不要把 daemon 的 4393/4394 或生产动态端口改成 9999。

## 窗口或托盘意外消失

先区分窗口隐藏到托盘与整个进程结束，托盘图标可能延迟刷新，不能据此确定退出时刻或关联另一个应用。

桌面主实例在 `%LOCALAPPDATA%\AyanamiTaskManager\logs` 保存 `lifecycle.ndjson`（含轮转文件，最多 3 × 256 KiB）和 `lifecycle-state.json`：

- `startup` / `ready`：本次进程及启动方式；每分钟 `heartbeat` 记录主进程 RSS/JS heap 数值与最后存活时间。
- `shutdown.begin` / `shutdown.complete` / `exit`：正常退出链。退出码为 0 且服务关闭成功，才记录 `clean=true`。
- `exception` / `bootstrap.failed`：异常类型、错误码与消息指纹；不保存原始异常消息、堆栈、令牌或任务正文，也不吞掉未捕获异常。
- `renderer.gone` / `child.gone` / `renderer.load-failed`：Electron 的原因类别和退出码；不保存加载 URL。
- `previous.unclean`：下一次启动发现上个主实例缺少正常退出记录。可能是外部终止、断电或崩溃，**它本身不是根因**。日志不可写或磁盘已满时也可能缺少证据。

提供版本、故障的大致时刻和上述日志即可；不要附带 `runtime/daemon.json`（包含本地令牌）或项目数据库。诊断文件写入失败不会阻止应用运行。此记录功能不能倒推安装前的退出原因，也不等于修复了导致退出的问题。

### 关闭 Agent 后 ATM 也消失

Windows 的 `detached` / `unref` **不**保证子进程脱离宿主的 kill-on-close Job。由 Agent 唤醒、
或由 Agent 终端直接启动的 ATM，都可能随宿主一起结束。从开始菜单或登录自启启动的 ATM 不受影响。

曾经用「注册当前用户按需计划任务」来绕开这一点，已撤回：那串行为（程序启动带编码命令的
PowerShell 去注册并运行计划任务）与恶意软件的持久化手法无法区分，卡巴斯基按行为检测报
`PDM:Trojan.Win32.Generic`。不为了躲过检测而改写实现。

**因此：不要从 Agent 终端启动生产 ATM**，部署后请由用户从开始菜单启动，或等它被正常唤醒。
已知的一次实例消失（2026-09-23 05:18 本地）就是这样来的：该实例是 09-22 由 Agent 部署时
从自己的终端启动的，宿主关闭时被连带终止。更早的几次没有诊断日志，原因仍未确定。

诊断日志 `logs/lifecycle.ndjson` 的 `startup` 事件记录了每次启动的 `background` 与 `agentWake`，
`previous.unclean` 记录上一次是否非正常结束。排查实例消失时先看这两项，再下结论。

运行描述符（`runtime/daemon.json`）在 ATM 被强制结束后会残留，其中的 PID 可能已被别的进程复用。
桥接因此不只看 PID：向记录的端点连接被拒时，视为该实例已失效，唤醒一次并等待新实例发布后重试
这一次请求；请求已送达后才断开的情况不会重试，避免重复投递。

离线打包可将 `ATM_ELECTRON_ZIP_DIR` 指向已下载、可信且版本匹配的 Electron ZIP 缓存目录，
不改变运行时版本；仍需通过打包内容检查及真实程序烟测。

## MCP 无法连接

- 桌面设置中重新运行“连接测试”；
- 确认配置使用 packaged stdio bridge；手工复制的 Streamable HTTP 配置只对当前运行实例有效；
- Windows packaged stdio 必须使用 `resources/mcp-stdio.cjs` 配合 `ELECTRON_RUN_AS_NODE=1`，不能直接把 GUI EXE 当 stdio；
- `401` 表示 token 错误或已随 daemon 重启过期；优先重载 stdio bridge，手工 HTTP 配置需从设置重新复制；
- `SESSION_CLOSED` 表示旧 Session 已结束，应重新 `atm_begin`；
- `SESSION_NOT_RETIRED` 表示 predecessor 没有显式退休，不可 resume。

## 任务更新失败

- `VERSION_CONFLICT`：重新读取任务，用新版本判断后重试；
- `INVALID_TRANSITION`：按错误 details 中的 `legal_operations` 选择操作；完整 canonical 状态/操作表见 [generated/work-item-operations.md](./generated/work-item-operations.md)；
- `CLAIM_CONFLICT`：任务被其他 Session 领取；等待释放或确认 lease 已过期后显式接管；
- `IDEMPOTENCY_CONFLICT`：同一 `op_id` 被用于不同请求，改用新的 `op_id`；
- `PROJECT_DB_UNAVAILABLE`：项目正在迁移、恢复、已进垃圾箱或迁移失败。
- `VALIDATION_ERROR` 且指向 `summary`：单条进度摘要最多 500 字；精简日志和重复上下文后重试。

## 项目或搜索缺少数据

项目详情是事实源，Registry 总览和全局搜索是可重建投影。若项目写入成功但总览暂未刷新：

1. 打开项目确认任务事实存在；
2. 等待 WebSocket 增量或刷新页面；
3. 运行 `doctor`；
4. 检查项目是否为 `MIGRATION_FAILED`；
5. 不要直接编辑 Registry 缓存表。

## 工程统计不可用

- `NO_SOURCE_PATH`：为项目附加源码目录；
- 目录不是 Git 工作树：初始化 Git 或改绑正确目录；
- 尚无 commit 可以统计，ATM 使用空树 baseline；不会替用户提交；
- 文件权限或 Git 命令超时只降级指标，不影响任务事务；
- 生成目录、依赖目录、lockfile、vendor、release/output 不计入 Source/Test LOC。

## 备份或恢复失败

不要手工删除 `.tmp`、WAL 或当前数据库。ATM 下次启动会清理中断临时文件，但正式恢复应从数据工具发起。校验失败时保留原备份与 manifest，检查磁盘空间、权限、SHA-256 和 SQLite `quick_check`。详见 [backup-recovery.md](./backup-recovery.md)。

若外部备份体积异常增大，检查工具是否跟随了数据根下的 `current` junction。该入口指向完整安装目录，
必须按“跳过重解析点/目录链接”处理；它不属于用户数据，也不应复制到另一台设备。

## 收集最小诊断材料

可共享：应用版本、错误代码、request id、`doctor` 的非敏感结果、复现步骤、是否 installer/portable。不要共享：本地 token、完整任务正文、项目数据库、用户目录清单或私有源码。
