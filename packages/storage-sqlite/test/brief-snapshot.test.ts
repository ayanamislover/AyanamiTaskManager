import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager, ProjectRepository } from "../src/index.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("brief snapshot", () => {
  it("keeps complete record summaries and public anchors across the selected record section", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-brief-snapshot-"));
    temporary.push(dataDir);
    const manager = await AyanamiDatabaseManager.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const project = await manager.createProject({
        name: "Brief snapshot",
        sourcePath: null,
        code: "BSNAP",
      });
      const repository = new ProjectRepository(await manager.openProject(project.id));
      const session = repository.createSession({
        agentId: "snapshot-agent",
        displayName: "Snapshot Agent",
        clientKind: "test",
        role: "SUBAGENT",
      });
      const actor = { type: "AGENT" as const, id: "snapshot-agent", sessionId: session.id };
      const created = Array.from({ length: 8 }, (_, index) => {
        const summary = `${index}:` + String.fromCodePoint(0x1f9ea).repeat(298);
        const record = repository.createRecord(actor, `snapshot-record-${index}`, {
          kind: "FACT",
          title: `Snapshot record ${index}`,
          summary,
          importance: "HIGH",
          sourceActorId: `snapshot-source-${index}`,
          sourceSessionId: `snapshot-session-${index}`,
          sourceRef: `snapshot-ref-${index}`,
        });
        return {
          key: record.key,
          summary,
          source_actor_id: `snapshot-source-${index}`,
          source_session_id: `snapshot-session-${index}`,
          source_ref: `snapshot-ref-${index}`,
        };
      });

      const snapshot = repository.briefSnapshot(session.id);

      expect(snapshot.truncated).toBe(false);
      expect(snapshot.seq).toBeGreaterThan(0);
      expect(snapshot.records).toHaveLength(8);
      expect(snapshot.records.map((record) => record.key)).toEqual(
        created.map((record) => record.key).reverse(),
      );
      expect(snapshot.records).toEqual(
        expect.arrayContaining(
          created.map(({ key, summary, source_actor_id, source_session_id, source_ref }) =>
            expect.objectContaining({
              key,
              kind: "FACT",
              summary,
              importance: "HIGH",
              source_type: "AGENT",
              source_actor_id,
              source_session_id,
              source_ref,
            }),
          ),
        ),
      );
      expect(snapshot.records.every((record) => Array.from(record.summary).length === 300)).toBe(
        true,
      );
    } finally {
      manager.close();
    }
  });

  it("keeps the existing budgeted brief degradation separate from the lossless snapshot", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-brief-compat-"));
    temporary.push(dataDir);
    const manager = await AyanamiDatabaseManager.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const project = await manager.createProject({
        name: "Brief compatibility",
        sourcePath: null,
        code: "BCOMP",
      });
      const repository = new ProjectRepository(await manager.openProject(project.id));
      const session = repository.createSession({
        agentId: "compat-agent",
        displayName: "Compatibility Agent",
        clientKind: "test",
        role: "SUBAGENT",
      });
      const actor = { type: "AGENT" as const, id: "compat-agent", sessionId: session.id };
      const summary = "L".repeat(300);
      const record = repository.createRecord(actor, "compat-record", {
        kind: "RISK",
        title: "Compatibility record",
        summary,
        importance: "CRITICAL",
      });

      const snapshot = repository.briefSnapshot(session.id);
      const legacy = repository.brief(session.id, 300);

      expect(snapshot.records).toEqual([expect.objectContaining({ key: record.key, summary })]);
      expect(legacy).toMatchObject({ project: "BCOMP", truncated: true });
      expect(legacy.records).toHaveLength(1);
      expect(legacy.records[0]).not.toHaveProperty("key");
    } finally {
      manager.close();
    }
  });
});
