import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AyanamiTaskService } from "@ayanami-task/application";
import { afterEach, describe, expect, it } from "vitest";
import { createAyanamiMcpServer, mcpResult } from "../src/index.js";
import { connectProfiledClients } from "./profile-client.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
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
        title: `Delta event ${String(index).padStart(2, "0")} ${"x".repeat(340)}`,
        description: "",
        type: "TASK",
        priority: "NORMAL",
        status: "READY" as const,
      })),
    );
    const raw = await service.delta(project.code, 0, 50);
    expect(raw.events.length).toBeGreaterThan(20);
    expect(raw.hasMore).toBe(false);

    const server = createAyanamiMcpServer(service, { profile: "memory" });
    const client = new Client({ name: "delta-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const response = await client.callTool({
        name: "atm_delta",
        arguments: { project: project.code, since_seq: 0 },
      });
      const body = response.structuredContent as {
        events: Array<{ seq: number }>;
        next_seq: number;
        has_more: boolean;
        returned_count: number;
        truncated: boolean;
      };

      expect(response.isError).not.toBe(true);
      expect(body.events.length).toBeGreaterThan(0);
      expect(body.events.length).toBeLessThan(raw.events.length);
      expect(body.returned_count).toBe(body.events.length);
      expect(body.next_seq).toBe(body.events.at(-1)?.seq);
      expect(body.has_more).toBe(true);
      expect(body.truncated).toBe(true);
      expect(JSON.stringify(body).length).toBeLessThanOrEqual(12_000);

      const collected = [...body.events];
      let cursor = body.next_seq;
      let hasMore = body.has_more;
      while (hasMore) {
        const page = await client.callTool({
          name: "atm_delta",
          arguments: { project: project.code, since_seq: cursor },
        });
        const pageBody = page.structuredContent as typeof body;
        collected.push(...pageBody.events);
        cursor = pageBody.next_seq;
        hasMore = pageBody.has_more;
      }
      expect(collected.map((event) => event.seq)).toEqual(raw.events.map((event) => event.seq));
    } finally {
      await Promise.all([client.close(), server.close()]);
      service.close();
    }
  });

  it("preserves structured acceptance audit changes in atm_delta", async () => {
    const service = {
      delta: async () => ({
        events: [
          {
            seq: 9,
            type: "work.updated",
            key: "AUD-T-0001",
            summary: "更新任务",
            actor: "audit-agent",
            title: "更新任务",
            detail: "AUD-T-0001（edit）",
            changes: {
              acceptance: { before: ["旧验收"], after: ["新验收"] },
            },
            project: { code: "AUD", name: "Audit" },
            opId: "acceptance-audit",
            at: "2026-08-27T00:00:00.000Z",
          },
        ],
        currentSequence: 9,
        hasMore: false,
      }),
    } as unknown as AyanamiTaskService;
    const server = createAyanamiMcpServer(service, { profile: "memory" });
    const client = new Client({ name: "acceptance-audit", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const response = await client.callTool({
        name: "atm_delta",
        arguments: { project: "AUD", since_seq: 0 },
      });
      expect(response.structuredContent).toMatchObject({
        events: [
          {
            op_id: "acceptance-audit",
            changes: {
              acceptance: { before: ["旧验收"], after: ["新验收"] },
            },
          },
        ],
      });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it("routes an oversized audit event to a reachable REST continuation without looping", async () => {
    const huge = Array.from(
      { length: 100 },
      (_, index) => `${String(index).padStart(3, "0")}:${"审".repeat(996)}`,
    );
    const service = {
      delta: async () => ({
        events: [
          {
            seq: 9,
            type: "work.updated",
            key: "BIG-T-0001",
            summary: "更新任务",
            actor: "audit-agent",
            title: "更新任务",
            detail: "BIG-T-0001（edit）",
            changes: { acceptance: { before: huge, after: huge } },
            project: { code: "BIG", name: "Big audit" },
            opId: "oversized-audit",
            at: "2026-08-27T00:00:00.000Z",
          },
        ],
        currentSequence: 12,
        hasMore: true,
      }),
    } as unknown as AyanamiTaskService;
    const server = createAyanamiMcpServer(service, { profile: "memory" });
    const client = new Client({ name: "oversized-audit", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const response = await client.callTool({
        name: "atm_delta",
        arguments: { project: "BIG", since_seq: 0, max_chars: 1000 },
      });
      expect(response.structuredContent).toMatchObject({
        returned_count: 0,
        next_seq: 9,
        has_more: true,
        truncated: true,
        oversized_event: {
          seq: 9,
          op_id: "oversized-audit",
          continuation: {
            transport: "REST",
            method: "GET",
            authentication: "daemon_bearer",
            path: "/api/v1/projects/BIG/events?since=8&limit=1",
          },
        },
      });
      expect(JSON.stringify(response.structuredContent).length).toBeLessThanOrEqual(1000);
    } finally {
      await Promise.all([client.close(), server.close()]);
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
    const before = await service.getWorkItem(project.code, task.key);
    await service.updateChecklist(project.code, begun.session, "list-check-one", {
      checklistId: before.checklist[0]!.id,
      expectedVersion: before.checklist[0]!.version,
      status: "DONE",
      evidence: ["focused-test"],
    });
    const truth = await service.getWorkItem(project.code, task.key);

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
        },
      });
      const body = response.structuredContent as {
        items: Array<Record<string, unknown>>;
      };

      expect(body.items).toEqual([
        expect.objectContaining({
          key: task.key,
          progress: truth.progress,
          checklist_summary: {
            total: 3,
            todo: 2,
            doing: 0,
            done: 1,
            skipped: 0,
            evidence_required: 1,
            evidence_missing: 0,
          },
        }),
      ]);
    } finally {
      await Promise.all([client.close(), server.close()]);
      service.close();
    }
  });

  it("preserves orthogonal task phase and computed progress in task_list and task_get", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-mcp-task-phase-"));
    roots.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    const project = await service.createProject({
      name: "Task phase projection",
      sourcePath: null,
      code: "TPP",
    });
    const begun = await service.begin({ projectCode: project.code, agentId: "phase-list-test" });
    const objective = await service.createObjective(project.code, begun.session, {
      title: "Phase projection",
      description: "",
      definitionOfDone: [],
    });
    const created = await service.createWorkItems(project.code, begun.session, "phase-list-task", [
      {
        clientRef: "phase-one",
        objectiveId: objective.id,
        title: "Review waits for another agent",
        description: "",
        type: "REVIEW",
        priority: "HIGH",
        status: "READY",
        checklist: Array.from({ length: 5 }, (_, index) => ({
          title: `Stage ${index + 1}`,
          evidenceRequired: false,
        })),
      },
    ]);
    let truth = created.items[0]!;
    truth = (
      await service.patchWorkItems(project.code, begun.session, "phase-start", [
        { taskKey: truth.key, expectedVersion: truth.version, operation: "start" },
      ])
    ).items[0]!;
    await service.addProgress(project.code, begun.session, "phase-report-90", {
      taskKey: truth.key,
      percent: 90,
      summary: "Reported progress must not replace checklist progress.",
      completed: [],
      next: [],
      evidence: [],
    });
    for (const index of [0, 1]) {
      const context = await service.getWorkItem(project.code, truth.key);
      await service.updateChecklist(project.code, begun.session, `phase-check-${index}`, {
        checklistId: context.checklist[index]!.id,
        expectedVersion: context.checklist[index]!.version,
        status: "DONE",
      });
    }
    truth = await service.getWorkItem(project.code, truth.key);
    truth = (
      await service.patchWorkItems(project.code, begun.session, "phase-verify", [
        { taskKey: truth.key, expectedVersion: truth.version, operation: "verify" },
      ])
    ).items[0]!;
    truth = (
      await service.patchWorkItems(project.code, begun.session, "phase-wait-agent", [
        {
          taskKey: truth.key,
          expectedVersion: truth.version,
          operation: "wait_agent",
          waitingFor: "independent-reviewer",
        },
      ])
    ).items[0]!;

    const server = createAyanamiMcpServer(service);
    const client = new Client({ name: "phase-projection-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const fieldMask = ["key", "status", "phase", "waiting_on", "progress", "progress_source"];
      const listed = await client.callTool({
        name: "atm_task_list",
        arguments: { project: project.code },
      });
      const fetched = await client.callTool({
        name: "atm_task_get",
        arguments: { project: project.code, task_key: truth.key, field_mask: fieldMask },
      });
      const expected = {
        key: truth.key,
        status: "WAITING_AGENT",
        phase: "VERIFYING",
        waiting_on: "AGENT",
        progress: 40,
        progress_source: "CHECKLIST",
      };

      expect(listed.structuredContent).toMatchObject({
        items: [expect.objectContaining(expected)],
      });
      expect(fetched.structuredContent).toEqual(expected);
    } finally {
      await Promise.all([client.close(), server.close()]);
      service.close();
    }
  });

  it("routes task_list reconcile view through the read-only reconciliation projection", async () => {
    const longTitle = `Stalled task ${"title".repeat(300)}`;
    const longDisplayName = `Agent One ${"display".repeat(250)}`;
    const longSuggestedAction = `Inspect evidence before takeover. ${"action".repeat(300)}`;
    const oversizedTitle = `Stalled task ${"title".repeat(5000)}`;
    const oversizedDisplayName = `Agent One ${"display".repeat(5000)}`;
    const oversizedSuggestedAction = `Inspect evidence before takeover. ${"action".repeat(5000)}`;
    const calls: Array<{
      project: string;
      includeActive?: boolean;
      limit?: number;
      cursor?: string;
    }> = [];
    const service = {
      reconcileProjectPage: async (
        project: string,
        input: { includeActive?: boolean; limit?: number; cursor?: string },
      ) => {
        calls.push({ project, ...input });
        const allItems = [
          {
            taskKey: "REC-T-0001",
            title: calls.length >= 3 ? oversizedTitle : longTitle,
            status: "CLAIMED",
            classification: "STALLED",
            reason: "session_closed_and_lease_expired",
            ageSeconds: 120,
            session: {
              id: "session-1",
              agentId: "agent-1",
              displayName: calls.length >= 3 ? oversizedDisplayName : longDisplayName,
              connectionState: "CLOSED",
              lastSeenAt: "2026-08-26T23:00:00.000Z",
              endedAt: "2026-08-26T23:01:00.000Z",
            },
            suggestedAction: calls.length >= 3 ? oversizedSuggestedAction : longSuggestedAction,
            evidencePaths: [],
          },
          {
            taskKey: "REC-T-0002",
            title: "Existing artifact",
            status: "READY",
            classification: "POSSIBLY_COMPLETE",
            reason: "all_explicit_acceptance_paths_exist_and_never_claimed",
            ageSeconds: 60,
            session: null,
            suggestedAction: "Verify the artifact before completion.",
            evidencePaths: ["release/done.txt"],
          },
        ];
        const offset = Number.parseInt(input.cursor ?? "0", 10) || 0;
        const limit = input.limit ?? 10;
        const items = allItems.slice(offset, offset + limit);
        return {
          project: { code: "REC", name: "Reconcile", sourceRoot: "R:\\Project" },
          generatedAt: "2026-08-27T00:00:00.000Z",
          attentionCount: 2,
          counts: { ACTIVE: 0, LEASE_EXPIRED_ONLINE: 0, STALLED: 1, POSSIBLY_COMPLETE: 1 },
          offset,
          returnedCount: items.length,
          items,
          retryCursor: String(offset),
          nextCursor:
            offset + items.length < allItems.length ? String(offset + items.length) : null,
          hasMore: offset + items.length < allItems.length,
        };
      },
    } as unknown as AyanamiTaskService;
    const server = createAyanamiMcpServer(service);
    const client = new Client({ name: "reconcile-projection-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listedTools = await client.listTools();
      const listSchema = listedTools.tools.find((tool) => tool.name === "atm_task_list")
        ?.inputSchema as {
        properties?: Record<string, { type?: string; enum?: string[] }>;
      };
      expect(listSchema.properties?.view?.enum).toContain("reconcile");
      expect(listSchema.properties?.include_active).toEqual({ default: false, type: "boolean" });

      const first = await client.callTool({
        name: "atm_task_list",
        arguments: {
          project: "REC",
          view: "reconcile",
        },
      });
      expect(calls).toEqual([{ project: "REC", includeActive: false, limit: 10 }]);
      expect(first.structuredContent).toMatchObject({
        project: "REC",
        project_name: "Reconcile",
        source_root: "R:\\Project",
        view: "reconcile",
        generated_at: "2026-08-27T00:00:00.000Z",
        attention_count: 2,
        returned_count: 2,
        has_more: false,
        next_cursor: null,
        items: [
          {
            task_key: "REC-T-0001",
            classification: "STALLED",
            age_seconds: 120,
            session: {
              id: "session-1",
              agent_id: "agent-1",
              display_name: longDisplayName,
              connection_state: "CLOSED",
              last_seen_at: "2026-08-26T23:00:00.000Z",
              ended_at: "2026-08-26T23:01:00.000Z",
            },
            suggested_action: longSuggestedAction,
            evidence_paths: [],
          },
          {
            task_key: "REC-T-0002",
            classification: "POSSIBLY_COMPLETE",
            evidence_paths: ["release/done.txt"],
          },
        ],
      });

      const second = await client.callTool({
        name: "atm_task_list",
        arguments: {
          project: "REC",
          view: "reconcile",
          cursor: "1",
        },
      });
      expect(second.structuredContent).toMatchObject({
        returned_count: 1,
        has_more: false,
        next_cursor: null,
        items: [
          {
            task_key: "REC-T-0002",
            classification: "POSSIBLY_COMPLETE",
            evidence_paths: ["release/done.txt"],
          },
        ],
      });

      const budgeted = await client.callTool({
        name: "atm_task_list",
        arguments: {
          project: "REC",
          view: "reconcile",
        },
      });
      expect(JSON.stringify(budgeted.structuredContent).length).toBeLessThanOrEqual(12_000);
      expect(budgeted.structuredContent).toMatchObject({
        returned_count: 1,
        has_more: true,
        next_cursor: "1",
        truncated: true,
        items: [{ task_key: "REC-T-0001", classification: "STALLED" }],
        truncation: {
          path: "items[0]",
          retry_cursor: "0",
          omitted_fields: expect.arrayContaining(["title", "session", "suggested_action"]),
        },
      });
    } finally {
      await Promise.all([client.close(), server.close()]);
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

    const profiles = await connectProfiledClients(service, "field-test");
    const { client } = profiles;
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
            field_mask: ["key", "description"],
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
      await profiles.close();
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
    for (let index = 1; index <= 21; index += 1) {
      await service.createRecord(project.code, begun.session, `record-cn-${index}`, {
        kind: "FACT",
        title: `中文检索共同词 ${index}`,
        summary: `中文检索共同词的第 ${index} 条摘要`,
        detail: "中文全文检索与游标分页验收",
        importance: "NORMAL",
        scope: "PROJECT",
      });
    }

    const server = createAyanamiMcpServer(service, { profile: "memory" });
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
            field_mask: ["key", "detail"],
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
          field_mask: ["entity_key", "title"],
        },
      });
      const chineseFirstBody = chineseFirst.structuredContent as {
        exact: boolean;
        hits: Array<{ entity_key: string; title: string }>;
        next_cursor: string | null;
      };
      expect(chineseFirstBody.exact).toBe(false);
      expect(chineseFirstBody.hits).toHaveLength(20);
      expect(chineseFirstBody.hits[0]).toEqual({
        entity_key: expect.stringMatching(/^REK-R-/u),
        title: expect.stringContaining("中文检索共同词"),
      });
      expect(chineseFirstBody.next_cursor).toEqual(expect.stringMatching(/^s1\./u));

      const chineseSecond = await client.callTool({
        name: "atm_search",
        arguments: {
          project: project.code,
          query: "中文检索共同词",
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
