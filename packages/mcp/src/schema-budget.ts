export const MCP_SCHEMA_LIMIT_BYTES = 8_192;
export const MCP_SCHEMA_RESERVE_BYTES = 512;

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
