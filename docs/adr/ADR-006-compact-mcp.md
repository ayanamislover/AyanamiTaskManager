# ADR-006：紧凑 MCP 与序列增量读取

状态：Accepted

> **Amended 2026-09-21（F08）：** 本 ADR 中关于 v4 的工具数和预算是历史决策，不是当前硬编码上限。正式 Profile 的当前工具数、descriptor bytes、可用预算和余量，必须由 `ToolDefinitionRegistry` 与 `schema-budget.ts` 生成到 README 的 `MCP_TOOL_STATS` 标记区块，并与 generated contract 一起更新；不要在 ADR 或 README 另写一份会漂移的永久数字。约束本身仍是每个正式 Profile 不得超过 `MCP_SCHEMA_LIMIT_BYTES - MCP_SCHEMA_RESERVE_BYTES`，预算守卫和文档一致性测试负责发现漂移。

正式 MCP 工具面在 v4 曾固定不超过 12 个工具，默认短字段、批量 mutation、短 ACK、`since_seq` delta 和显式 detail view。v4 的第 12 个工具是只写本机项目 Record 的 `atm_feedback`；它放在仍有描述符预算的 memory Profile，避免 core Profile 因超出可用预算而把可读 schema 退化为 `$ref`。当时可用预算为 `MCP_SCHEMA_LIMIT_BYTES - MCP_SCHEMA_RESERVE_BYTES` 的 7,680 字节；2026-09-18 将实际可用预算调整到 9,728，因为 core 长期只剩 51 字节余量，工具描述被压成半句话，而描述是所有客户端都会显示、Agent 判断怎么调用的唯一依据。调整依据是 legacy 工具面 11,064 字节自 1.0.18 起就在真实客户端上发布并被消费。无 Profile 的 legacy v1.0.18 artifact 继续逐字节冻结为原 11 工具，不随正式工具面增长。使用官方 `@modelcontextprotocol/sdk`，因为 Streamable HTTP、stdio、output schema 与协议兼容性不适合自研；Zod 作为唯一运行时 schema，防止 CLI/REST/MCP 漂移。
