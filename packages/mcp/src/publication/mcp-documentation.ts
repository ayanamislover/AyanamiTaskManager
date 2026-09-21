import type { AyanamiToolProfile, ToolDefinitionRegistry } from "../tool-registry.js";
import { publishedTools } from "../tool-publication.js";
import {
  assertMcpSchemaBudget,
  MCP_SCHEMA_LIMIT_BYTES,
  MCP_SCHEMA_RESERVE_BYTES,
} from "../schema-budget.js";

/** Canonical documentation order; all counts and bytes still come from the registry. */
export const MCP_FORMAL_PROFILES = [
  "core",
  "memory",
  "actions",
] as const satisfies readonly AyanamiToolProfile[];

export type McpFormalProfile = (typeof MCP_FORMAL_PROFILES)[number];

export const MCP_TOOL_STATS_DOCUMENTATION_BEGIN = "<!-- MCP_TOOL_STATS:BEGIN -->";
export const MCP_TOOL_STATS_DOCUMENTATION_END = "<!-- MCP_TOOL_STATS:END -->";

export type McpProfileBudget = {
  readonly profile: McpFormalProfile;
  readonly toolCount: number;
  readonly descriptorBytes: number;
  readonly usableBytes: number;
  readonly remainingBytes: number;
};

export type McpBudgetReport = {
  readonly surfaceVersion: number;
  readonly profileCount: number;
  readonly toolCount: number;
  readonly limitBytes: number;
  readonly reserveBytes: number;
  readonly usableBytes: number;
  readonly profiles: readonly McpProfileBudget[];
};

/**
 * Calculate documentation facts from the same published registry and budget guard used by MCP.
 * Keeping this calculation here prevents README/ADR prose from growing a second tool list.
 */
export function mcpBudgetReport(
  registry: ToolDefinitionRegistry,
  surfaceVersion: number,
): McpBudgetReport {
  const profiles = MCP_FORMAL_PROFILES.map((profile) => {
    const tools = publishedTools(registry, profile, surfaceVersion);
    const budget = assertMcpSchemaBudget(tools);
    return {
      profile,
      toolCount: tools.length,
      descriptorBytes: budget.bytes,
      usableBytes: budget.usableBytes,
      remainingBytes: budget.usableBytes - budget.bytes,
    } satisfies McpProfileBudget;
  });

  return {
    surfaceVersion,
    profileCount: profiles.length,
    toolCount: profiles.reduce((total, profile) => total + profile.toolCount, 0),
    limitBytes: MCP_SCHEMA_LIMIT_BYTES,
    reserveBytes: MCP_SCHEMA_RESERVE_BYTES,
    usableBytes: MCP_SCHEMA_LIMIT_BYTES - MCP_SCHEMA_RESERVE_BYTES,
    profiles,
  };
}

function formatBytes(bytes: number): string {
  return `${bytes.toLocaleString("en-US")} bytes`;
}

/** Render the README section between MCP_TOOL_STATS markers. */
export function generateMcpToolStatsDocumentation(
  registry: ToolDefinitionRegistry,
  surfaceVersion: number,
): string {
  const report = mcpBudgetReport(registry, surfaceVersion);
  return [
    MCP_TOOL_STATS_DOCUMENTATION_BEGIN,
    "",
    "### MCP 工具面统计（生成）",
    "",
    "> 以下数字由 `ToolDefinitionRegistry` 的已发布工具和 `schema-budget.ts` 生成；运行 `pnpm generate:mcp-contracts` 更新。",
    "",
    "<!-- prettier-ignore -->",
    "| 指标 | 当前值 |",
    "| --- | ---: |",
    `| MCP surface | v${report.surfaceVersion} |`,
    `| 正式 Profile 数 | ${report.profileCount} |`,
    `| 正式工具总数 | ${report.toolCount} |`,
    `| 每个 Profile schema 上限 | ${formatBytes(report.limitBytes)} |`,
    `| 每个 Profile 预留 | ${formatBytes(report.reserveBytes)} |`,
    `| 每个 Profile 可用预算 | ${formatBytes(report.usableBytes)} |`,
    "",
    "<!-- prettier-ignore -->",
    "| Profile | 工具数 | Descriptor bytes | 可用预算 | 余量 |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...report.profiles.map(
      (profile) =>
        `| ${profile.profile} | ${profile.toolCount} | ${formatBytes(profile.descriptorBytes)} | ${formatBytes(profile.usableBytes)} | ${formatBytes(profile.remainingBytes)} |`,
    ),
    "",
    MCP_TOOL_STATS_DOCUMENTATION_END,
  ].join("\n");
}
