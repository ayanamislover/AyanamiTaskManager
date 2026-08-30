# 本地安全模型

本文描述 ATM 当前实现实际提供的防护边界。它是本地单用户桌面应用的安全契约，不是互联网多租户服务的威胁模型。

## 受保护的边界

### 服务发现与调用认证

- daemon 只监听 `127.0.0.1`，API 使用运行时选择的独立端口；`9999` 仅是源码开发时的 Web 前端端口。
- 正式桌面 daemon 每次启动都会生成新的 Bearer token，并原子发布到 `<数据目录>\runtime\daemon.json`。发现文件同时绑定 `endpoint`、`pid`、`version`、`startedAt` 和随机 `instanceId`；正常退出会清除它，旧 token 在重启后失效。standalone 开发入口仅在显式设置 `AYANAMI_TASK_TOKEN` 时允许固定测试 token，正式桌面 host 明确忽略该 override。
- 自动安装的 Agent 配置使用 stdio bridge，bridge 每次请求都重新读取并校验发现文件，因此配置不持久化 endpoint/token，也能跨 daemon 重启恢复。
- REST 在认证前拒绝非 localhost/127.0.0.1 的浏览器 `Origin`；错误响应不回显当前或调用方提供的 token。WebSocket 必须在 3 秒内完成认证；错误 token 或超时以 `1008` 关闭，认证成功前不发送业务事件。认证前的非法 JSON 只返回有界协议错误，不会得到业务数据。
- 打包 Renderer 不接收原始 endpoint/token，只通过 Preload 暴露的有界 Main-process API capability 访问 `/api/v1/*`；跨源导航和新窗口被拒绝。

Bearer token 是本地调用认证凭据。不要把它写入仓库、日志、ATM Record、对话、命令行参数或长期 Agent 配置。只有用户明确复制“当前运行实例”的 Streamable HTTP 配置时，该临时配置才会包含当前 token。

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
- 把本机 loopback 服务直接暴露到局域网或互联网后的安全性。

若需要跨用户、跨主机或不受信插件隔离，应在 ATM 外部增加操作系统账户边界、文件 ACL、进程隔离和受认证的远程网关，不能把本模型外推为远程安全承诺。

## 自动化守卫

仓库测试绑定以下事实：loopback runtime descriptor schema 与 token 轮换、foreign Origin/错误 Bearer、WebSocket 认证超时与认证前零业务帧、迁移根 containment、生产 SQL 无 `ATTACH DATABASE`、项目 mutation 回滚/outbox 重试，以及随包 Guide/docs 的精确 manifest。安装态发布验收还会检查发现文件、旧 token 失效、stdio bridge 和 `%LOCALAPPDATA%\AyanamiTaskManager\docs`。
