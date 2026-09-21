# 架构

## 运行边界

Electron Main 是生产常驻宿主，负责单实例、托盘、登录自启动、Fastify 服务与数据库生命周期。Renderer 开启 `contextIsolation`、关闭 Node Integration，不接收原始 endpoint/token；它只通过 Preload 的窄 capability 让 Main process 代理有界 `/api/v1/*` 请求和系统操作。`apps/daemon` 可独立启动，只用于测试与开发。完整威胁边界见 [security-model.md](./security-model.md)。

```text
Renderer / MCP stdio / atm CLI
             │
       REST + WebSocket
             │
      ApplicationService
             │
   Domain rules + transactions
             │
 RegistryDatabaseManager ─ ProjectDatabaseManager(LRU)
             │                  │
      registry.sqlite      project.sqlite × N
```

## 分层

- `protocol`：Zod schema、稳定 DTO、枚举与中文标签。
- `domain`：纯状态机、进度、完成门槛、循环检测、项目代码和评分。
- `storage-sqlite`：数据库工厂、迁移、Repository、在线备份、恢复和 FTS。
- `application`：用例、actor、版本/幂等、事务事件/outbox、投影与上下文包。
- `daemon`：Fastify REST、WebSocket、健康检查和静态 Renderer。
- `mcp` / `cli` / `client`：薄适配器，只调用公共应用服务或 REST。
- `desktop`：Electron 生命周期与安全边界。

正式项目写入只触碰一个项目库。Registry 摘要由项目 outbox 在提交后更新；失败不回滚项目事实，启动时按项目序列补投。任何客户端都不能直接写 SQLite。

## WebSocket 断流与恢复契约

`/api/v1/ws?scope=global|project:CODE&since=N` 在认证后按序补发事件；每个连接只有一个发送泵，先订阅再补齐历史。`since` 是客户端已处理的最后序号，不是服务端已写入 socket 的最后序号。

- 发送泵逐帧等待 flush 回调。慢客户端不读取时，通常先触发 **5 秒发送超时**，服务端释放订阅、停止泵并以 **1011** 发起关闭；错误帧也可能无法送达，不能依赖一定收到 `STREAM_FAILED`。
- 用户态发送缓冲超过 1 MiB 时，尝试发送 `resync_required`，随后以 **1013** 发起关闭。这主要是并发 ping/错误回复等堆积的保护，不是逐帧发送泵的主要慢客户端路径。
- 接入消费端时，对 1011、1013 和传输异常断开采用有界退避并重新认证，从**已成功处理**的 `since` 续读；不要因未收到 `resync_required` 就认为没有漏读。缓冲阻塞或网络断开可能让客户端只观察到异常断开而非关闭码。
- 认证拒绝/超时的 1008 不应使用同一个无效凭据无限重试；重新发现当前运行实例后再连接。事件序号不属于跨数据库恢复的永久标识，恢复或数据根变化后应重新同步状态。

正式回归 `apps/daemon/test/websocket-slow-consumer.test.ts` 使用真实 TCP 握手、认证后暂停读取、256 KiB 有界事件供应，验证实际线上关闭帧为 1011、订阅恰好释放一次、泵停止，并用原 `since` 重连补齐。它不模拟 socket 的 send/flush，也不替代长期压力测试。

## 本地共享知识库

同一个 ApplicationService 通过 `knowledge` 用例访问独立的 `<dataDir>/knowledge/knowledge.sqlite`。它不属于某个项目，不借用 `Record.scope`，也不另起常驻进程。数据库按需打开；损坏只影响知识功能，不阻止任务和 Session。`doctor` 单独报告知识库健康。

SQLite 是唯一事实源；Markdown 文件只用于显式导入/导出。知识元数据和正文一起形成不可变修订；保存以一笔 SQLite 事务提交 head、revision、FTS、catalog sequence 和幂等回执。只读 MCP 先检索元数据，再按永久条目 ID 和 `revisionId` 读取正文，不自动进入 `begin/brief`。`atm_knowledge_save` 从活动 Session 验证作者后直接发布，更新以不可变旧 revisionId 做乐观锁；知识事务不同时写入项目库，不需要用户逐篇手工批准。

Record 提炼先读出同一快照下的来源 ID/版本和预览，用户编辑确认后另行保存知识；这不是跨库事务，也不自动传播源 Record 的后续修改。存储在本机不意味着内容不会进入云端模型上下文：调用知识读取工具时，返回的正文会发送给当前 Agent。
