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

## 本地共享知识库

同一个 ApplicationService 通过 `knowledge` 用例访问独立的 `<dataDir>/knowledge/knowledge.sqlite`。它不属于某个项目，不借用 `Record.scope`，也不另起常驻进程。数据库按需打开；损坏只影响知识功能，不阻止任务和 Session。`doctor` 单独报告知识库健康。

SQLite 是唯一事实源；Markdown 文件只用于显式导入/导出。知识元数据和正文一起形成不可变修订；保存以一笔 SQLite 事务提交 head、revision、FTS、catalog sequence 和幂等回执。只读 MCP 先检索元数据，再按永久条目 ID 和 `revisionId` 读取正文，不自动进入 `begin/brief`。`atm_knowledge_save` 从活动 Session 验证作者后直接发布，更新以不可变旧 revisionId 做乐观锁；知识事务不同时写入项目库，不需要用户逐篇手工批准。

Record 提炼先读出同一快照下的来源 ID/版本和预览，用户编辑确认后另行保存知识；这不是跨库事务，也不自动传播源 Record 的后续修改。存储在本机不意味着内容不会进入云端模型上下文：调用知识读取工具时，返回的正文会发送给当前 Agent。
