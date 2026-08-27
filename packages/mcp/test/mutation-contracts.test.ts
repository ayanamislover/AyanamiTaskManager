import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AyanamiTaskService } from "@ayanami-task/application";
import { afterEach, describe, expect, it } from "vitest";
import { createAyanamiMcpServer } from "../src/index.js";
import { connectProfiledClients } from "./profile-client.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("MCP mutation contracts", () => {
  it("echoes the exact op_id in atm_begin", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-mcp-op-ack-"));
    roots.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    const project = await service.createProject({
      name: "Mutation acknowledgements",
      sourcePath: null,
      code: "MACK",
    });
    const profiles = await connectProfiledClients(service, "mutation-contract-test");
    const { client } = profiles;
    try {
      const response = await client.callTool({
        name: "atm_begin",
        arguments: {
          project_code: project.code,
          mode: "project",
          agent_id: "mutation-test",
          op_id: "begin-ack-exact",
        },
      });

      expect(response.structuredContent).toMatchObject({
        op_id: "begin-ack-exact",
        atomicBegin: { operationId: "begin-ack-exact" },
      });
      const session = String((response.structuredContent as Record<string, unknown>).session);

      const created = await client.callTool({
        name: "atm_task_create",
        arguments: {
          project: project.code,
          session,
          op_id: "create-ack-exact",
          items: [
            {
              client_ref: "ack-task",
              title: "Mutation ACK task",
              status: "READY",
              checklist: [{ title: "ACK checklist", evidence_required: false }],
            },
          ],
        },
      });
      expect(created.structuredContent).toMatchObject({ op_id: "create-ack-exact" });
      const taskKey = String(
        (created.structuredContent as { created: Array<{ task_key: string }> }).created[0]!
          .task_key,
      );

      const patched = await client.callTool({
        name: "atm_task_patch",
        arguments: {
          project: project.code,
          session,
          op_id: "patch-ack-exact",
          items: [{ task_key: taskKey, expected_version: 1, operation: "start" }],
        },
      });
      expect(patched.structuredContent).toMatchObject({ op_id: "patch-ack-exact" });

      const detail = await service.getWorkItem(project.code, taskKey, "context");
      const checklist = await client.callTool({
        name: "atm_task_patch",
        arguments: {
          project: project.code,
          session,
          op_id: "checklist-ack-exact",
          items: [
            {
              task_key: taskKey,
              expected_version: detail.version,
              operation: "checklist_batch",
              checklist_items: [
                {
                  id: detail.checklist[0]!.id,
                  status: "DONE",
                  evidence: ["focused-test"],
                },
              ],
            },
          ],
        },
      });
      expect(checklist.structuredContent).toMatchObject({
        op_id: "checklist-ack-exact",
        task_key: taskKey,
        updated_count: 1,
      });

      const progress = await client.callTool({
        name: "atm_progress_add",
        arguments: {
          project: project.code,
          session,
          op_id: "progress-ack-exact",
          scope: "task",
          task_key: taskKey,
          summary: "Mutation ACK progress",
        },
      });
      expect(progress.structuredContent).toMatchObject({ op_id: "progress-ack-exact" });

      const completed = await client.callTool({
        name: "atm_task_patch",
        arguments: {
          project: project.code,
          session,
          op_id: "verify-complete-ack-exact",
          items: [
            {
              task_key: taskKey,
              expected_version: (progress.structuredContent as { version: number }).version,
              operation: "verify_and_complete",
            },
          ],
        },
      });
      expect(completed.structuredContent).toMatchObject({
        op_id: "verify-complete-ack-exact",
        items: [
          {
            task_key: taskKey,
            from_status: "IN_PROGRESS",
            status: "DONE",
            transitions: ["VERIFYING", "DONE"],
          },
        ],
      });
      expect(await service.getWorkItem(project.code, taskKey)).toMatchObject({ status: "DONE" });

      const record = await client.callTool({
        name: "atm_record",
        arguments: {
          project: project.code,
          session,
          op_id: "record-ack-exact",
          kind: "FACT",
          title: "Mutation ACK record",
          summary: "The acknowledgement binds the original operation.",
        },
      });
      expect(record.structuredContent).toMatchObject({
        op_id: "record-ack-exact",
        related_records: [],
      });
      const recordKey = String((record.structuredContent as { record: string }).record);

      const publicKeyEvidence = await client.callTool({
        name: "atm_progress_add",
        arguments: {
          project: project.code,
          session,
          op_id: "progress-public-key-evidence",
          scope: "task",
          task_key: taskKey,
          summary: "Structured evidence resolves public ATM keys",
          evidence: [
            { kind: "atm_record", value: recordKey },
            { kind: "atm_task", value: taskKey },
          ],
        },
      });
      expect(publicKeyEvidence.isError, JSON.stringify(publicKeyEvidence.content)).not.toBe(true);
      expect(publicKeyEvidence.structuredContent).toMatchObject({
        op_id: "progress-public-key-evidence",
      });

      const trace = await client.callTool({
        name: "atm_search",
        arguments: {
          project: project.code,
          query: "op:record-ack-exact",
        },
      });
      expect(trace.structuredContent).toMatchObject({
        exact: true,
        entity_type: "OPERATION",
        operation: {
          op_id: "record-ack-exact",
          mutations: expect.arrayContaining([
            expect.objectContaining({ operation: "record.create", session_id: session }),
          ]),
          records: [
            expect.objectContaining({
              key: expect.stringMatching(/^MACK-R-/u),
              op_id: "record-ack-exact",
              topic: null,
              related_records: [],
            }),
          ],
          progress: [],
          project_updates: [],
          events: expect.arrayContaining([expect.objectContaining({ op_id: "record-ack-exact" })]),
        },
      });

      const delta = await client.callTool({
        name: "atm_delta",
        arguments: { project: project.code, since_seq: 0 },
      });
      expect(
        (delta.structuredContent as { events: Array<{ op_id: string | null }> }).events,
      ).toEqual(expect.arrayContaining([expect.objectContaining({ op_id: "record-ack-exact" })]));

      const ended = await client.callTool({
        name: "atm_end",
        arguments: {
          project: project.code,
          session,
          op_id: "end-ack-exact",
          outcome: "completed",
          summary: "Mutation ACK test finished",
        },
      });
      expect(ended.structuredContent).toMatchObject({ op_id: "end-ack-exact" });
    } finally {
      await profiles.close();
      service.close();
    }
  });

  it("maps a service-side session rebind into the mutation acknowledgement", async () => {
    const service = {
      createRecord: async () => ({
        key: "RB-R-001",
        v: 0,
        seq: 1,
        opId: "rebound-op",
        sessionRebound: true,
        session: "successor-session",
      }),
    } as unknown as AyanamiTaskService;
    const server = createAyanamiMcpServer(service, { profile: "memory" });
    const client = new Client({ name: "rebind-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const response = await client.callTool({
        name: "atm_record",
        arguments: {
          project: "RB",
          session: "closed-session",
          op_id: "rebound-op",
          kind: "FACT",
          title: "Rebound",
          summary: "The write continued on the unique successor.",
        },
      });

      expect(response.structuredContent).toMatchObject({
        op_id: "rebound-op",
        session_rebound: true,
        session: "successor-session",
        new_session: "successor-session",
      });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it("publishes and accepts the shared structured evidence contract", async () => {
    const captured: { checklist?: unknown[]; progress?: unknown[] } = {};
    const service = {
      updateChecklist: async (
        _project: string,
        _session: string,
        _opId: string,
        input: { evidence?: unknown[] },
      ) => {
        captured.checklist = input.evidence;
        return {
          sequence: 1,
          checklist: { status: "DONE", version: 1, evidence: input.evidence ?? [] },
          taskVersion: 2,
          opId: "evidence-check",
        };
      },
      addProgress: async (
        _project: string,
        _session: string,
        _opId: string,
        input: { evidence?: unknown[] },
      ) => {
        captured.progress = input.evidence;
        return { key: "EV-T-0001", v: 2, seq: 2, opId: "evidence-progress" };
      },
    } as unknown as AyanamiTaskService;
    const profiles = await connectProfiledClients(service, "evidence-test");
    const { client } = profiles;
    try {
      const memoryListed = await profiles.memoryClient.listTools();
      const evidenceSchemas = [
        (() => {
          const schema = memoryListed.tools.find((tool) => tool.name === "atm_task_patch")!
            .inputSchema as any;
          return {
            root: schema,
            branches:
              schema.properties.items.items.properties.checklist_items.items.properties.evidence
                .items.anyOf,
          };
        })(),
        (() => {
          const schema = memoryListed.tools.find((tool) => tool.name === "atm_progress_add")!
            .inputSchema as any;
          return { root: schema, branches: schema.properties.evidence.items.anyOf };
        })(),
      ];
      for (const { root, branches: rawBranches } of evidenceSchemas) {
        const branches = rawBranches.map((branch: Record<string, any>) =>
          typeof branch.$ref === "string" && branch.$ref.startsWith("#/")
            ? branch.$ref
                .slice(2)
                .split("/")
                .reduce((value: any, segment: string) => value?.[segment], root)
            : branch,
        );
        expect(branches).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "string" }),
            expect.objectContaining({
              type: "object",
              required: ["kind", "value"],
              properties: expect.objectContaining({
                kind: {
                  enum: ["git_sha", "atm_record", "atm_task", "test_result", "url", "file"],
                },
                value: expect.objectContaining({ type: "string" }),
                note: expect.objectContaining({ type: "string" }),
              }),
            }),
          ]),
        );
      }

      const evidence = [
        "legacy evidence",
        { kind: "test_result", value: "14/14 passed", note: "focused MCP gate" },
      ];
      const checklist = await client.callTool({
        name: "atm_task_patch",
        arguments: {
          project: "EV",
          session: "session",
          op_id: "evidence-check",
          items: [
            {
              task_key: "EV-T-0001",
              operation: "checklist_single",
              expected_version: 0,
              checklist_items: [{ id: "check", status: "DONE", evidence }],
            },
          ],
        },
      });
      const progress = await client.callTool({
        name: "atm_progress_add",
        arguments: {
          project: "EV",
          session: "session",
          op_id: "evidence-progress",
          scope: "task",
          task_key: "EV-T-0001",
          summary: "Structured evidence",
          evidence,
        },
      });
      expect(checklist.isError).not.toBe(true);
      expect(progress.isError).not.toBe(true);
      expect(captured).toEqual({ checklist: evidence, progress: evidence });

      const invalid = await client.callTool({
        name: "atm_progress_add",
        arguments: {
          project: "EV",
          session: "session",
          op_id: "evidence-invalid",
          scope: "task",
          task_key: "EV-T-0001",
          summary: "Invalid evidence",
          evidence: [{ kind: "unknown", value: "must be rejected" }],
        },
      });
      expect(invalid.isError).toBe(true);
    } finally {
      await profiles.close();
    }
  });

  it("updates one task checklist atomically through atm_task_patch", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const service = {
      updateChecklistBatch: async (
        project: string,
        session: string,
        opId: string,
        input: Record<string, unknown>,
      ) => {
        captured.push({ project, session, opId, input });
        return {
          taskKey: "BAT-T-0001",
          checklist: [
            { id: "check-1", status: "DONE", version: 1, evidence: ["proof"] },
            { id: "check-2", status: "SKIPPED", version: 1, evidence: [] },
          ],
          taskProgress: 100,
          taskVersion: 4,
          updatedCount: 2,
          sequence: 9,
          opId,
          sessionRebound: true,
          session: "successor-session",
        };
      },
    } as unknown as AyanamiTaskService;
    const server = createAyanamiMcpServer(service, { profile: "memory" });
    const client = new Client({ name: "checklist-batch-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      const schema = listed.tools.find((tool) => tool.name === "atm_task_patch")?.inputSchema as {
        allOf?: Array<{
          if?: { required?: string[]; properties?: Record<string, any> };
          then?: { required?: string[] };
          else?: { required?: string[] };
        }>;
        required?: string[];
        properties?: Record<string, any>;
      };
      const itemSchema = schema.properties?.items?.items;
      expect(schema.required).toEqual(["project", "session", "op_id", "items"]);
      expect(itemSchema.properties?.checklist_items?.items).toMatchObject({
        type: "object",
        required: ["id", "status"],
        properties: {
          id: { type: "string" },
          status: { enum: ["TODO", "DOING", "DONE", "SKIPPED"] },
        },
      });

      const response = await client.callTool({
        name: "atm_task_patch",
        arguments: {
          project: "BAT",
          session: "old-session",
          op_id: "batch-checklist-op",
          items: [
            {
              task_key: "BAT-T-0001",
              expected_version: 3,
              operation: "checklist_batch",
              checklist_items: [
                { id: "check-1", status: "DONE", evidence: ["proof"] },
                { id: "check-2", status: "SKIPPED" },
              ],
            },
          ],
        },
      });

      expect(captured).toEqual([
        {
          project: "BAT",
          session: "old-session",
          opId: "batch-checklist-op",
          input: {
            taskKey: "BAT-T-0001",
            expectedVersion: 3,
            items: [
              { checklistId: "check-1", status: "DONE", evidence: ["proof"] },
              { checklistId: "check-2", status: "SKIPPED" },
            ],
          },
        },
      ]);
      expect(response.structuredContent).toMatchObject({
        ok: true,
        op_id: "batch-checklist-op",
        session_rebound: true,
        session: "successor-session",
        new_session: "successor-session",
        task_key: "BAT-T-0001",
        task_version: 4,
        progress: 100,
        updated_count: 2,
        seq: 9,
      });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it("rejects project-only health on task progress before calling the service", async () => {
    let calls = 0;
    const service = {
      addProgress: async () => {
        calls += 1;
        return { key: "PRG-T-0001", v: 1, seq: 1, opId: "task-health" };
      },
    } as unknown as AyanamiTaskService;
    const server = createAyanamiMcpServer(service, { profile: "memory" });
    const client = new Client({ name: "task-health-contract", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const response = await client.callTool({
        name: "atm_progress_add",
        arguments: {
          project: "PRG",
          session: "session",
          op_id: "task-health",
          scope: "task",
          task_key: "PRG-T-0001",
          summary: "Task progress",
          health: "ON_TRACK",
        },
      });
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response.content)).toContain("health");
      expect(calls).toBe(0);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it("aggregates invalid checklist fields for both single and batch modes", async () => {
    const service = {} as AyanamiTaskService;
    const server = createAyanamiMcpServer(service, { profile: "memory" });
    const client = new Client({ name: "checklist-invalid-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const invalidBatch = await client.callTool({
        name: "atm_task_patch",
        arguments: {
          project: "BAT",
          session: "session",
          op_id: "invalid-batch",
          items: [
            {
              task_key: "BAT-T-0001",
              operation: "checklist_batch",
              expected_version: 3,
              id: "legacy-id",
              status: "DONE",
              checklist_items: [],
            },
          ],
        },
      });
      expect(invalidBatch.isError).toBe(true);
      const batchError = JSON.stringify(invalidBatch.content);
      for (const field of ["checklist_items", "id", "status"]) {
        expect(batchError).toContain(field);
      }

      const invalidSingle = await client.callTool({
        name: "atm_task_patch",
        arguments: {
          project: "BAT",
          session: "session",
          op_id: "invalid-single",
          items: [
            {
              operation: "checklist_single",
              expected_version: 0,
              task_key: "BAT-T-0001",
              checklist_items: [{}, {}],
            },
          ],
        },
      });
      expect(invalidSingle.isError).toBe(true);
      const singleError = JSON.stringify(invalidSingle.content);
      for (const field of ["id", "status", "checklist_items"]) {
        expect(singleError).toContain(field);
      }
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it("routes verify_and_complete through the atomic workflow primitive", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const service = {
      verifyAndComplete: async (
        project: string,
        session: string,
        opId: string,
        input: Record<string, unknown>,
      ) => {
        calls.push({ project, session, opId, input });
        return {
          taskKey: "WF-T-0001",
          fromStatus: "IN_PROGRESS",
          status: "DONE",
          fromVersion: 7,
          taskVersion: 9,
          transitions: ["VERIFYING", "DONE"],
          item: { key: "WF-T-0001", status: "DONE", version: 9 },
          sequence: 18,
          opId,
          sessionRebound: true,
          session: "workflow-successor",
        };
      },
    } as unknown as AyanamiTaskService;
    const server = createAyanamiMcpServer(service, { profile: "memory" });
    const client = new Client({ name: "verify-complete-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      const schema = listed.tools.find((tool) => tool.name === "atm_task_patch")?.inputSchema as {
        properties?: Record<string, any>;
      };
      expect(schema.properties?.items?.items?.properties?.operation).toMatchObject({
        enum: expect.arrayContaining(["verify_and_complete"]),
      });

      const response = await client.callTool({
        name: "atm_task_patch",
        arguments: {
          project: "WF",
          session: "old-session",
          op_id: "verify-complete-op",
          items: [
            {
              task_key: "WF-T-0001",
              expected_version: 7,
              operation: "verify_and_complete",
            },
          ],
        },
      });

      expect(calls).toEqual([
        {
          project: "WF",
          session: "old-session",
          opId: "verify-complete-op",
          input: { taskKey: "WF-T-0001", expectedVersion: 7 },
        },
      ]);
      expect(response.structuredContent).toMatchObject({
        ok: true,
        op_id: "verify-complete-op",
        session_rebound: true,
        session: "workflow-successor",
        new_session: "workflow-successor",
        project: "WF",
        seq: 18,
        items: [
          {
            task_key: "WF-T-0001",
            from_status: "IN_PROGRESS",
            status: "DONE",
            from_version: 7,
            version: 9,
            transitions: ["VERIFYING", "DONE"],
          },
        ],
      });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it("maps conflict-aware expected_fields and structured cancellation", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const service = {
      patchWorkItems: async (
        project: string,
        session: string,
        opId: string,
        items: Array<Record<string, unknown>>,
      ) => {
        calls.push({ project, session, opId, items });
        return {
          sequence: 12,
          items: [
            { key: "SAFE-T-0001", status: "READY", version: 4 },
            { key: "SAFE-T-0002", status: "CANCELLED", version: 8 },
          ],
          opId,
        };
      },
    } as unknown as AyanamiTaskService;
    const server = createAyanamiMcpServer(service, { profile: "memory" });
    const client = new Client({ name: "safe-edit-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      const schema = listed.tools.find((tool) => tool.name === "atm_task_patch")?.inputSchema as {
        properties?: Record<string, any>;
      };
      const itemSchema = schema.properties?.items?.items;
      expect(itemSchema.properties?.expected_fields).toMatchObject({
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          acceptance: { type: "array", items: { type: "string" } },
        },
      });
      expect(itemSchema.properties).toMatchObject({
        acceptance: { type: "array", items: { type: "string" } },
        cancel_reason: { type: "string" },
        duplicate_of: { type: ["string", "null"] },
        superseded_by: { type: ["string", "null"] },
      });

      const response = await client.callTool({
        name: "atm_task_patch",
        arguments: {
          project: "SAFE",
          session: "session",
          op_id: "safe-edit-cancel-op",
          items: [
            {
              task_key: "SAFE-T-0001",
              expected_version: 3,
              operation: "edit",
              expected_fields: {
                title: "Old title",
                acceptance: ["Old acceptance"],
              },
              title: "New title",
              acceptance: ["New acceptance"],
            },
            {
              task_key: "SAFE-T-0002",
              expected_version: 7,
              operation: "cancel",
              cancel_reason: "Duplicate scope",
              duplicate_of: "SAFE-T-0003",
              superseded_by: "SAFE-T-0004",
            },
          ],
        },
      });

      expect(calls).toEqual([
        {
          project: "SAFE",
          session: "session",
          opId: "safe-edit-cancel-op",
          items: [
            {
              taskKey: "SAFE-T-0001",
              expectedVersion: 3,
              expectedFields: { title: "Old title", acceptance: ["Old acceptance"] },
              operation: "edit",
              takeoverStale: false,
              title: "New title",
              acceptance: ["New acceptance"],
            },
            {
              taskKey: "SAFE-T-0002",
              expectedVersion: 7,
              operation: "cancel",
              takeoverStale: false,
              cancelReason: "Duplicate scope",
              duplicateOf: "SAFE-T-0003",
              supersededBy: "SAFE-T-0004",
            },
          ],
        },
      ]);
      expect(response.structuredContent).toMatchObject({
        ok: true,
        op_id: "safe-edit-cancel-op",
        seq: 12,
        items: [
          { key: "SAFE-T-0001", status: "READY", version: 4 },
          { key: "SAFE-T-0002", status: "CANCELLED", version: 8 },
        ],
      });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it("aggregates unsafe edit and composite workflow validation issues", async () => {
    const service = {} as AyanamiTaskService;
    const server = createAyanamiMcpServer(service, { profile: "memory" });
    const client = new Client({ name: "task-patch-invalid-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const unsafeEdit = await client.callTool({
        name: "atm_task_patch",
        arguments: {
          project: "SAFE",
          session: "session",
          op_id: "unsafe-edit",
          items: [
            {
              task_key: "SAFE-T-0001",
              expected_version: 3,
              operation: "edit",
              expected_fields: { title: "Old title" },
              description: "New description",
            },
          ],
        },
      });
      expect(unsafeEdit.isError).toBe(true);
      const editError = JSON.stringify(unsafeEdit.content);
      for (const field of ["expected_fields", "description"]) {
        expect(editError).toContain(field);
      }

      const mixedComposite = await client.callTool({
        name: "atm_task_patch",
        arguments: {
          project: "SAFE",
          session: "session",
          op_id: "mixed-composite",
          items: [
            {
              task_key: "SAFE-T-0001",
              expected_version: 3,
              operation: "verify_and_complete",
              title: "Forbidden extra",
            },
            {
              task_key: "SAFE-T-0002",
              expected_version: 4,
              operation: "cancel",
              cancel_reason: "No longer needed",
            },
          ],
        },
      });
      expect(mixedComposite.isError).toBe(true);
      const compositeError = JSON.stringify(mixedComposite.content);
      for (const field of ["items", "title"]) {
        expect(compositeError).toContain(field);
      }
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it("rejects an invalid acceptance edit before invoking the mutation service", async () => {
    let calls = 0;
    const service = {
      patchWorkItems: async () => {
        calls += 1;
        throw new Error("must not be called");
      },
    } as unknown as AyanamiTaskService;
    const server = createAyanamiMcpServer(service, { profile: "memory" });
    const client = new Client({ name: "invalid-acceptance", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const response = await client.callTool({
        name: "atm_task_patch",
        arguments: {
          project: "SAFE",
          session: "session",
          op_id: "invalid-acceptance",
          items: [
            {
              task_key: "SAFE-T-0001",
              expected_version: 3,
              operation: "edit",
              acceptance: [""],
            },
          ],
        },
      });
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response.content)).toContain("acceptance");
      expect(calls).toBe(0);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
