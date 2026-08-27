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
  const dataDir = await mkdtemp(join(tmpdir(), `atm-mcp-record-keyset-${code.toLowerCase()}-`));
  temporary.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: join(process.cwd(), "migrations"),
  });
  const project = await service.createProject({ name: code, sourcePath: null, code });
  const begin = await service.begin({
    projectCode: code,
    mode: "project",
    agentId: "record-page-test",
    role: "PRIMARY",
    signals: {},
  });
  for (let index = 0; index < 8; index += 1) {
    await service.createRecord(code, String(begin.session), `${code}-record-${index}`, {
      kind: "FACT",
      title: `Record ${index}`,
      summary: `Stable record ${index}`,
      detail: `${"Large detail. ".repeat(300)}${index}`,
      topic: "record-keyset",
    });
  }
  const server = createAyanamiMcpServer(service, { profile: "memory" });
  const client = new Client({ name: `record-keyset-${code}`, version: "1" });
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

describe("MCP Record keyset list mode", () => {
  it("returns snake_case pages and permits limit, budget and field-mask changes", async () => {
    const fixture = await setup("RLIST");
    try {
      const first = body(
        await fixture.client.callTool({
          name: "atm_search",
          arguments: {
            list: "records",
            project: fixture.project.code,
            limit: 2,
            field_mask: ["key", "source_type"],
            max_chars: 50_000,
          },
        }),
      );
      expect(first).toMatchObject({
        exact: false,
        requested_limit: 2,
        items: [
          { key: "RLIST-R-008", source_type: "AGENT" },
          { key: "RLIST-R-007", source_type: "AGENT" },
        ],
        returned_count: 2,
        next_cursor: expect.stringMatching(/^rl1\./u),
        has_more: true,
      });
      expect(first.items[0]).not.toHaveProperty("sourceType");

      const second = body(
        await fixture.client.callTool({
          name: "atm_search",
          arguments: {
            list: "records",
            project: fixture.project.code,
            cursor: first.next_cursor,
            limit: 3,
            field_mask: ["key", "updated_at"],
            max_chars: 1000,
          },
        }),
      );
      expect(second.items.map((item: Record<string, string>) => item.key)).toEqual([
        "RLIST-R-006",
        "RLIST-R-005",
        "RLIST-R-004",
      ]);
      expect(second.items[0]).toHaveProperty("updated_at");
    } finally {
      await fixture.close();
    }
  });

  it("fetches one source page and advances only by items that fit the budget", async () => {
    const fixture = await setup("RLFIT");
    try {
      const pageSpy = vi.spyOn(fixture.service, "recordPage");
      const compactDefault = body(
        await fixture.client.callTool({
          name: "atm_search",
          arguments: { list: "records", project: "RLFIT", limit: 8, max_chars: 900 },
        }),
      );
      expect(pageSpy).toHaveBeenCalledTimes(1);
      expect(compactDefault.returned_count).toBeGreaterThan(0);
      expect(compactDefault.items[0]).not.toHaveProperty("detail");
      expect(compactDefault.next_cursor).toMatch(/^rl1\./u);

      pageSpy.mockClear();
      const constrained = body(
        await fixture.client.callTool({
          name: "atm_search",
          arguments: {
            list: "records",
            project: "RLFIT",
            limit: 8,
            field_mask: ["detail"],
            max_chars: 300,
          },
        }),
      );
      expect(pageSpy).toHaveBeenCalledTimes(1);
      expect(constrained).toMatchObject({
        exact: false,
        requested_limit: 8,
        items: [],
        returned_count: 0,
        next_cursor: expect.stringMatching(/^rl1\./u),
        has_more: true,
        truncated: true,
      });
      expect(JSON.stringify(constrained).length).toBeLessThanOrEqual(300);

      pageSpy.mockClear();
      const retried = body(
        await fixture.client.callTool({
          name: "atm_search",
          arguments: {
            list: "records",
            project: "RLFIT",
            cursor: constrained.next_cursor,
            limit: 8,
            field_mask: ["key"],
            max_chars: 700,
          },
        }),
      );
      expect(pageSpy).toHaveBeenCalledTimes(1);
      expect(retried.returned_count).toBeGreaterThan(0);
      expect(retried.items[0]).toEqual({ key: "RLFIT-R-008" });
      expect(JSON.stringify(retried).length).toBeLessThanOrEqual(700);
      expect(retried.next_cursor).not.toBe(constrained.next_cursor);
    } finally {
      await fixture.close();
    }
  });

  it("requires a project and makes list mutually exclusive with query, op_id and session", async () => {
    const fixture = await setup("RLVAL");
    try {
      for (const arguments_ of [
        { list: "records" },
        { list: "records", project: "RLVAL", query: "x" },
        { list: "records", project: "RLVAL", op_id: "x" },
        { list: "records", project: "RLVAL", session: "x" },
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
