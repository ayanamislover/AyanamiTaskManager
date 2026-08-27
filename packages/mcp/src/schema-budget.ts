export const MCP_SCHEMA_LIMIT_BYTES = 8_192;
export const MCP_SCHEMA_RESERVE_BYTES = 512;
// The legacy surface is only a migration bridge for clients created before the
// core/memory split. It is not advertised or written by current installers.
// Keep its 1.0.18 size as a hard, non-growing ceiling until the compatibility
// entrypoint is removed; every supported profile must still obey the normal
// 7,680-byte budget below.
export const MCP_LEGACY_SCHEMA_TRANSITION_MAX_BYTES = 11_064;

export function mcpSchemaBytes(tools: unknown): number {
  return Buffer.byteLength(JSON.stringify(tools), "utf8");
}

export function assertMcpSchemaBudget(tools: unknown): {
  bytes: number;
  limitBytes: number;
  reserveBytes: number;
  usableBytes: number;
} {
  const bytes = mcpSchemaBytes(tools);
  const usableBytes = MCP_SCHEMA_LIMIT_BYTES - MCP_SCHEMA_RESERVE_BYTES;
  if (bytes > usableBytes) {
    throw new Error(
      `MCP_SCHEMA_BUDGET_EXCEEDED: ${bytes} bytes exceeds ${usableBytes} usable bytes ` +
        `(${MCP_SCHEMA_RESERVE_BYTES} bytes reserved from ${MCP_SCHEMA_LIMIT_BYTES})`,
    );
  }
  return {
    bytes,
    limitBytes: MCP_SCHEMA_LIMIT_BYTES,
    reserveBytes: MCP_SCHEMA_RESERVE_BYTES,
    usableBytes,
  };
}

export function assertLegacyMcpSchemaTransitionBudget(tools: unknown): {
  bytes: number;
  maxBytes: number;
  overUsableBytes: number;
} {
  const bytes = mcpSchemaBytes(tools);
  if (bytes > MCP_LEGACY_SCHEMA_TRANSITION_MAX_BYTES) {
    throw new Error(
      `MCP_LEGACY_SCHEMA_TRANSITION_BUDGET_EXCEEDED: ${bytes} bytes exceeds the ` +
        `${MCP_LEGACY_SCHEMA_TRANSITION_MAX_BYTES}-byte 1.0.18 compatibility ceiling`,
    );
  }
  return {
    bytes,
    maxBytes: MCP_LEGACY_SCHEMA_TRANSITION_MAX_BYTES,
    overUsableBytes: Math.max(
      0,
      bytes - (MCP_SCHEMA_LIMIT_BYTES - MCP_SCHEMA_RESERVE_BYTES),
    ),
  };
}
