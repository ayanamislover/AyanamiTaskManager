import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AyanamiTaskService } from "@ayanami-task/application";
import { createAyanamiMcpServer } from "../src/index.js";
import {
  assertLegacyMcpSchemaTransitionBudget,
  assertMcpSchemaBudget,
  MCP_LEGACY_SCHEMA_TRANSITION_MAX_BYTES,
  mcpSchemaBytes,
} from "../src/schema-budget.js";

async function listProfile(profile: "core" | "memory" | "legacy") {
  const server = createAyanamiMcpServer({} as AyanamiTaskService, { profile });
  const client = new Client({ name: `profile-${profile}`, version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    server,
    tools: (await client.listTools()).tools,
  };
}

describe("MCP static profiles", () => {
  it("publishes disjoint core and memory surfaces whose union is the full 11-tool capability", async () => {
    const core = await listProfile("core");
    const memory = await listProfile("memory");
    const legacy = await listProfile("legacy");
    try {
      expect(core.tools.map((tool) => tool.name)).toEqual([
        "atm_begin",
        "atm_brief",
        "atm_task_list",
        "atm_task_get",
        "atm_task_create",
        "atm_end",
      ]);
      expect(memory.tools.map((tool) => tool.name)).toEqual([
        "atm_task_patch",
        "atm_progress_add",
        "atm_record",
        "atm_search",
        "atm_delta",
      ]);
      const coreNames = new Set(core.tools.map((tool) => tool.name));
      const memoryNames = new Set(memory.tools.map((tool) => tool.name));
      expect([...coreNames].filter((name) => memoryNames.has(name))).toEqual([]);
      expect(new Set([...coreNames, ...memoryNames])).toHaveLength(11);
      expect(mcpSchemaBytes(core.tools)).toBeLessThanOrEqual(7680);
      expect(mcpSchemaBytes(memory.tools)).toBeLessThanOrEqual(7680);
      expect(() => assertMcpSchemaBudget(core.tools)).not.toThrow();
      expect(() => assertMcpSchemaBudget(memory.tools)).not.toThrow();
      expect(core.client.getInstructions()).toContain("core profile");
      expect(memory.client.getInstructions()).toContain("memory profile");
      expect(new Set(legacy.tools.map((tool) => tool.name))).toEqual(
        new Set([...core.tools.map((tool) => tool.name), ...memory.tools.map((tool) => tool.name)]),
      );
      expect(legacy.tools).toHaveLength(11);
      expect(legacy.client.getInstructions()).toContain("兼容入口");
      expect(legacy.client.getInstructions()).toContain("重启");
      expect(assertLegacyMcpSchemaTransitionBudget(legacy.tools)).toEqual({
        bytes: MCP_LEGACY_SCHEMA_TRANSITION_MAX_BYTES,
        maxBytes: MCP_LEGACY_SCHEMA_TRANSITION_MAX_BYTES,
        overUsableBytes: 3384,
      });
      // 阳性对照：legacy 是有审计记录的过渡例外，不是无上限的第三个 Profile。
      expect(() =>
        assertLegacyMcpSchemaTransitionBudget([
          ...legacy.tools,
          { name: "legacy-growth-must-fail", inputSchema: {} },
        ]),
      ).toThrow(/MCP_LEGACY_SCHEMA_TRANSITION_BUDGET_EXCEEDED/u);

      expect(
        (
          await core.client.callTool({
            name: "atm_record",
            arguments: {},
          })
        ).isError,
      ).toBe(true);
      expect(
        (
          await memory.client.callTool({
            name: "atm_task_list",
            arguments: {},
          })
        ).isError,
      ).toBe(true);
    } finally {
      await Promise.all([core.client.close(), core.server.close()]);
      await Promise.all([memory.client.close(), memory.server.close()]);
      await Promise.all([legacy.client.close(), legacy.server.close()]);
    }
  });
});
