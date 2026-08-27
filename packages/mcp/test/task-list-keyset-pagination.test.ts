import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AyanamiTaskService } from "@ayanami-task/application";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createAyanamiMcpServer } from "../src/index.js";

const temporary: string[] = [];

afterEach(async () => {
  for (const directory of temporary.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});

async function setup(code: string): Promise<{
  service: AyanamiTaskService;
  client: Client;
  close: () => Promise<void>;
  keys: string[];
}> {
  const dataDir = await mkdtemp(join(tmpdir(), `atm-mcp-task-keyset-${code.toLowerCase()}-`));
  temporary.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: join(process.cwd(), "migrations"),
  });
  await service.createProject({ name: code, sourcePath: null, code });
  const objective = await service.createObjectiveAsUser(code, `${code}-objective`, {
    title: `${code} objective`,
    description: "",
    definitionOfDone: [],
  });
  const created = await service.createWorkItemsAsUser(
    code,
    `${code}-tasks`,
    Array.from({ length: 8 }, (_, index) => ({
      clientRef: `task-${index}`,
      objectiveId: objective.id,
      title: `Stable task ${String(index + 1).padStart(2, "0")} ${"title ".repeat(8)}`,
      description: `${"Long pagination description. ".repeat(40)}${index}`,
      type: "TASK",
      priority: "HIGH",
      status: "READY" as const,
    })),
  );
  const server = createAyanamiMcpServer(service);
  const client = new Client({ name: `task-keyset-${code}`, version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    service,
    client,
    keys: created.items.map((item) => item.key),
    close: async () => {
      await Promise.all([client.close(), server.close()]);
      service.close();
    },
  };
}

function body(response: Awaited<ReturnType<Client["callTool"]>>): Record<string, any> {
  return response.structuredContent as Record<string, any>;
}

describe("MCP WorkItem keyset pagination", () => {
  it("continues across limit, view, field mask and budget changes", async () => {
    const fixture = await setup("TLCHG");
    try {
      const first = body(
        await fixture.client.callTool({
          name: "atm_task_list",
          arguments: {
            project: "TLCHG",
            limit: 2,
            view: "core",
            field_mask: ["key"],
            max_chars: 50_000,
          },
        }),
      );
      expect(first).toMatchObject({
        items: [{ key: fixture.keys[0] }, { key: fixture.keys[1] }],
        returned_count: 2,
        has_more: true,
        next_cursor: expect.stringMatching(/^tl1\./u),
      });

      const second = body(
        await fixture.client.callTool({
          name: "atm_task_list",
          arguments: {
            project: "TLCHG",
            limit: 3,
            cursor: first.next_cursor,
            view: "full",
            field_mask: ["key", "title"],
            max_chars: 50_000,
          },
        }),
      );
      expect(second.items.map((item: Record<string, unknown>) => item.key)).toEqual(
        fixture.keys.slice(2, 5),
      );
      expect(second.items[0]).toHaveProperty("title");
    } finally {
      await fixture.close();
    }
  });

  it("returns a reusable start cursor when the first item does not fit", async () => {
    const fixture = await setup("TLBIG");
    try {
      const constrained = body(
        await fixture.client.callTool({
          name: "atm_task_list",
          arguments: { project: "TLBIG", limit: 5, view: "full", max_chars: 500 },
        }),
      );
      expect(constrained).toMatchObject({
        items: [],
        returned_count: 0,
        has_more: true,
        truncated: true,
        next_cursor: expect.stringMatching(/^tl1\./u),
      });

      const retried = body(
        await fixture.client.callTool({
          name: "atm_task_list",
          arguments: {
            project: "TLBIG",
            cursor: constrained.next_cursor,
            limit: 5,
            view: "full",
            field_mask: ["key"],
            max_chars: 1000,
          },
        }),
      );
      expect(retried.items[0]).toEqual({ key: fixture.keys[0] });
      expect(retried.next_cursor).not.toBe(constrained.next_cursor);
    } finally {
      await fixture.close();
    }
  });

  it("advances by the last item actually returned under max_chars", async () => {
    const fixture = await setup("TLFIT");
    try {
      const received: string[] = [];
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
        const page = body(
          await fixture.client.callTool({
            name: "atm_task_list",
            arguments: {
              project: "TLFIT",
              limit: 8,
              view: "context",
              field_mask: ["key", "title"],
              max_chars: 1000,
              ...(cursor ? { cursor } : {}),
            },
          }),
        );
        expect(page.returned_count).toBeGreaterThan(0);
        expect(JSON.stringify(page).length).toBeLessThanOrEqual(1000);
        received.push(...page.items.map((item: Record<string, string>) => item.key));
        if (!page.has_more) break;
        expect(page.next_cursor).toMatch(/^tl1\./u);
        expect(page.next_cursor).not.toBe(cursor);
        cursor = page.next_cursor;
      }
      expect(received).toEqual(fixture.keys);
      expect(new Set(received).size).toBe(fixture.keys.length);
    } finally {
      await fixture.close();
    }
  });

  it("rejects cross-filter, cross-project and tampered cursors with typed errors", async () => {
    const first = await setup("TLERR");
    const second = await setup("TLOTH");
    try {
      const page = body(
        await first.client.callTool({
          name: "atm_task_list",
          arguments: { project: "TLERR", limit: 1, max_chars: 5000 },
        }),
      );
      const cursor = String(page.next_cursor);
      const invalidRequests = [
        { project: "TLERR", limit: 1, cursor, status: "DONE" },
        { project: "TLOTH", limit: 1, cursor },
        {
          project: "TLERR",
          limit: 1,
          cursor: `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`,
        },
      ];
      for (const [index, arguments_] of invalidRequests.entries()) {
        const client = index === 1 ? second.client : first.client;
        const response = await client.callTool({ name: "atm_task_list", arguments: arguments_ });
        expect(response.isError).toBe(true);
        expect(JSON.stringify(response.content)).toContain("INVALID_CURSOR");
      }
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });
});
