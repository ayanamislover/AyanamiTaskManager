import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager, ProjectRepository } from "../src/index.js";
import { captureAtmError } from "./typed-error-test-helpers.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function fixture(code: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "atm-exact-read-"));
  temporary.push(dataDir);
  const manager = await AyanamiDatabaseManager.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  const project = await manager.createProject({ name: "Exact read", sourcePath: null, code });
  const managed = await manager.openProject(project.code);
  const repository = new ProjectRepository(managed);
  const session = repository.createSession({
    agentId: "exact-read-agent",
    displayName: "Exact Read Agent",
    clientKind: "test",
    role: "PRIMARY",
  });
  const actor = { type: "AGENT" as const, id: "exact-read-agent", sessionId: session.id };
  return { manager, managed, repository, session, actor };
}

describe("exact entity reads", () => {
  it("reads one complete progress update by its stable ULID and fails closed for unknown ids", async () => {
    const { manager, managed, repository, session, actor } = await fixture("XPROG");
    try {
      const objective = repository.createObjective(actor, {
        title: "Exact progress",
        description: "",
        definitionOfDone: [],
      });
      const task = repository.createWorkItems(actor, "exact-progress-task", [
        {
          clientRef: "task",
          objectiveId: objective.id,
          title: "Keep the complete payload",
          type: "TASK",
          priority: "HIGH",
          status: "READY",
        },
      ]).items[0]!;
      const evidence = [
        { kind: "atm_task", value: task.key, note: "stable task reference" },
        { kind: "git_sha", value: "abc1234" },
      ];
      const result = repository.addProgress(actor, "exact-progress-op", {
        taskKey: task.key,
        percent: 47,
        summary: "完整进度，不经过全文检索或摘要截断。",
        completed: [{ text: "完成精确读取 RED", workItemKey: task.key }],
        next: ["实现公开 repository/service 接口"],
        blocker: null,
        evidence,
      });

      const stored = managed.sqlite
        .prepare("SELECT id FROM progress_updates WHERE op_id = ?")
        .get("exact-progress-op") as { id: string };
      expect(result).toMatchObject({ progressId: stored.id });
      expect(repository.getProgressUpdate(stored.id)).toEqual({
        id: stored.id,
        taskKey: task.key,
        percent: 47,
        progressBucket: 50,
        summary: "完整进度，不经过全文检索或摘要截断。",
        completed: [{ text: "完成精确读取 RED", workItemKey: task.key }],
        next: ["实现公开 repository/service 接口"],
        blocker: null,
        actor: actor.id,
        sessionId: session.id,
        evidence,
        opId: "exact-progress-op",
        createdAt: expect.any(String),
      });
      expect(
        captureAtmError(() => repository.getProgressUpdate("01UNKNOWNPROGRESSULID0000000")),
      ).toMatchObject({
        code: "PROGRESS_NOT_FOUND",
        details: { entity: "PROGRESS", reference: "01UNKNOWNPROGRESSULID0000000" },
      });
    } finally {
      manager.close();
    }
  });

  it("filters every operation-trace collection by the requested real Session", async () => {
    const { manager, repository, actor: firstActor } = await fixture("XTRACE");
    try {
      const secondSession = repository.createSession({
        agentId: "second-trace-agent",
        displayName: "Second Trace Agent",
        clientKind: "test",
        role: "SUBAGENT",
      });
      const secondActor = {
        type: "AGENT" as const,
        id: "second-trace-agent",
        sessionId: secondSession.id,
      };
      const objective = repository.createObjective(firstActor, {
        title: "Trace filtering",
        description: "",
        definitionOfDone: [],
      });
      const task = repository.createWorkItems(firstActor, "trace-filter-task", [
        {
          clientRef: "task",
          objectiveId: objective.id,
          title: "Trace both sessions",
          type: "TASK",
          priority: "NORMAL",
          status: "READY",
        },
      ]).items[0]!;

      repository.createRecord(firstActor, "shared-record-op", {
        kind: "FACT",
        title: "first record",
        summary: "owned by first Session",
      });
      repository.createRecord(secondActor, "shared-record-op", {
        kind: "FACT",
        title: "second record",
        summary: "owned by second Session",
      });
      const firstRecordTrace = repository.getOperationTrace(
        "shared-record-op",
        firstActor.sessionId,
      );
      expect(firstRecordTrace.mutations).toHaveLength(1);
      expect(firstRecordTrace.records).toEqual([
        expect.objectContaining({ summary: "owned by first Session" }),
      ]);
      expect(firstRecordTrace.events).toEqual([
        expect.objectContaining({ sessionId: firstActor.sessionId }),
      ]);
      expect(repository.getOperationTrace("shared-record-op").records).toHaveLength(2);

      repository.addProgress(firstActor, "shared-progress-op", {
        taskKey: task.key,
        percent: 10,
        summary: "first progress",
      });
      repository.addProgress(secondActor, "shared-progress-op", {
        taskKey: task.key,
        percent: 20,
        summary: "second progress",
      });
      const firstProgressTrace = repository.getOperationTrace(
        "shared-progress-op",
        firstActor.sessionId,
      );
      expect(firstProgressTrace.mutations).toHaveLength(1);
      expect(firstProgressTrace.progress).toEqual([
        expect.objectContaining({ summary: "first progress", sessionId: firstActor.sessionId }),
      ]);
      expect(firstProgressTrace.events).toEqual([
        expect.objectContaining({ sessionId: firstActor.sessionId }),
      ]);
      expect(repository.getOperationTrace("shared-progress-op").progress).toHaveLength(2);

      repository.publishProjectUpdate(firstActor, "shared-project-op", {
        health: "ON_TRACK",
        summary: "first project update",
      });
      repository.publishProjectUpdate(secondActor, "shared-project-op", {
        health: "AT_RISK",
        summary: "second project update",
      });
      const firstProjectTrace = repository.getOperationTrace(
        "shared-project-op",
        firstActor.sessionId,
      );
      expect(firstProjectTrace.mutations).toHaveLength(1);
      expect(firstProjectTrace.projectUpdates).toEqual([
        expect.objectContaining({
          summary: "first project update",
          sessionId: firstActor.sessionId,
        }),
      ]);
      expect(firstProjectTrace.events).toEqual([
        expect.objectContaining({ sessionId: firstActor.sessionId }),
      ]);
      expect(repository.getOperationTrace("shared-project-op").projectUpdates).toHaveLength(2);

      expect(() =>
        repository.getOperationTrace("shared-record-op", secondSession.id),
      ).not.toThrow();
      expect(
        captureAtmError(() =>
          repository.getOperationTrace("shared-record-op", "01UNKNOWNSESSIONULID00000000"),
        ),
      ).toMatchObject({
        code: "SESSION_NOT_FOUND",
        details: { entity: "SESSION", reference: "01UNKNOWNSESSIONULID00000000" },
      });
    } finally {
      manager.close();
    }
  });
});
