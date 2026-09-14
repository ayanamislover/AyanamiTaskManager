import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { KnowledgeGetInputSchema } from "@ayanami-task/protocol";
import type { AyanamiTaskService } from "@ayanami-task/application";
import { createAyanamiMcpServer } from "../src/index.js";
import { MCP_KNOWLEDGE_GET_MAX_CHARS } from "../src/tools/memory/knowledge-get.js";

function maximum(schema: unknown, field: string): number {
  const properties = (schema as { properties?: Record<string, { maximum?: number }> }).properties;
  const value = properties?.[field]?.maximum;
  if (typeof value !== "number") throw new Error(`NO_MAXIMUM:${field}`);
  return value;
}

describe("知识读取的上下文预算", () => {
  it("MCP 侧 max_chars 与其余读工具同一上限，且不跟着协议层的管理视图放宽", async () => {
    const server = createAyanamiMcpServer({} as AyanamiTaskService, { profile: "memory" });
    const client = new Client({ name: "knowledge-budget", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
      const knowledgeGet = tools.get("atm_knowledge_get");
      const search = tools.get("atm_search");
      expect(knowledgeGet && search).toBeTruthy();

      // 同一个 profile 里的读工具对 agent 上下文用同一把尺子。
      expect(maximum(knowledgeGet!.inputSchema, "max_chars")).toBe(MCP_KNOWLEDGE_GET_MAX_CHARS);
      expect(maximum(knowledgeGet!.inputSchema, "max_chars")).toBe(
        maximum(search!.inputSchema, "max_chars"),
      );

      // 阳性对照：协议层故意留着更宽的上限给 REST 管理视图（桌面 readFullEntry 靠它
      // 一次取全文）。这两个值本来就该不一样——哪天它们相等了，说明有人把其中一侧
      // 顺手对齐掉了，那时要先决定动的是哪一侧，而不是让这条断言默默失去意义。
      const canonical = KnowledgeGetInputSchema.shape.maxChars;
      expect(canonical.safeParse(MCP_KNOWLEDGE_GET_MAX_CHARS + 1).success).toBe(true);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
