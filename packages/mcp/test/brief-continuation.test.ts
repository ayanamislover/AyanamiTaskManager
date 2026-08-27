import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { connectProfiledClients } from "./profile-client.js";

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
});

async function fixture(code: string) {
  const dataDir = await mkdtemp(join(tmpdir(), "atm-mcp-whole-brief-"));
  roots.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: join(process.cwd(), "migrations"),
  });
  const project = await service.createProject({
    name: `Whole brief ${code}`,
    sourcePath: null,
    code,
  });
  const setup = await service.begin({
    projectCode: project.code,
    mode: "project",
    agentId: "brief-setup",
    clientKind: "test",
    role: "SUBAGENT",
  });
  const expected = [] as Array<{ key: string; summary: string }>;
  for (let index = 0; index < 8; index += 1) {
    // 181 Unicode code points, including a supplementary-plane character.
    const summary = `${index}:${String.fromCodePoint(0x1f9ea)}${"界".repeat(178)}`;
    const record = await service.createRecord(
      project.code,
      String(setup.session),
      `${code.toLowerCase()}-whole-record-${index}`,
      {
        kind: "FACT",
        title: `Whole record ${index}`,
        summary,
        detail: `detail-${index}`,
        importance: "HIGH",
      },
    );
    expected.push({ key: record.key, summary });
  }
  const profiles = await connectProfiledClients(service, `whole-brief-${code}`);
  return { service, project, setup, profiles, expected: expected.reverse() };
}

function body(
  result: Awaited<ReturnType<ReturnType<typeof connectProfiledClients>["client"]["callTool"]>>,
) {
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return result.structuredContent as Record<string, any>;
}

async function connectFreshCore(service: AyanamiTaskService, name: string) {
  vi.resetModules();
  const { createAyanamiMcpServer } = await import("../src/index.js");
  const server = createAyanamiMcpServer(service, { profile: "core" });
  const client = new Client({ name, version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await Promise.all([client.close(), server.close()]);
    },
  };
}

describe("whole-record brief continuation", () => {
  it("returns every selected Record verbatim when the budget is sufficient", async () => {
    const { service, project, profiles, expected } = await fixture("WBF");
    try {
      const operationId = `whole-begin-${"x".repeat(96)}`;
      const result = body(
        await profiles.coreClient.callTool({
          name: "atm_begin",
          arguments: {
            project_code: project.code,
            mode: "project",
            agent_id: "whole-reader",
            role: "OBSERVER",
            op_id: operationId,
            max_chars: 5000,
          },
        }),
      );

      expect(result.session).toEqual(expect.any(String));
      expect(result.op_id).toBe(operationId);
      expect(result.atomicBegin.operationId).toBe(operationId);
      expect(result.records).toEqual(
        expected.map(({ key, summary }) => expect.objectContaining({ key, summary })),
      );
      expect(
        result.records.every((record: { summary: string }) => !record.summary.endsWith("…")),
      ).toBe(true);
      expect(result.brief_truncated).toBe(false);
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(5000);
    } finally {
      await profiles.close();
      service.close();
    }
  });

  it("omits only complete Records and losslessly resumes the frozen ordered set", async () => {
    const { service, project, setup, profiles, expected } = await fixture("WBC");
    try {
      const request = {
        project_code: project.code,
        session_id: String(setup.session),
        include: ["records"],
        max_chars: 1300,
      };
      const first = body(
        await profiles.coreClient.callTool({ name: "atm_brief", arguments: request }),
      );
      expect(first.truncated).toBe(true);
      expect(first.records.length).toBeGreaterThan(0);
      expect(first.records.length).toBeLessThan(expected.length);
      expect(first.records).toEqual(
        expected
          .slice(0, first.records.length)
          .map(({ key, summary }) => expect.objectContaining({ key, summary })),
      );
      expect(first.omitted_collections).toEqual([
        expect.objectContaining({
          section: "records",
          total_items: expected.length,
          returned_items: first.records.length,
          omitted_items: expected.length - first.records.length,
        }),
      ]);
      expect(first.continuation).toMatchObject({ tool: "atm_brief", cursor: expect.any(String) });
      expect(JSON.stringify(first).length).toBeLessThanOrEqual(request.max_chars);

      const restored = [...first.records];
      let cursor: string | null = first.continuation.cursor;
      while (cursor) {
        const page = body(
          await profiles.coreClient.callTool({
            name: "atm_brief",
            arguments: { ...request, cursor },
          }),
        );
        expect(
          page.records.every((record: { summary: string }) => !record.summary.endsWith("…")),
        ).toBe(true);
        restored.push(...page.records);
        cursor = page.continuation?.cursor ?? null;
      }
      expect(restored).toEqual(
        expected.map(({ key, summary }) => expect.objectContaining({ key, summary })),
      );

      const begun = body(
        await profiles.coreClient.callTool({
          name: "atm_begin",
          arguments: {
            project_code: project.code,
            mode: "project",
            agent_id: "begin-continuation-reader",
            role: "OBSERVER",
            max_chars: request.max_chars,
          },
        }),
      );
      expect(begun.brief_truncated).toBe(true);
      expect(begun.continuation).toMatchObject({ tool: "atm_brief", cursor: expect.any(String) });
      const begunPage = body(
        await profiles.coreClient.callTool({
          name: "atm_brief",
          arguments: {
            project_code: project.code,
            session_id: begun.session,
            max_chars: request.max_chars,
            cursor: begun.continuation.cursor,
          },
        }),
      );
      expect(begunPage.records.length).toBeGreaterThan(0);
      expect(begunPage.records[0]).toEqual(
        expect.objectContaining(expected[begun.records.length]!),
      );
    } finally {
      await profiles.close();
      service.close();
    }
  });

  it("allows budget changes and unrelated progress while rejecting tampering, target changes, expiry, and changed Records", async () => {
    const primary = await fixture("WBP");
    const other = await fixture("WBO");
    try {
      const sessionId = String(primary.setup.session);
      const request = {
        project_code: primary.project.code,
        session_id: sessionId,
        include: ["records"],
        max_chars: 1300,
      };
      const first = body(
        await primary.profiles.coreClient.callTool({ name: "atm_brief", arguments: request }),
      );
      const cursor = String(first.continuation.cursor);

      const failures = [
        {
          arguments: {
            ...request,
            cursor: `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`,
          },
          expected: {
            code: "INVALID_CURSOR",
            details: {
              reason: "INVALID_OR_TAMPERED",
              recovery: { action: "restart_read", omit_cursor: true },
            },
          },
        },
        {
          arguments: { ...request, project_code: other.project.code, cursor },
          expected: {
            code: "CONTINUATION_CONFLICT",
            details: {
              reason: "TARGET_MISMATCH",
              recovery: { action: "retry_original_target", preserve_cursor: true },
            },
          },
        },
        {
          arguments: { ...request, session_id: String(other.setup.session), cursor },
          expected: {
            code: "CONTINUATION_CONFLICT",
            details: {
              reason: "TARGET_MISMATCH",
              recovery: { action: "retry_original_target", preserve_cursor: true },
            },
          },
        },
        {
          arguments: { ...request, include: ["records", "counts"], cursor },
          expected: {
            code: "CONTINUATION_CONFLICT",
            details: {
              reason: "TARGET_MISMATCH",
              recovery: { action: "retry_original_target", preserve_cursor: true },
            },
          },
        },
      ];
      for (const testCase of failures) {
        const failed = await primary.profiles.coreClient.callTool({
          name: "atm_brief",
          arguments: testCase.arguments,
        });
        expect(failed.isError).toBe(true);
        expect(failed.structuredContent).toMatchObject(testCase.expected);
      }

      const largerBudget = body(
        await primary.profiles.coreClient.callTool({
          name: "atm_brief",
          arguments: { ...request, max_chars: 5000, cursor },
        }),
      );
      expect(largerBudget.records.length).toBeGreaterThan(0);
      expect(largerBudget).not.toHaveProperty("snapshot_advanced_from");

      await primary.service.addProjectProgress(
        primary.project.code,
        sessionId,
        "whole-record-unrelated-progress",
        {
          summary: "与正在续读的 Record 集合无关。",
          completed: [],
          next: [],
        },
      );
      const afterUnrelatedProgress = body(
        await primary.profiles.coreClient.callTool({
          name: "atm_brief",
          arguments: { ...request, max_chars: 5000, cursor },
        }),
      );
      expect(afterUnrelatedProgress.records).toEqual(largerBudget.records);
      expect(afterUnrelatedProgress).toMatchObject({
        snapshot_advanced_from: first.seq,
        snapshot_advanced_to: expect.any(Number),
      });

      await primary.service.createRecord(
        primary.project.code,
        sessionId,
        "whole-record-unselected-new",
        {
          kind: "FACT",
          title: "Not selected by brief",
          summary: "NORMAL importance means this new Record is outside the frozen selected set.",
          importance: "NORMAL",
        },
      );
      const afterUnselectedRecord = body(
        await primary.profiles.coreClient.callTool({
          name: "atm_brief",
          arguments: { ...request, max_chars: 5000, cursor },
        }),
      );
      expect(afterUnselectedRecord.records).toEqual(largerBudget.records);
      expect(afterUnselectedRecord.snapshot_advanced_from).toBe(first.seq);
      expect(afterUnselectedRecord.snapshot_advanced_to).toBeGreaterThan(
        afterUnrelatedProgress.snapshot_advanced_to,
      );

      const selectedKey = primary.expected[0]!.key;
      const selectedLocalNo = Number(selectedKey.split("-").at(-1));
      const database = await primary.service.databases.openProject(primary.project.code);
      database.sqlite
        .prepare("UPDATE records SET summary = ? WHERE local_no = ?")
        .run("selected Record modified in place", selectedLocalNo);
      const modified = await primary.profiles.coreClient.callTool({
        name: "atm_brief",
        arguments: { ...request, cursor },
      });
      expect(modified.isError).toBe(true);
      expect(modified.structuredContent).toMatchObject({
        code: "CONTINUATION_CONFLICT",
        details: {
          reason: "STALE",
          recovery: { action: "restart_read", omit_cursor: true },
          record_key: selectedKey,
        },
      });

      const afterModification = body(
        await primary.profiles.coreClient.callTool({ name: "atm_brief", arguments: request }),
      );
      const modifiedCursor = String(afterModification.continuation.cursor);
      await primary.service.createRecord(
        primary.project.code,
        sessionId,
        "whole-record-content-change",
        {
          kind: "FACT",
          title: "Snapshot changed",
          summary: "new selected record",
          importance: "CRITICAL",
          supersedes: selectedKey,
        },
      );
      const superseded = await primary.profiles.coreClient.callTool({
        name: "atm_brief",
        arguments: { ...request, cursor: modifiedCursor },
      });
      expect(superseded.isError).toBe(true);
      expect(superseded.structuredContent).toMatchObject({
        code: "CONTINUATION_CONFLICT",
        details: {
          reason: "STALE",
          recovery: { action: "restart_read", omit_cursor: true },
          record_key: selectedKey,
        },
      });

      const fresh = body(
        await primary.profiles.coreClient.callTool({ name: "atm_brief", arguments: request }),
      );
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 61 * 60 * 1000);
      const expired = await primary.profiles.coreClient.callTool({
        name: "atm_brief",
        arguments: { ...request, cursor: fresh.continuation.cursor },
      });
      expect(expired.isError).toBe(true);
      expect(expired.structuredContent).toMatchObject({
        code: "INVALID_CURSOR",
        details: {
          reason: "EXPIRED",
          recovery: { action: "restart_read", omit_cursor: true },
        },
      });
    } finally {
      await Promise.all([primary.profiles.close(), other.profiles.close()]);
      primary.service.close();
      other.service.close();
    }
  });

  it("reuses a deterministic cursor in a fresh MCP module and rejects legacy tokens", async () => {
    const primary = await fixture("WBD");
    let fresh: Awaited<ReturnType<typeof connectFreshCore>> | undefined;
    try {
      const request = {
        project_code: primary.project.code,
        session_id: String(primary.setup.session),
        include: ["records"],
        max_chars: 1300,
      };
      const first = body(
        await primary.profiles.coreClient.callTool({ name: "atm_brief", arguments: request }),
      );
      const cursor = String(first.continuation.cursor);
      const legacyToken = cursor.split(".").slice(1).join(".");
      const legacy = await primary.profiles.coreClient.callTool({
        name: "atm_brief",
        arguments: { ...request, cursor: legacyToken },
      });
      expect(legacy.isError).toBe(true);
      expect(legacy.structuredContent).toMatchObject({
        code: "INVALID_CURSOR",
        details: {
          reason: "INVALID_OR_TAMPERED",
          recovery: { action: "restart_read", omit_cursor: true },
        },
      });
      await primary.profiles.close();

      fresh = await connectFreshCore(primary.service, "durable-brief-fresh-core");
      const repeated = body(await fresh.client.callTool({ name: "atm_brief", arguments: request }));
      expect(repeated.continuation.cursor).toBe(cursor);
      const continued = body(
        await fresh.client.callTool({
          name: "atm_brief",
          arguments: { ...request, max_chars: 5000, cursor },
        }),
      );
      expect(continued.records.length).toBeGreaterThan(0);
    } finally {
      if (fresh) await fresh.close();
      else await primary.profiles.close();
      primary.service.close();
    }
  });

  it("retains at least one full TTL across a brief expiry-bucket boundary", async () => {
    const primary = await fixture("WBB");
    try {
      const ttl = 30 * 60 * 1000;
      const boundary = (Math.floor(Date.now() / ttl) + 1) * ttl;
      const now = vi.spyOn(Date, "now").mockReturnValue(boundary - 1);
      const request = {
        project_code: primary.project.code,
        session_id: String(primary.setup.session),
        include: ["records"],
        max_chars: 1300,
      };
      const first = body(
        await primary.profiles.coreClient.callTool({ name: "atm_brief", arguments: request }),
      );
      now.mockReturnValue(boundary + 1);
      const continued = await primary.profiles.coreClient.callTool({
        name: "atm_brief",
        arguments: { ...request, max_chars: 5000, cursor: first.continuation.cursor },
      });
      expect(continued.isError, JSON.stringify(continued.content)).not.toBe(true);
    } finally {
      await primary.profiles.close();
      primary.service.close();
    }
  });
});
