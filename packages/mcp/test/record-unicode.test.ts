import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AyanamiTaskService } from "@ayanami-task/application";
import { afterEach, describe, expect, it } from "vitest";
import { createAyanamiMcpServer } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function openFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "atm-mcp-record-unicode-"));
  roots.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: join(process.cwd(), "migrations"),
  });
  const project = await service.createProject({
    name: "MCP Unicode record summary",
    sourcePath: null,
    code: "MUNI",
  });
  const begun = await service.begin({
    projectCode: project.code,
    agentId: "mcp-unicode-test",
    role: "PRIMARY",
  });
  const server = createAyanamiMcpServer(service);
  const client = new Client({ name: "mcp-unicode-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server, service, project, session: begun.session };
}

describe("MCP record Unicode summary contract", () => {
  it("publishes maxLength=300 and accepts 300 code points plus 200 emoji", async () => {
    const fixture = await openFixture();
    try {
      const listed = await fixture.client.listTools();
      const recordSchema = listed.tools.find((tool) => tool.name === "atm_record")?.inputSchema as {
        properties?: Record<string, { maxLength?: number }>;
      };
      expect(recordSchema.properties?.summary?.maxLength).toBe(300);

      const boundary = await fixture.client.callTool({
        name: "atm_record",
        arguments: {
          project: fixture.project.code,
          session: fixture.session,
          op_id: "unicode-summary-300",
          kind: "FACT",
          title: "300 code points",
          summary: "界".repeat(300),
        },
      });
      expect(boundary.isError).not.toBe(true);

      const emoji = await fixture.client.callTool({
        name: "atm_record",
        arguments: {
          project: fixture.project.code,
          session: fixture.session,
          op_id: "unicode-summary-200-emoji",
          kind: "FACT",
          title: "200 emoji",
          summary: "🧾".repeat(200),
        },
      });
      expect(emoji.isError).not.toBe(true);
      expect(await fixture.service.listRecords(fixture.project.code)).toHaveLength(2);
    } finally {
      await Promise.all([fixture.client.close(), fixture.server.close()]);
      fixture.service.close();
    }
  });

  it("rejects 301 code points with structured diagnostics and leaves no partial record", async () => {
    const fixture = await openFixture();
    try {
      const rejected = await fixture.client.callTool({
        name: "atm_record",
        arguments: {
          project: fixture.project.code,
          session: fixture.session,
          op_id: "unicode-summary-301",
          kind: "FACT",
          title: "Rejected summary",
          summary: "界".repeat(301),
          detail: "detail ".repeat(10_000),
        },
      });
      expect(rejected.isError).toBe(true);
      const diagnostic = JSON.stringify(rejected.content);
      expect(diagnostic).toContain("INVALID_ARGUMENT");
      expect(diagnostic).toContain("actual_length");
      expect(diagnostic).toContain("301");
      expect(diagnostic).toContain("limit");
      expect(diagnostic).toContain("300");
      expect(diagnostic).toContain("path");
      expect(diagnostic).toContain("summary");
      expect(await fixture.service.listRecords(fixture.project.code)).toEqual([]);
    } finally {
      await Promise.all([fixture.client.close(), fixture.server.close()]);
      fixture.service.close();
    }
  });
});
