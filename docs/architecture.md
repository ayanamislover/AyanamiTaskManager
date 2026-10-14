# 架构

## 运行边界

3.0 的生产桌面是一个原生宿主进程加系统 WebView2（[ADR-016](./adr/ADR-016-native-host.md)），不再有 Node 子进程：

- **宿主**（Rust，`apps/desktop/native/host`）：单实例、窗口（系统 WebView2）、托盘、登录自启动、更新与安装状态准入；
  本地服务也运行在这个进程里——数据库生命周期、Agent HTTP、Agent 接入与诊断，以及默认关闭的手机同步与 Claude 派单（[mobile-sync.md](./mobile-sync.md)）。
- **Renderer**（WebView2）：不接收原始 endpoint/token；只通过宿主注入的 `window.ayanamiDesktop` 窄 capability 发消息，由宿主进程内的 ui-bridge 以 User 身份分发有界 `/api/v1/*` 请求和系统操作。只接受入口文档的消息，跨源导航和新窗口被拒绝。
- **`atm.exe`**（CLI，`AyanamiTaskManager.exe --cli` 转发给它）与 **`atm-mcp.exe`**（Agent 的 stdio 桥）是按需启动的短进程，经 `runtime\daemon.json` 找到服务，只带 Agent 凭证。

安装、更新、修复和卸载由事务式安装器 `atm-setup.exe` 负责；安装根的启动器在事务未完成时挡住启动。`apps/daemon` 是 2.x 的 TS 实现，只用于测试与开发。完整威胁边界见 [security-model.md](./security-model.md)。

```text
Renderer ── ui-bridge (User)      atm-mcp.exe / atm.exe ── Agent HTTP (127.0.0.1)
                    │                          │
                    └──────── atm-service ─────┘
                                  │
                     atm-domain 规则 + 写事务
                                  │
                    atm-store（单写线程 + 只读连接池）
                                  │
                           data\atm.sqlite
```

## 分层

原生代码在 `apps/desktop/native/`，每层一个 crate：

- `domain`：领域规则、状态机、能力目录与错误码；不依赖存储。
- `store`：单库存储、迁移、整库备份与按范围恢复、离线整库恢复、2.x 数据转换与项目包。
- `service`：用例。每个入口先做能力检查，一次服务调用就是一个写事务。
- `http`：Agent HTTP 与 MCP 工具表，只产生 Agent 主体；`ui-bridge`：界面请求的进程内分发，User 主体只在这里构造。
- `runtime`：准入、启动判定与转换、发布 `daemon.json`、起停调度；`jobs`：定时维护与过期 session 扫描。
- `cli`（`atm.exe`）、`mcp-shim`（`atm-mcp.exe`）：薄适配器，只经 Agent HTTP 调服务。
- `agents`、`sync`、`dispatch`、`metrics`：Agent 配置、手机同步、Claude 派单、工程统计。
- `host`、`launcher`、`setup`、`install-state`：宿主、根启动器、安装器与安装状态。

TS 包里 `packages/ui`（连同它依赖的 `client`、`protocol`）是 Renderer；`apps/daemon`、`packages/mcp`、`packages/storage-sqlite` 等是 2.x 的 Node 实现，3.0 只拿它们生成 2.x 夹具与跨实现对照。

正式写入只触碰一个库、一个事务：领域状态、事件、全局事件流、搜索索引与幂等回执一起提交，失败整体回滚；没有 outbox 与投影补投。任何客户端都不能直接写 SQLite。

## 界面刷新

3.0 不提供 WebSocket 事件流（`/api/v1/ws` 返回 404）。界面每 30 秒以及窗口重新获得焦点时重新读取；读的就是事实源本身，不存在投影滞后。

下面的 WebSocket 断流与恢复契约只适用于 2.x 与 standalone 开发 daemon（`apps/daemon`）：

`/api/v1/ws?scope=global|project:CODE&since=N` 在认证后按序补发事件；每个连接只有一个发送泵，先订阅再补齐历史。`since` 是客户端已处理的最后序号，不是服务端已写入 socket 的最后序号。

- 发送泵逐帧等待 flush 回调。慢客户端不读取时，通常先触发 **5 秒发送超时**，服务端释放订阅、停止泵并以 **1011** 发起关闭；错误帧也可能无法送达，不能依赖一定收到 `STREAM_FAILED`。
- 用户态发送缓冲超过 1 MiB 时，尝试发送 `resync_required`，随后以 **1013** 发起关闭。这主要是并发 ping/错误回复等堆积的保护，不是逐帧发送泵的主要慢客户端路径。
- 接入消费端时，对 1011、1013 和传输异常断开采用有界退避并重新认证，从**已成功处理**的 `since` 续读；不要因未收到 `resync_required` 就认为没有漏读。缓冲阻塞或网络断开可能让客户端只观察到异常断开而非关闭码。
- 认证拒绝/超时的 1008 不应使用同一个无效凭据无限重试；重新发现当前运行实例后再连接。事件序号不属于跨数据库恢复的永久标识，恢复或数据根变化后应重新同步状态。

回归 `apps/daemon/test/websocket-slow-consumer.test.ts` 使用真实 TCP 握手、认证后暂停读取、256 KiB 有界事件供应，验证实际线上关闭帧为 1011、订阅恰好释放一次、泵停止，并用原 `since` 重连补齐。它不模拟 socket 的 send/flush，也不替代长期压力测试。

## 本地共享知识库

知识表与项目数据同在 `data\atm.sqlite`，但是独立的范围：它不属于某个项目，不借用 `Record.scope`，也不另起常驻进程。备份是整库的，恢复时可以只选“知识库”范围。

SQLite 是唯一事实源；Markdown 文件只用于显式导入/导出。知识元数据和正文一起形成不可变修订；保存以一笔 SQLite 事务提交 head、revision、FTS、目录序列和幂等回执。只读 MCP 先检索元数据，再按永久条目 ID 和 `revisionId` 读取正文，不自动进入 `begin/brief`。`atm_knowledge_save` 从活动 Session 验证作者后直接发布，更新以不可变旧 revisionId 做乐观锁；知识保存不写项目数据，不需要用户逐篇手工批准。

Record 提炼先读出同一快照下的来源 ID/版本和预览，用户编辑确认后另行保存知识；这是两次独立的写入，也不自动传播源 Record 的后续修改。存储在本机不意味着内容不会进入云端模型上下文：调用知识读取工具时，返回的正文会发送给当前 Agent。
