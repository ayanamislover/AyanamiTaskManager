# 架构

## 运行边界

Electron Main 是生产常驻宿主，负责单实例、托盘、登录自启动、Fastify 服务与数据库生命周期。Renderer 开启 `contextIsolation`、关闭 Node Integration，通过 Preload 窄接口获得本地服务地址和系统操作。`apps/daemon` 可独立启动，只用于测试与开发。

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
