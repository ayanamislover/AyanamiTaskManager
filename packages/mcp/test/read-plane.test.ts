import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AyanamiTaskService } from "@ayanami-task/application";
import { afterEach, describe, expect, it } from "vitest";
import { createAyanamiMcpServer, mcpResult } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("MCP read plane", () => {
  it("keeps a response byte-for-byte intact when it already fits the budget", () => {
    const summary = "read-plane-".repeat(30);

    const response = mcpResult({ summary }, 1000);

    expect(response.structuredContent).toEqual({ summary });
  });

  it("reports every shortened field with its path and original length", () => {
    const summary = "x".repeat(600);

    const response = mcpResult({ summary }, 300);
    const body = response.structuredContent as {
      summary: string;
      truncated: boolean;
      truncated_fields: Array<{
        path: string;
        original_chars: number;
        returned_chars: number;
      }>;
    };

    expect(body.truncated).toBe(true);
    expect(body.summary).toMatch(/…$/u);
    expect(body.truncated_fields).toEqual([
      {
        path: "summary",
        original_chars: 600,
        returned_chars: body.summary.length,
      },
    ]);
    expect(JSON.stringify(body).length).toBeLessThanOrEqual(300);
  });

  it("paginates delta by complete events and returns a truthful continuation", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-mcp-delta-"));
    roots.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    const project = await service.createProject({
      name: "Delta pagination",
      sourcePath: null,
      code: "DLP",
    });
    const begun = await service.begin({ projectCode: project.code, agentId: "delta-test" });
    const objective = await service.createObjective(project.code, begun.session, {
      title: "Delta",
      description: "",
      definitionOfDone: [],
    });
    await service.createWorkItems(
      project.code,
      begun.session,
      "delta-many-events",
      Array.from({ length: 30 }, (_, index) => ({
        clientRef: `delta-${index}`,
        objectiveId: objective.id,
        title: `Delta event ${String(index).padStart(2, "0")}`,
        description: "",
        type: "TASK",
        priority: "NORMAL",
        status: "READY" as const,
      })),
    );
    const raw = await service.delta(project.code, 0, 100);
    expect(raw.events.length).toBeGreaterThan(20);
    expect(raw.hasMore).toBe(false);

    const server = createAyanamiMcpServer(service);
    const client = new Client({ name: "delta-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const response = await client.callTool({
        name: "atm_delta",
        arguments: { project: project.code, since_seq: 0, limit: 100 },
      });
      const body = response.structuredContent as {
        events: Array<{ seq: number }>;
        next_seq: number;
        has_more: boolean;
        returned_count: number;
        truncated: boolean;
      };

      expect(response.isError).not.toBe(true);
      expect(body.events).toHaveLength(raw.events.length);
      expect(body.returned_count).toBe(raw.events.length);
      expect(body.next_seq).toBe(raw.events.at(-1)?.seq);
      expect(body.has_more).toBe(false);
      expect(body.truncated).toBe(false);
      expect(JSON.stringify(body).length).toBeLessThanOrEqual(12_000);

      const firstPage = await client.callTool({
        name: "atm_delta",
        arguments: {
          project: project.code,
          since_seq: 0,
          limit: 100,
          max_chars: 2500,
        },
      });
      const firstBody = firstPage.structuredContent as typeof body;
      expect(firstBody.events.length).toBeGreaterThan(0);
      expect(firstBody.events.length).toBeLessThan(raw.events.length);
      expect(firstBody.next_seq).toBe(firstBody.events.at(-1)?.seq);
      expect(firstBody.has_more).toBe(true);
      expect(firstBody.truncated).toBe(true);

      const restPage = await client.callTool({
        name: "atm_delta",
        arguments: {
          project: project.code,
          since_seq: firstBody.next_seq,
          limit: 100,
          max_chars: 12_000,
        },
      });
      const restBody = restPage.structuredContent as typeof body;
      expect([...firstBody.events, ...restBody.events].map((event) => event.seq)).toEqual(
        raw.events.map((event) => event.seq),
      );
    } finally {
      await Promise.all([client.close(), server.close()]);
      service.close();
    }
  });

  it("projects the stored progress and an accurate checklist summary in task_list", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-mcp-task-list-"));
    roots.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    const project = await service.createProject({
      name: "Task list projection",
      sourcePath: null,
      code: "TLP",
    });
    const begun = await service.begin({ projectCode: project.code, agentId: "list-test" });
    const objective = await service.createObjective(project.code, begun.session, {
      title: "Projection",
      description: "",
      definitionOfDone: [],
    });
    const created = await service.createWorkItems(project.code, begun.session, "list-task", [
      {
        clientRef: "list-one",
        objectiveId: objective.id,
        title: "Task with checklist",
        description: "The context projection must remain truthful.",
        type: "TASK",
        priority: "HIGH",
        status: "READY",
        acceptance: ["Checklist summary is visible"],
        checklist: [
          { title: "One", evidenceRequired: true },
          { title: "Two", evidenceRequired: false },
          { title: "Three", evidenceRequired: false },
        ],
      },
    ]);
    const task = created.items[0]!;
    const before = await service.getWorkItem(project.code, task.key, "context");
    await service.updateChecklist(project.code, begun.session, "list-check-one", {
      checklistId: before.checklist[0]!.id,
      expectedVersion: before.checklist[0]!.version,
      status: "DONE",
      evidence: ["focused-test"],
    });
    const truth = await service.getWorkItem(project.code, task.key, "context");

    const server = createAyanamiMcpServer(service);
    const client = new Client({ name: "list-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const response = await client.callTool({
        name: "atm_task_list",
        arguments: {
          project: project.code,
          view: "context",
          field_mask: ["key", "progress", "checklist"],
          limit: 10,
        },
      });
      const body = response.structuredContent as {
        items: Array<Record<string, unknown>>;
      };

      expect(body.items).toEqual([
        {
          key: task.key,
          progress: truth.progress,
          checklist: {
            total: 3,
            todo: 2,
            doing: 0,
            done: 1,
            skipped: 0,
            evidence_required: 1,
            evidence_missing: 0,
          },
        },
      ]);
    } finally {
      await Promise.all([client.close(), server.close()]);
      service.close();
    }
  });

  it("continues a long task field without losing or repeating characters", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-mcp-task-field-"));
    roots.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    const project = await service.createProject({
      name: "Task field continuation",
      sourcePath: null,
      code: "TFC",
    });
    const begun = await service.begin({ projectCode: project.code, agentId: "field-test" });
    const objective = await service.createObjective(project.code, begun.session, {
      title: "Field continuation",
      description: "",
      definitionOfDone: [],
    });
    const description = Array.from({ length: 2400 }, (_, index) =>
      String.fromCharCode(65 + (index % 26)),
    ).join("");
    const created = await service.createWorkItems(project.code, begun.session, "field-task", [
      {
        clientRef: "field-one",
        objectiveId: objective.id,
        title: "Long task field",
        description,
        type: "TASK",
        priority: "NORMAL",
        status: "READY",
      },
    ]);
    const taskKey = created.items[0]!.key;

    const server = createAyanamiMcpServer(service);
    const client = new Client({ name: "field-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const exactTask = await client.callTool({
        name: "atm_search",
        arguments: {
          project: project.code,
          query: taskKey,
          field_mask: ["key", "title"],
        },
      });
      expect(exactTask.structuredContent).toMatchObject({
        exact: true,
        entity_type: "WORK_ITEM",
        entity: { key: taskKey, title: "Long task field" },
      });

      const first = await client.callTool({
        name: "atm_task_get",
        arguments: {
          project: project.code,
          task_key: taskKey,
          view: "full",
          field_mask: ["key", "description"],
          max_chars: 700,
        },
      });
      const firstBody = first.structuredContent as {
        description: string;
        truncated: boolean;
        truncated_fields: Array<{
          path: string;
          original_chars: number;
          returned_chars: number;
          continuation: { cursor: string };
        }>;
      };
      expect(firstBody.truncated).toBe(true);
      expect(firstBody.truncated_fields[0]).toMatchObject({
        path: "description",
        original_chars: description.length,
        returned_chars: firstBody.description.length,
      });

      let restored = firstBody.description;
      let cursor: string | null = firstBody.truncated_fields[0]!.continuation.cursor;
      while (cursor) {
        const page = await client.callTool({
          name: "atm_task_get",
          arguments: {
            project: project.code,
            task_key: taskKey,
            view: "full",
            field_mask: ["description"],
            max_chars: 700,
            cursor,
          },
        });
        const pageBody = page.structuredContent as {
          value: string;
          next_cursor: string | null;
          done: boolean;
        };
        restored += pageBody.value;
        cursor = pageBody.next_cursor;
      }

      expect(restored).toBe(description);
    } finally {
      await Promise.all([client.close(), server.close()]);
      service.close();
    }
  });

  it("resolves an exact public record key before full-text search and continues detail", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-mcp-record-key-"));
    roots.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    const project = await service.createProject({
      name: "Record exact key",
      sourcePath: null,
      code: "REK",
    });
    const begun = await service.begin({ projectCode: project.code, agentId: "record-test" });
    const detail = Array.from({ length: 2200 }, (_, index) =>
      String.fromCharCode(97 + (index % 26)),
    ).join("");
    const created = await service.createRecord(project.code, begun.session, "record-exact", {
      kind: "FACT",
      title: "Exact record",
      summary: "The public key is the stable identifier.",
      detail,
      importance: "HIGH",
      scope: "PROJECT",
    });
    for (const index of [1, 2, 3]) {
      await service.createRecord(project.code, begun.session, `record-cn-${index}`, {
        kind: "FACT",
        title: `中文检索共同词 ${index}`,
        summary: `中文检索共同词的第 ${index} 条摘要`,
        detail: "中文全文检索与游标分页验收",
        importance: "NORMAL",
        scope: "PROJECT",
      });
    }

    const server = createAyanamiMcpServer(service);
    const client = new Client({ name: "record-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const first = await client.callTool({
        name: "atm_search",
        arguments: {
          project: project.code,
          query: created.key,
          field_mask: ["key", "detail"],
          max_chars: 700,
        },
      });
      const firstBody = first.structuredContent as {
        exact: boolean;
        entity_type: string;
        entity: {
          key: string;
          detail: string;
          truncated: boolean;
          truncated_fields: Array<{ continuation: { cursor: string } }>;
        };
      };
      expect(firstBody).toMatchObject({
        exact: true,
        entity_type: "RECORD",
        entity: { key: created.key, truncated: true },
      });
      expect(JSON.stringify(firstBody).length).toBeLessThanOrEqual(700);

      let restored = firstBody.entity.detail;
      let cursor: string | null = firstBody.entity.truncated_fields[0]?.continuation.cursor ?? null;
      while (cursor) {
        const page = await client.callTool({
          name: "atm_search",
          arguments: {
            project: project.code,
            query: created.key,
            field_mask: ["detail"],
            max_chars: 700,
            cursor,
          },
        });
        const pageBody = page.structuredContent as {
          exact: boolean;
          entity_type: string;
          entity: { value: string; next_cursor: string | null };
        };
        restored += pageBody.entity.value;
        cursor = pageBody.entity.next_cursor;
      }
      expect(restored).toBe(detail);

      const chineseFirst = await client.callTool({
        name: "atm_search",
        arguments: {
          project: project.code,
          query: "中文检索共同词",
          limit: 1,
          field_mask: ["entity_key", "title"],
        },
      });
      const chineseFirstBody = chineseFirst.structuredContent as {
        exact: boolean;
        hits: Array<{ entity_key: string; title: string }>;
        next_cursor: string | null;
      };
      expect(chineseFirstBody.exact).toBe(false);
      expect(chineseFirstBody.hits).toHaveLength(1);
      expect(chineseFirstBody.hits[0]).toEqual({
        entity_key: expect.stringMatching(/^REK-R-/u),
        title: expect.stringContaining("中文检索共同词"),
      });
      expect(chineseFirstBody.next_cursor).toBe("1");

      const chineseSecond = await client.callTool({
        name: "atm_search",
        arguments: {
          project: project.code,
          query: "中文检索共同词",
          limit: 1,
          cursor: chineseFirstBody.next_cursor,
          field_mask: ["entity_key", "title"],
        },
      });
      const chineseSecondBody = chineseSecond.structuredContent as typeof chineseFirstBody;
      expect(chineseSecondBody.hits).toHaveLength(1);
      expect(chineseSecondBody.hits[0]?.entity_key).not.toBe(chineseFirstBody.hits[0]?.entity_key);
    } finally {
      await Promise.all([client.close(), server.close()]);
      service.close();
    }
  });
});
