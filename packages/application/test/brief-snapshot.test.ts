import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "../src/index.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("application brief snapshot", () => {
  it("exposes the storage snapshot without clipping record summaries or public keys", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-app-brief-snapshot-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const project = await service.createProject({
        name: "Application snapshot",
        sourcePath: null,
        code: "ASNAP",
      });
      const begun = await service.begin({
        projectCode: project.code,
        mode: "project",
        agentId: "application-snapshot-agent",
        clientKind: "test",
        role: "SUBAGENT",
      });
      const summary = "应用快照" + String.fromCodePoint(0x1f4cc).repeat(296);
      const record = await service.createRecord(
        project.code,
        String(begun.session),
        "application-snapshot-record",
        {
          kind: "DECISION",
          title: "Application snapshot record",
          summary,
          importance: "HIGH",
        },
      );

      const snapshot = await service.briefSnapshot(project.code, String(begun.session));

      expect(snapshot).toMatchObject({ project: project.code, truncated: false });
      expect(snapshot.records).toEqual([
        expect.objectContaining({
          key: record.key,
          kind: "DECISION",
          summary,
          source_type: "AGENT",
          source_actor_id: "application-snapshot-agent",
          source_session_id: String(begun.session),
          source_ref: null,
        }),
      ]);
    } finally {
      service.close();
    }
  });
});
