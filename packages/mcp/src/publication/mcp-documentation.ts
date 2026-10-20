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
