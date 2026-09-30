# 本地安全模型

本文描述 ATM 当前实现实际提供的防护边界。它是本地单用户桌面应用的安全契约，不是互联网多租户服务的威胁模型。

## 受保护的边界

### 服务发现与调用认证

- daemon 只监听 `127.0.0.1`，API 使用运行时选择的独立端口；`9999` 仅是源码开发时的 Web 前端端口。
- 正式桌面 daemon 每次启动都会生成新的 Bearer token，并原子发布到 `<数据目录>\runtime\daemon.json`。发现文件同时绑定 `endpoint`、`pid`、`version`、`startedAt` 和随机 `instanceId`；正常退出会清除它，旧 token 在重启后失效。standalone 开发入口仅在显式设置 `AYANAMI_TASK_TOKEN` 时允许固定测试 token，正式桌面 host 明确忽略该 override。
- 自动安装的 Agent 配置使用 stdio bridge，bridge 每次请求都重新读取并校验发现文件，因此配置不持久化 endpoint/token，也能跨 daemon 重启恢复。
- REST 在认证前拒绝非 localhost/127.0.0.1 的浏览器 `Origin`；错误响应不回显当前或调用方提供的 token。WebSocket 必须在 3 秒内完成认证；错误 token 或超时以 `1008` 关闭，认证成功前不发送业务事件。认证前的非法 JSON 只返回有界协议错误，不会得到业务数据。
- 打包 Renderer 不接收原始 endpoint 与用户凭证，只通过 Preload 暴露的有界 Main-process API capability 访问 `/api/v1/*`；跨源导航和新窗口被拒绝。设置页为“复制当前运行实例的 Streamable HTTP 配置”取得的配置里带的是 Agent 凭证。

Bearer token 是本地调用认证凭据。不要把它写入仓库、日志、ATM Record、对话、命令行参数或长期 Agent 配置。只有用户明确复制“当前运行实例”的 Streamable HTTP 配置时，该临时配置才会包含当前 token。

### 用户凭证与 Agent 凭证

正式桌面 daemon 同时持有两份凭证，每次启动都重新生成：

- **Agent 凭证**：即 `daemon.json` 里的 `token`。MCP bridge、`--mcp-stdio`、`--cli` 和按指南直接调 REST 的 Agent 都用它。
- **用户凭证**：只由桌面主进程在内存里生成，不写入 `daemon.json`、日志或 Agent 配置，也不交给 Renderer；Renderer 的每个 `/api/v1/*` 请求由主进程代为注入。

「用户的决定」只接受用户凭证，Agent 凭证调用返回 `403 USER_AUTHORIZATION_REQUIRED`，且不产生任何写入。包括：垃圾箱恢复请求的授权与拒绝，项目恢复、移入垃圾箱与归档，新建与恢复备份（新建会按保留策略删除同组最旧的手动备份），设置写入，保存视图的新建、修改与删除，知识的新建、更新与归档（REST 这几条是管理界面入口：不记 Agent 作者、不要求 Session、能改已归档条目；Agent 发布知识走 MCP `atm_knowledge_save`，作者记为该 Agent），导入 apply，项目路径绑定，Session 强制关闭，`/projects/:code/ui/*` 与其他以用户身份落账的写入，以及 `actor=USER`（含缺省）的临时任务写入。

归类由守卫按 daemon 实际注册的路由逐条核对，而不是扫描源码字面：每条写路由（非 GET/HEAD/OPTIONS）要么标为用户专属，要么出现在测试里写明理由的 Agent 放行清单中（MCP 传输、开工/收工、需有效 Agent session 的任务流、只读预览、重建读模型等）；新增写路由两边都不在，或放行清单留有已不存在的条目，测试即红。放行理由必须写实际副作用而不是「看起来无害」。这保证清单**完整**，但每条路由**归哪一边**仍是人为判断：守卫不证明放行项的行为无害，曾被写成「只新增一份备份」的备份路由实际会淘汰用户的手动备份，就是靠复核实测发现的。

这一层挡住的是「按文档办事的 Agent」和「读一个文件就能冒充用户」：只持 MCP/bridge，或读取 `daemon.json` 后直接调 REST 的 Agent，都无法替用户授权。它**不是**同用户进程之间的强隔离：同一 Windows 用户下的程序仍可以蓄意读取 ATM 主进程内存，或模拟键盘鼠标操作界面，这两类仍属于下文的非目标。standalone 开发 daemon 只有显式设置 `AYANAMI_TASK_USER_TOKEN` 时才分离凭证，否则那一个 token 同时代表用户，不应用于安装版。

### 手机同步与自建中继（可选，默认关闭）

设计与协议见 [mobile-sync.md](mobile-sync.md)，决策见 [ADR-016](adr/ADR-016-mobile-relay-and-dispatch.md)。

- **不新开监听端口。** 同步连接器在 daemon 进程内只做出站 HTTPS，连接用户自己配置的中继；daemon 仍然只监听 `127.0.0.1`。中继地址只接受 https，明文 http 只允许 `127.0.0.1` / `localhost`（开发联调）。
- **仓库与安装包里没有默认服务器。** 未配置中继时连接器不发任何网络请求；守卫扫描生产代码，出现维护者自己的服务器域名即红。
- **中继是不可信传输层。** 每个配对空间有一把 32 字节空间密钥，经 HKDF 派生出 AES-256-GCM 与 HMAC 两把子密钥；所有文档内容端到端加密，AAD 绑定文档键，项目码经 HMAC 后才进键名。中继运营者或拿到中继 token 的人能看到键名、大小与时间，能删改或重放密文、拒绝服务，但读不到内容，也伪造不出能通过校验的命令。
- **密钥不进 Agent 可读的地方。** 中继 token 与空间密钥经宿主提供的 SecretStore 落盘：正式桌面端用 Electron `safeStorage`（Windows 上即 DPAPI），不可用时拒绝保存；standalone 开发 daemon 用明文文件并在状态里标明。两者都不写入 Registry 的 settings 表、`daemon.json`、日志或 ATM Record。`GET /api/v1/sync/status` 两种凭证都能读，但不含 token、空间密钥或配对码。
- **写入口全部是用户专属。** 修改中继配置、生成配对码、重置配对都要求用户凭证；Agent 凭证返回 `403 USER_AUTHORIZATION_REQUIRED`。配对码同时携带中继 token 与空间密钥，只在设置页本地展示。
- **手机只能发白名单命令。** 仅「建任务」与「对已有任务派单」两种；命令 ID 同时是幂等键（`op_id = mobile:<命令 ID>`），重放不会建第二个任务；早于 7 天的命令被拒。建出的任务以 USER 身份落账，与在桌面端点「新建任务」等价。
- **撤销。** 「重置配对」轮换空间 ID 与密钥并删除电脑在旧空间写过的文档，旧手机随即无法解密新数据；吊销中继 token 属于中继自身的管理动作。

### Claude 自动派单（可选，默认关闭）

- 只处理用户明确点名的任务：手机新建任务时勾选「交给 Claude」、对已有任务点「交给 Claude」，或桌面端任务抽屉里的同名按钮。ATM 不会自己挑任务派出。
- 开关、权限模式、并发上限、模型等配置只能用用户凭证修改；默认权限模式 `auto`，`bypassPermissions` 需要用户在设置里显式选择。
- 会话以参数数组启动 `claude -p`（不经 shell），提示词经 stdin 传入且不含任何密钥；子进程环境去掉会把会话串到宿主上的 Claude Code 会话变量。会话日志只写 `<数据目录>\dispatch\logs`，不进入项目事实。

### Cursor 完整性与作用域

Task、Record、Session、Search 和长字段 cursor 包含版本、选择条件、项目/实体、快照位置及 SHA-256 摘要。读取端会拒绝损坏、跨项目、跨实体、跨选择集复用或内容已变化的 cursor。

该摘要是确定性的完整性与作用域绑定，不是带秘密密钥的签名、MAC、认证或授权。持有代码的调用方可以重算摘要；访问权限仍由 Bearer token 和上层业务规则决定。

### 受管路径与迁移

- 正式数据根必须是有界绝对路径；迁移拒绝盘符根、相同/嵌套根，以及把 symlink/junction 直接作为源或目标根（`DATA_ROOT_LINK_NOT_ALLOWED`）。源、目标或备份根内的 `runtime` 目录也不得是 symlink/junction（`DATA_ROOT_RUNTIME_LINK_NOT_ALLOWED`）。
- 迁移复制时不跟随数据根内的 symlink/junction，尤其不会展开指向完整安装目录的 `current` junction。
- 迁移使用目标级独占 lease、staging、manifest、SQLite `quick_check` 和原子 rename；运行时发现文件与旧 token 文件不会进入新数据根或备份。

这些规则保护正常产品入口免于路径别名、嵌套复制和部分提交；它们不把同一用户主动篡改 Registry 中受信路径视为隔离边界。

### 数据库事务与投影

- 一个正式 mutation 只在单个 Project SQLite 事务内同时提交领域状态、单调事件、幂等回执和 outbox；失败全部回滚。
- `atm_feedback` 复用同一套 Project Record mutation：只在当前本机项目数据库写入 `ATM_FEEDBACK` Record，不包含网络上传、遥测或自动创建外部 Issue 的路径。
- 生产 SQL 禁止 `ATTACH DATABASE` 跨 Registry/Project 写入。项目提交后由 outbox 更新 Registry 摘要和全局搜索投影；投影失败保留待重试项，不回滚已经提交的项目事实。
- Registry 投影是可重建读模型，不是项目事实源；跨数据库不承诺原子可见。

## 明确的非目标

ATM 不试图防御以下主体或场景：

- 与 ATM 处于同一 Windows 用户、能够读取或修改 `%LOCALAPPDATA%` 的恶意进程；
- 已能修改安装文件、注入受信 Main/Preload/Renderer、读取进程内存或取得当前用户调试权限的代码；
- 用户主动泄露 Bearer token 后的调用；
- Registry 与 Project SQLite 之间的跨数据库原子提交；
- 把本机 loopback 服务直接暴露到局域网或互联网后的安全性（手机同步走出站中继，不需要也不应该这样做）；
- 已配对手机被他人拿到后以本人身份发出的白名单命令，以及中继对密文的删除、回滚与拒绝服务。

若需要跨用户、跨主机或不受信插件隔离，应在 ATM 外部增加操作系统账户边界、文件 ACL、进程隔离和受认证的远程网关，不能把本模型外推为远程安全承诺。

## 自动化守卫

仓库测试绑定以下事实：loopback runtime descriptor schema 与 token 轮换、foreign Origin/错误 Bearer、WebSocket 认证超时与认证前零业务帧、迁移根 containment、生产 SQL 无 `ATTACH DATABASE`、项目 mutation 回滚/outbox 重试、随包 Guide/docs 的精确 manifest，以及同步协议的 AAD 绑定、篡改检测、分片提交顺序、命令幂等、同步状态不含密钥、生产代码不含默认中继地址。安装态发布验收还会检查发现文件、旧 token 失效、stdio bridge 和 `%LOCALAPPDATA%\AyanamiTaskManager\docs`。
