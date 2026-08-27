import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AyanamiTaskService } from "@ayanami-task/application";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAyanamiMcpServer } from "../src/index.js";
import { connectProfiledClients } from "./profile-client.js";
import {
  dereferencePublishedSchema,
  publishedOperationVariant,
} from "./published-operation-schema.js";

const roots: string[] = [];
const fixedMutationAckKeys = [
  "details_cursor",
  "entities",
  "entities_truncated",
  "entity_count",
  "ok",
  "op_id",
  "project",
  "session",
  "session_rebound",
] as const;

function expectFixedMutationAck(
  response: { structuredContent?: unknown },
  expected: { project: string; session: string; opId: string; rebound?: boolean },
) {
  const acknowledgement = response.structuredContent as Record<string, any>;
  expect(Object.keys(acknowledgement).sort()).toEqual([...fixedMutationAckKeys].sort());
  expect(acknowledgement).toMatchObject({
    ok: true,
    project: expected.project,
    session: expected.session,
    session_rebound: expected.rebound ?? false,
    op_id: expected.opId,
    details_cursor: {
      name: "atm_search",
      arguments: {
        project: expected.project,
        session: expected.session,
        op_id: expected.opId,
        field_mask: ["op_id", "entities"],
        max_chars: 50_000,
      },
    },
  });
}

function dereferenceSchema(schema: Record<string, any>, root: Record<string, any>) {
  let current = schema;
  const seen = new Set<string>();
  while (typeof current?.$ref === "string" && current.$ref.startsWith("#/")) {
    if (seen.has(current.$ref)) throw new Error(`CYCLIC_TEST_SCHEMA_REF:${current.$ref}`);
    seen.add(current.$ref);
    current = current.$ref
      .slice(2)
      .split("/")
      .reduce((value: any, segment: string) => value?.[segment], root);
  }
  return current;
}

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
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
      expectFixedMutationAck(created, {
        project: project.code,
        session,
        opId: "create-ack-exact",
      });
      expect(created.structuredContent).toMatchObject({ op_id: "create-ack-exact" });
      const taskKey = String(
        (
          created.structuredContent as {
            entities: Array<{ entity_type: string; key: string }>;
          }
        ).entities.find((entity) => entity.entity_type === "WORK_ITEM")!.key,
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
      expectFixedMutationAck(patched, {
        project: project.code,
        session,
        opId: "patch-ack-exact",
      });
      expect(patched.structuredContent).toMatchObject({ op_id: "patch-ack-exact" });

      const detail = await service.getWorkItem(project.code, taskKey, "full");
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
      expectFixedMutationAck(checklist, {
        project: project.code,
        session,
        opId: "checklist-ack-exact",
      });
      expect(checklist.structuredContent).toMatchObject({
        op_id: "checklist-ack-exact",
        entities: expect.arrayContaining([
          expect.objectContaining({ entity_type: "WORK_ITEM", key: taskKey }),
          expect.objectContaining({ entity_type: "CHECKLIST", key: detail.checklist[0]!.id }),
        ]),
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
      expectFixedMutationAck(progress, {
        project: project.code,
        session,
        opId: "progress-ack-exact",
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
              expected_version: (
                progress.structuredContent as {
                  entities: Array<{ entity_type: string; version: number }>;
                }
              ).entities.find((entity) => entity.entity_type === "WORK_ITEM")!.version,
              operation: "verify_and_complete",
            },
          ],
        },
      });
      expectFixedMutationAck(completed, {
        project: project.code,
        session,
        opId: "verify-complete-ack-exact",
      });
      expect(completed.structuredContent).toMatchObject({
        op_id: "verify-complete-ack-exact",
        entities: [expect.objectContaining({ entity_type: "WORK_ITEM", key: taskKey })],
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
      expectFixedMutationAck(record, {
        project: project.code,
        session,
        opId: "record-ack-exact",
      });
      expect(record.structuredContent).toMatchObject({
        op_id: "record-ack-exact",
        entities: [expect.objectContaining({ entity_type: "RECORD" })],
      });
      const recordKey = String(
        (
          record.structuredContent as {
            entities: Array<{ entity_type: string; key: string }>;
          }
        ).entities.find((entity) => entity.entity_type === "RECORD")!.key,
      );

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
      expectFixedMutationAck(publicKeyEvidence, {
        project: project.code,
        session,
        opId: "progress-public-key-evidence",
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
      expectFixedMutationAck(ended, {
        project: project.code,
        session,
        opId: "end-ack-exact",
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
        entities: [{ entity_type: "RECORD", key: "RB-R-001", version: 0 }],
      });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it("ends 521 claims with complete metrics input and a durable paged mutation receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "atm-mcp-end-scale-"));
    roots.push(root);
    const dataDir = join(root, "data");
    const sourcePath = join(root, "source");
    mkdirSync(sourcePath, { recursive: true });
    writeFileSync(join(sourcePath, "README.md"), "# scale fixture\n");
    for (const args of [
      ["init"],
      ["config", "user.email", "atm@example.test"],
      ["config", "user.name", "ATM Test"],
      ["add", "-A"],
      ["commit", "-m", "baseline"],
    ]) {
      execFileSync("git", args, { cwd: sourcePath, stdio: "ignore", windowsHide: true });
    }

    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    const project = await service.createProject({
      name: "End scale",
      sourcePath: null,
      code: "ENDSCALE",
    });
    const objective = await service.createObjectiveAsUser(project.code, "end-scale-objective", {
      title: "Release every claim",
      description: "",
      definitionOfDone: [],
    });
    const tasks = [];
    for (let offset = 0; offset < 521; offset += 50) {
      const batchSize = Math.min(50, 521 - offset);
      tasks.push(
        ...(
          await service.createWorkItemsAsUser(
            project.code,
            `end-scale-create-${offset}`,
            Array.from({ length: batchSize }, (_, index) => ({
              clientRef: `end-scale-${offset + index}`,
              objectiveId: objective.id,
              title: `Release claim ${offset + index + 1}`,
              description: "",
              type: "TASK" as const,
              priority: "NORMAL" as const,
              status: "READY" as const,
              acceptance: [],
              checklist: [],
              verificationRequired: false,
            })),
          )
        ).items,
      );
    }
    const begun = await service.begin({
      projectCode: project.code,
      mode: "project",
      agentId: "end-scale-agent",
      clientKind: "test",
    });
    const session = String(begun.session);
    for (let offset = 0; offset < tasks.length; offset += 50) {
      await service.patchWorkItems(
        project.code,
        session,
        `end-scale-claim-${offset}`,
        tasks.slice(offset, offset + 50).map((task) => ({
          taskKey: task.key,
          expectedVersion: task.version,
          operation: "claim" as const,
        })),
      );
    }
    service.attachProjectPath(project.code, sourcePath);
    const metricsSpy = vi.spyOn(service.databases, "workItemEngineeringMetrics");
    const profiles = await connectProfiledClients(service, "end-scale-contract-test");
    try {
      const ended = await profiles.client.callTool({
        name: "atm_end",
        arguments: {
          project: project.code,
          session,
          op_id: "end-scale-receipt",
          outcome: "completed",
          summary: "Release every claim",
        },
      });
      expectFixedMutationAck(ended, {
        project: project.code,
        session,
        opId: "end-scale-receipt",
      });
      expect(ended.structuredContent).toMatchObject({
        entity_count: 522,
        entities_truncated: true,
      });

      const capturedMetricKeys = new Set(metricsSpy.mock.calls.map((call) => String(call[1])));
      expect(capturedMetricKeys).toEqual(new Set(tasks.map((task) => task.key)));

      const details = await profiles.client.callTool({
        name: "atm_search",
        arguments: {
          project: project.code,
          session,
          op_id: "end-scale-receipt",
          field_mask: ["op_id", "entities"],
          max_chars: 50_000,
        },
      });
      const operation = (details.structuredContent as Record<string, any>).operation;
      expect(operation.op_id).toBe("end-scale-receipt");
      expect(operation.entities).toHaveLength(522);
      expect(
        new Set(
          operation.entities
            .filter((entity: Record<string, unknown>) => entity.entity_type === "WORK_ITEM")
            .map((entity: Record<string, unknown>) => entity.key),
        ),
      ).toEqual(new Set(tasks.map((task) => task.key)));
    } finally {
      await profiles.close();
      service.close();
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
      const actionsListed = await profiles.actionsClient.listTools();
      const evidenceSchemas = [
        (() => {
          const schema = actionsListed.tools.find((tool) => tool.name === "atm_task_patch")!
            .inputSchema as any;
          const variant = publishedOperationVariant(schema, "checklist_single");
          const checklist = dereferencePublishedSchema(variant.properties.checklist_items, schema);
          const checklistItem = dereferencePublishedSchema(checklist.items, schema);
          const evidence = dereferencePublishedSchema(checklistItem.properties.evidence, schema);
          return { root: schema, branches: evidence.items.anyOf };
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
              required: ["kind", "value"],
              properties: expect.objectContaining({
                kind: expect.objectContaining({
                  enum: ["git_sha", "atm_record", "atm_task", "test_result", "url", "file"],
                }),
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
    const server = createAyanamiMcpServer(service, { profile: "actions" });
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
      const itemSchema = publishedOperationVariant(schema, "checklist_batch");
      expect(schema.required).toEqual(["project", "session", "op_id", "items"]);
      const checklist = dereferencePublishedSchema(itemSchema.properties.checklist_items, schema);
      expect(dereferencePublishedSchema(checklist.items, schema)).toMatchObject({
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
        entity_count: 3,
        entities: [
          { entity_type: "WORK_ITEM", key: "BAT-T-0001", version: 4 },
          { entity_type: "CHECKLIST", key: "check-1", version: 1 },
          { entity_type: "CHECKLIST", key: "check-2", version: 1 },
        ],
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
    const server = createAyanamiMcpServer(service, { profile: "actions" });
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
      for (const field of ["items"]) {
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
      for (const field of ["items"]) {
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
    const server = createAyanamiMcpServer(service, { profile: "actions" });
    const client = new Client({ name: "verify-complete-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      const schema = listed.tools.find((tool) => tool.name === "atm_task_patch")?.inputSchema as {
        properties?: Record<string, any>;
      };
      expect(publishedOperationVariant(schema, "verify_and_complete").properties).toHaveProperty(
        "operation",
      );

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
        project: "WF",
        entities: [{ entity_type: "WORK_ITEM", key: "WF-T-0001", version: 9 }],
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
    const server = createAyanamiMcpServer(service, { profile: "actions" });
    const client = new Client({ name: "safe-edit-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      const schema = listed.tools.find((tool) => tool.name === "atm_task_patch")?.inputSchema as {
        properties?: Record<string, any>;
      };
      const itemSchema = publishedOperationVariant(schema, "edit");
      const cancelSchema = publishedOperationVariant(schema, "cancel");
      const expectedFields = dereferenceSchema(itemSchema.properties?.expected_fields, schema);
      expect(expectedFields).toMatchObject({
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
        },
      });
      expect(dereferenceSchema(expectedFields.properties.acceptance, schema)).toMatchObject({
        type: "array",
        items: { type: "string" },
      });
      expect(dereferenceSchema(itemSchema.properties.acceptance, schema)).toMatchObject({
        type: "array",
        items: { type: "string" },
      });
      expect(dereferenceSchema(cancelSchema.properties.cancel_reason, schema)).toMatchObject({
        type: "string",
      });
      for (const field of ["duplicate_of", "superseded_by"] as const) {
        expect(dereferenceSchema(cancelSchema.properties[field], schema).type).toEqual([
          "string",
          "null",
        ]);
      }

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
        entity_count: 2,
        entities: [
          { entity_type: "WORK_ITEM", key: "SAFE-T-0001", version: 4 },
          { entity_type: "WORK_ITEM", key: "SAFE-T-0002", version: 8 },
        ],
      });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it("aggregates unsafe edit and composite workflow validation issues", async () => {
    const service = {} as AyanamiTaskService;
    const server = createAyanamiMcpServer(service, { profile: "actions" });
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
      for (const field of ["items"]) {
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
    const server = createAyanamiMcpServer(service, { profile: "actions" });
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
