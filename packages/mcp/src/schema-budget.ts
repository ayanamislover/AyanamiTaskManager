/**
 * 每个 Profile 的 tools/list 上限。
 *
 * 这个数管的不是协议，而是两件事：Agent 每次会话都要为它付上下文，以及
 * publishedTools 一旦超预算就会退回 $defs 去重，把枚举和联合类型渲染成 `{}`。
 * 所以它既不能太松，也不该紧到把工具描述挤没——描述是所有 MCP 客户端都会显示、
 * Agent 真正拿来判断怎么调用的那一行，挤掉它省下的字节会以试错往返的形式加倍还回来。
 *
 * 原来是 8,192。core 长期贴着上限跑（7,629 / 7,680，只剩 51 字节），于是
 * atm_begin 的描述被压成「直接使用返回的 brief」这样的半句话，atm_end 也没地方
 * 写明 outcome 是唯一一个小写枚举——两个使用 ATM 的 Agent 会话各自因此白跑了往返。
 *
 * 10,240 不是随手抬的：不带 Profile 的 legacy 工具面是 11,064 字节，在 1.0.18
 * 起就在真实客户端上发布并被消费，所以这个量级的 tools/list 早有实证。抬到
 * 10,240 之后 legacy 仍然超出正式预算，那条「legacy 是有意保留的过渡例外」
 * 的结论不变。
 */
export const MCP_SCHEMA_LIMIT_BYTES = 10_240;
export const MCP_SCHEMA_RESERVE_BYTES = 512;
// The legacy surface is only a migration bridge for clients created before the
// core/memory split. It is not advertised or written by current installers.
// Keep its 1.0.18 size as a hard, non-growing ceiling until the compatibility
// entrypoint is removed; every supported profile must still obey the normal
// 9,728-byte budget below.
export const MCP_LEGACY_SCHEMA_TRANSITION_MAX_BYTES = 11_064;

export function mcpSchemaBytes(tools: unknown): number {
  return Buffer.byteLength(JSON.stringify(tools), "utf8");
}

export function mcpSchemaBreakdown(tools: readonly unknown[]): {
  bytes: number;
  framingBytes: number;
  descriptors: Array<{ name: string; bytes: number }>;
} {
  const descriptors = tools.map((tool, index) => ({
    name:
      tool && typeof tool === "object" && "name" in tool
        ? String((tool as { name?: unknown }).name)
        : `#${index}`,
    bytes: mcpSchemaBytes(tool),
  }));
  const bytes = mcpSchemaBytes(tools);
  return {
    bytes,
    framingBytes: bytes - descriptors.reduce((total, descriptor) => total + descriptor.bytes, 0),
    descriptors,
  };
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
    overUsableBytes: Math.max(0, bytes - (MCP_SCHEMA_LIMIT_BYTES - MCP_SCHEMA_RESERVE_BYTES)),
  };
}
