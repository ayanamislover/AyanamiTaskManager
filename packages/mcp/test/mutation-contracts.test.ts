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
    const server = createAyanamiMcpServer(service);
    const client = new Client({ name: "mutation-contract-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
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
        name: "atm_checklist",
        arguments: {
          project: project.code,
          session,
          op_id: "checklist-ack-exact",
          id: detail.checklist[0]!.id,
          expected_version: 0,
          status: "DONE",
          evidence: ["focused-test"],
        },
      });
      expect(checklist.structuredContent).toMatchObject({ op_id: "checklist-ack-exact" });

      const progress = await client.callTool({
        name: "atm_progress_add",
        arguments: {
          project: project.code,
          session,
          op_id: "progress-ack-exact",
          scope: "task",
          task_key: taskKey,
          percent: 50,
          summary: "Mutation ACK progress",
        },
      });
      expect(progress.structuredContent).toMatchObject({ op_id: "progress-ack-exact" });

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
          op_id: "record-ack-exact",
          session,
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
        arguments: { project: project.code, since_seq: 0, limit: 100 },
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
          outcome: "paused",
          summary: "Mutation ACK test finished",
        },
      });
      expect(ended.structuredContent).toMatchObject({ op_id: "end-ack-exact" });
    } finally {
      await Promise.all([client.close(), server.close()]);
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
    const server = createAyanamiMcpServer(service);
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
    const server = createAyanamiMcpServer(service);
    const client = new Client({ name: "evidence-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      for (const toolName of ["atm_checklist", "atm_progress_add"]) {
        const schema = listed.tools.find((tool) => tool.name === toolName)?.inputSchema as {
          properties?: Record<string, { items?: { anyOf?: Array<Record<string, any>> } }>;
        };
        const branches = schema.properties?.evidence?.items?.anyOf ?? [];
        expect(branches).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "string" }),
            expect.objectContaining({
              type: "object",
              required: ["kind", "value"],
              properties: expect.objectContaining({
                kind: {
                  type: "string",
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
        name: "atm_checklist",
        arguments: {
          project: "EV",
          session: "session",
          op_id: "evidence-check",
          id: "check",
          expected_version: 0,
          status: "DONE",
          evidence,
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
      await Promise.all([client.close(), server.close()]);
    }
  });
});
