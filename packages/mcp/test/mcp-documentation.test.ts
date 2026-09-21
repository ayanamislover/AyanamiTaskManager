import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AyanamiTaskService } from "@ayanami-task/application";
import { describe, expect, it } from "vitest";
import { createAyanamiToolRegistry, MCP_SURFACE_VERSION } from "../src/index.js";
import {
  generateMcpToolStatsDocumentation,
  MCP_TOOL_STATS_DOCUMENTATION_BEGIN,
  MCP_TOOL_STATS_DOCUMENTATION_END,
} from "../src/publication/mcp-documentation.js";

function markedSection(content: string): string {
  const start = content.indexOf(MCP_TOOL_STATS_DOCUMENTATION_BEGIN);
  const end = content.indexOf(MCP_TOOL_STATS_DOCUMENTATION_END);
  if (start < 0 || end < start) throw new Error("MCP_TOOL_STATS_MARKERS_MISSING");
  return content.slice(start, end + MCP_TOOL_STATS_DOCUMENTATION_END.length);
}

function expectedDocumentation(): string {
  const registry = createAyanamiToolRegistry({} as AyanamiTaskService);
  return generateMcpToolStatsDocumentation(registry, MCP_SURFACE_VERSION);
}

describe("generated MCP README documentation", () => {
  it("keeps README tool counts and budget facts on the published registry", () => {
    const expected = expectedDocumentation();
    const readme = readFileSync(resolve("README.md"), "utf8");
    expect(markedSection(readme)).toBe(expected);
  });

  it("turns red when a README number is manually changed", () => {
    const expected = expectedDocumentation();
    const readme = readFileSync(resolve("README.md"), "utf8");
    const mutation = expected.replace(/\d/u, (digit) => (digit === "9" ? "8" : "9"));
    expect(mutation).not.toBe(expected);

    const staleReadme = readme.replace(expected, mutation);
    expect(staleReadme).not.toBe(readme);
    expect(() => expect(markedSection(staleReadme)).toBe(expected)).toThrow();
  });

  it("labels ADR-006's old cap as historical and points current facts to generation", () => {
    const adr = readFileSync(resolve("docs", "adr", "ADR-006-compact-mcp.md"), "utf8");
    expect(adr).toContain("Amended 2026-09-21（F08）");
    expect(adr).toContain("MCP_TOOL_STATS");
    expect(adr).toContain("MCP_SCHEMA_LIMIT_BYTES - MCP_SCHEMA_RESERVE_BYTES");
    expect(adr).not.toContain("正式 MCP 工具面固定不超过 12 个工具");
  });
});
