# ADR-006：紧凑 MCP 与序列增量读取

状态：Accepted

正式 MCP 工具面固定不超过 12 个工具，默认短字段、批量 mutation、短 ACK、`since_seq` delta 和显式 detail view。v4 的第 12 个工具是只写本机项目 Record 的 `atm_feedback`；它放在仍有描述符预算的 memory Profile，避免 core Profile 因超出可用预算而把可读 schema 退化为 `$ref`。可用预算为 `MCP_SCHEMA_LIMIT_BYTES - MCP_SCHEMA_RESERVE_BYTES`；2026-09-18 从 7,680 抬到 9,728，因为 core 长期只剩 51 字节余量，工具描述被压成半句话，而描述是所有客户端都会显示、Agent 判断怎么调用的唯一依据。抬高的依据是 legacy 工具面 11,064 字节自 1.0.18 起就在真实客户端上发布并被消费。无 Profile 的 legacy v1.0.18 artifact 继续逐字节冻结为原 11 工具，不随正式工具面增长。使用官方 `@modelcontextprotocol/sdk`，因为 Streamable HTTP、stdio、output schema 与协议兼容性不适合自研；Zod 作为唯一运行时 schema，防止 CLI/REST/MCP 漂移。
