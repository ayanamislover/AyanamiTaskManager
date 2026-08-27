import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AyanamiTaskService } from "@ayanami-task/application";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAyanamiMcpServer } from "../src/index.js";

const temporary: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of temporary.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});

async function setup(code: string) {
  const dataDir = await mkdtemp(join(tmpdir(), `atm-mcp-session-keyset-${code.toLowerCase()}-`));
  temporary.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: join(process.cwd(), "migrations"),
  });
  const project = await service.createProject({ name: code, sourcePath: null, code });
  for (let index = 0; index < 8; index += 1) {
    await service.begin({
      projectCode: code,
      mode: "project",
      agentId: `session-agent-${index}`,
      role: "SUBAGENT",
      signals: {},
    });
  }
  const server = createAyanamiMcpServer(service, { profile: "memory" });
  const client = new Client({ name: `session-keyset-${code}`, version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    service,
    project,
    client,
    close: async () => {
      await Promise.all([client.close(), server.close()]);
      service.close();
    },
  };
}

function body(response: Awaited<ReturnType<Client["callTool"]>>): Record<string, any> {
  return response.structuredContent as Record<string, any>;
}

describe("MCP Session keyset list mode", () => {
  it("returns snake_case pages with last_seen_at and nested git", async () => {
    const fixture = await setup("SLIST");
    try {
      const first = body(
        await fixture.client.callTool({
          name: "atm_search",
          arguments: {
            list: "sessions",
            project: fixture.project.code,
            limit: 2,
            field_mask: ["id", "last_seen_at", "git"],
            max_chars: 50_000,
          },
        }),
      );
      expect(first).toMatchObject({
        exact: false,
        list: "sessions",
        requested_limit: 2,
        returned_count: 2,
        next_cursor: expect.stringMatching(/^sl1\./u),
        has_more: true,
      });
      expect(first.items[0]).toHaveProperty("last_seen_at");
      expect(first.items[0]).toHaveProperty("git");
      expect(first.items[0]).not.toHaveProperty("lastSeenAt");
      expect(first.items[0].git).toHaveProperty("repo_root");

      const second = body(
        await fixture.client.callTool({
          name: "atm_search",
          arguments: {
            list: "sessions",
            project: fixture.project.code,
            cursor: first.next_cursor,
            limit: 3,
            field_mask: ["id", "last_seen_at"],
            max_chars: 50_000,
          },
        }),
      );
      expect(second.items).toHaveLength(3);
      expect(second.items[0]).toHaveProperty("last_seen_at");
      expect(second.items[0]).not.toHaveProperty("git");
      expect(second.items.map((item: Record<string, string>) => item.id)).not.toEqual(
        first.items.map((item: Record<string, string>) => item.id),
      );
    } finally {
      await fixture.close();
    }
  });

  it("requires project and makes session list mutually exclusive with query, op_id and session", async () => {
    const fixture = await setup("SLVAL");
    try {
      for (const arguments_ of [
        { list: "sessions" },
        { list: "sessions", project: "SLVAL", query: "x" },
        { list: "sessions", project: "SLVAL", op_id: "x" },
        { list: "sessions", project: "SLVAL", session: "x" },
      ]) {
        const response = await fixture.client.callTool({
          name: "atm_search",
          arguments: arguments_,
        });
        expect(response.isError).toBe(true);
      }
    } finally {
      await fixture.close();
    }
  });
});
