# ADR-006：紧凑 MCP 与序列增量读取

状态：Accepted

MCP 固定不超过 11 个工具，默认短字段、批量 mutation、短 ACK、`since_seq` delta 和显式 detail view。使用官方 `@modelcontextprotocol/sdk`，因为 Streamable HTTP、stdio、output schema 与协议兼容性不适合自研；Zod 作为唯一运行时 schema，防止 CLI/REST/MCP 漂移。
