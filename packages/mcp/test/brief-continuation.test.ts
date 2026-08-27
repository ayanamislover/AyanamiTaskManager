import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { connectProfiledClients } from "./profile-client.js";

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
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

  it("fails closed for tampering, target/query mismatch, expiry, and snapshot changes", async () => {
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
        { ...request, cursor: `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}` },
        { ...request, project_code: other.project.code, cursor },
        { ...request, session_id: String(other.setup.session), cursor },
        { ...request, include: ["records", "counts"], cursor },
        { ...request, max_chars: 1400, cursor },
      ];
      for (const arguments_ of failures) {
        const failed = await primary.profiles.coreClient.callTool({
          name: "atm_brief",
          arguments: arguments_,
        });
        expect(failed.isError).toBe(true);
        expect(JSON.stringify(failed.content)).toMatch(/INVALID_CURSOR|CONTINUATION_CONFLICT/u);
      }

      await primary.service.createRecord(
        primary.project.code,
        sessionId,
        "whole-record-content-change",
        {
          kind: "FACT",
          title: "Snapshot changed",
          summary: "new selected record",
          importance: "CRITICAL",
        },
      );
      const changed = await primary.profiles.coreClient.callTool({
        name: "atm_brief",
        arguments: { ...request, cursor },
      });
      expect(changed.isError).toBe(true);
      expect(JSON.stringify(changed.content)).toMatch(/CONTINUATION_CONFLICT.*SNAPSHOT_CHANGED/u);

      const fresh = body(
        await primary.profiles.coreClient.callTool({ name: "atm_brief", arguments: request }),
      );
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 31 * 60 * 1000);
      const expired = await primary.profiles.coreClient.callTool({
        name: "atm_brief",
        arguments: { ...request, cursor: fresh.continuation.cursor },
      });
      expect(expired.isError).toBe(true);
      expect(JSON.stringify(expired.content)).toMatch(/INVALID_CURSOR.*EXPIRED/u);
    } finally {
      await Promise.all([primary.profiles.close(), other.profiles.close()]);
      primary.service.close();
      other.service.close();
    }
  });
});
