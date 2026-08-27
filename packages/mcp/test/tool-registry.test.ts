import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AyanamiTaskService } from "@ayanami-task/application";
import { describe, expect, it } from "vitest";
import { createAyanamiMcpServer, createAyanamiToolRegistry } from "../src/index.js";

const productionFiles = [
  "packages/mcp/src/index.ts",
  "packages/mcp/src/tool-registry.ts",
  "packages/mcp/src/tool-publication.ts",
] as const;

const forbiddenPrivatePatterns = [
  { label: "SDK private registry", pattern: /_registeredTools/u },
  { label: "post-registration handler rewrite", pattern: /\.handler\s*=/u },
  { label: "post-registration enabled rewrite", pattern: /\.enabled\s*=/u },
  {
    label: "manual JSON schema path mutation",
    pattern: /\b(?:schema|item)\.properties(?:\.|\[)/u,
  },
] as const;

function assertPublicRegistrationOnly(source: string): void {
  for (const forbidden of forbiddenPrivatePatterns) {
    if (forbidden.pattern.test(source)) {
      throw new Error(`PRIVATE_TOOL_CHANNEL:${forbidden.label}`);
    }
  }
}

describe("explicit ToolDefinition registry", () => {
  it("keeps production code off SDK private channels and proves the guard turns red", () => {
    const source = productionFiles.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(() => assertPublicRegistrationOnly(source)).not.toThrow();

    for (const forbidden of forbiddenPrivatePatterns) {
      const mutation =
        forbidden.label === "SDK private registry"
          ? "server._registeredTools"
          : forbidden.label === "post-registration handler rewrite"
            ? "tool.handler = wrapped"
            : forbidden.label === "post-registration enabled rewrite"
              ? "tool.enabled = false"
              : "schema.properties.items.maxItems = 1";
      expect(() => assertPublicRegistrationOnly(`${source}\n${mutation}`)).toThrow(
        `PRIVATE_TOOL_CHANNEL:${forbidden.label}`,
      );
    }
  });

  it("publishes through the SDK public low-level Server without private registry access", () => {
    const source = productionFiles.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(source).toContain('import { Server } from "@modelcontextprotocol/sdk/server/index.js"');
    expect(source).toContain("server.setRequestHandler(ListToolsRequestSchema");
    expect(source).toContain("server.setRequestHandler(CallToolRequestSchema");
  });

  it("derives each SDK profile's tools/list from the same immutable definitions", async () => {
    const service = {} as AyanamiTaskService;
    const registry = createAyanamiToolRegistry(service);
    const all = registry.definitions();
    expect(Object.isFrozen(all)).toBe(true);
    expect(all.every((definition) => Object.isFrozen(definition))).toBe(true);
    expect(all).toHaveLength(11);
    expect(new Set(all.map((definition) => definition.name))).toHaveLength(11);
    expect(registry.definitions("core")).toHaveLength(6);
    expect(registry.definitions("memory")).toHaveLength(4);
    expect(registry.definitions("actions")).toHaveLength(1);

    for (const profile of ["core", "memory", "actions", "legacy"] as const) {
      const server = createAyanamiMcpServer(service, { profile });
      const client = new Client({ name: `registry-${profile}`, version: "1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const listed = await client.listTools();
        expect(listed.tools.map((tool) => tool.name)).toEqual(
          registry.definitions(profile).map((definition) => definition.name),
        );
      } finally {
        await Promise.all([client.close(), server.close()]);
      }
    }
  });

  it("preserves unknown, validation, handler-error and structuredContent call behavior", async () => {
    let fail = false;
    const service = {
      delta: async () => {
        if (fail) throw new Error("DELTA_FAILED: deliberate test failure");
        return { currentSequence: 0, events: [], hasMore: false };
      },
    } as unknown as AyanamiTaskService;
    const server = createAyanamiMcpServer(service, { profile: "memory" });
    const client = new Client({ name: "registry-call-contract", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const unknown = await client.callTool({ name: "atm_unknown", arguments: {} });
      expect(unknown).toMatchObject({ isError: true });
      expect(unknown.content).toEqual([
        expect.objectContaining({ text: expect.stringContaining("not found") }),
      ]);

      const invalid = await client.callTool({ name: "atm_delta", arguments: {} });
      expect(invalid).toMatchObject({ isError: true });
      expect(invalid.content).toEqual([
        expect.objectContaining({ text: expect.stringContaining("Invalid arguments") }),
      ]);

      const success = await client.callTool({
        name: "atm_delta",
        arguments: { project: "ATM", since_seq: 0 },
      });
      expect(success.isError).not.toBe(true);
      expect(success.structuredContent).toMatchObject({
        project: { code: "ATM" },
        since_seq: 0,
        events: [],
      });

      fail = true;
      const failed = await client.callTool({
        name: "atm_delta",
        arguments: { project: "ATM", since_seq: 0 },
      });
      expect(failed).toMatchObject({ isError: true });
      expect(failed.content).toEqual([
        expect.objectContaining({ text: expect.stringContaining("DELTA_FAILED") }),
      ]);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
