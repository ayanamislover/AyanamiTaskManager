import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("generated MCP README documentation", () => {
  it("labels ADR-006's old cap as historical and points current facts to generation", () => {
    const adr = readFileSync(resolve("docs", "adr", "ADR-006-compact-mcp.md"), "utf8");
    expect(adr).toContain("Amended 2026-09-21（F08）");
    expect(adr).toContain("MCP_TOOL_STATS");
    expect(adr).toContain("MCP_SCHEMA_LIMIT_BYTES - MCP_SCHEMA_RESERVE_BYTES");
    expect(adr).not.toContain("正式 MCP 工具面固定不超过 12 个工具");
  });
});
