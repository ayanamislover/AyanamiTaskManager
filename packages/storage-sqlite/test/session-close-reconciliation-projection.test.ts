import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AyanamiDatabaseManager, ProjectRepository } from "../src/index.js";

const temporary: string[] = [];
const managers: AyanamiDatabaseManager[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const manager of managers.splice(0)) manager.close();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function fixture(code: string): Promise<{
  repository: ProjectRepository;
  session: { id: string };
  actor: { type: "AGENT"; id: string; sessionId: string };
  objectiveId: string;
}> {
  const root = mkdtempSync(join(tmpdir(), `atm-session-close-${code.toLowerCase()}-`));
  temporary.push(root);
  const manager = await AyanamiDatabaseManager.open({
    dataDir: join(root, "data"),
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  managers.push(manager);
  const project = await manager.createProject({ name: code, sourcePath: null, code });
  const repository = new ProjectRepository(await manager.openProject(project.code));
  const session = repository.createSession({
    agentId: `${code.toLowerCase()}-agent`,
    displayName: `${code} Agent`,
    clientKind: "test",
    role: "SUBAGENT",
  });
  const actor = {
    type: "AGENT" as const,
    id: `${code.toLowerCase()}-agent`,
    sessionId: session.id,
  };
  const objective = repository.createObjective(actor, {
    title: `${code} objective`,
    description: "",
    definitionOfDone: [],
  });
  return { repository, session, actor, objectiveId: objective.id };
}

function at(value: string): void {
  vi.setSystemTime(new Date(value));
}

function handleAndRelease(
  repository: ProjectRepository,
  actor: { type: "AGENT"; id: string; sessionId: string },
  objectiveId: string,
  operationPrefix: string,
): ReturnType<ProjectRepository["getWorkItem"]> {
  const task = repository.createWorkItems(actor, `${operationPrefix}-create`, [
    {
      clientRef: operationPrefix,
      objectiveId,
      title: `${operationPrefix} handled task`,
      type: "TASK",
      priority: "NORMAL",
      status: "READY",
    },
  ]).items[0]!;
  const claimed = repository.patchWorkItems(actor, `${operationPrefix}-claim`, [
    { taskKey: task.key, expectedVersion: task.version, operation: "claim" },
  ]).items[0]!;
  const started = repository.patchWorkItems(actor, `${operationPrefix}-start`, [
    { taskKey: task.key, expectedVersion: claimed.version, operation: "start" },
  ]).items[0]!;
  repository.patchWorkItems(actor, `${operationPrefix}-release`, [
    { taskKey: task.key, expectedVersion: started.version, operation: "release" },
  ]);
  return repository.getWorkItem(task.key);
}

describe("Session close reconciliation projection", () => {
  it("endSession updates every historically handled task without mutating its business revision", async () => {
    vi.useFakeTimers();
    const { repository, session, actor, objectiveId } = await fixture("SCEND");
    at("2026-08-27T01:00:00.000Z");
    const first = handleAndRelease(repository, actor, objectiveId, "first");
    const second = handleAndRelease(repository, actor, objectiveId, "second");
    const untouched = repository.createWorkItems(actor, "untouched-create", [
      {
        clientRef: "untouched",
        objectiveId,
        title: "Untouched task",
        type: "TASK",
        priority: "LOW",
        status: "READY",
      },
    ]).items[0]!;
    expect(first.claimedBySessionId).toBeNull();
    expect(second.claimedBySessionId).toBeNull();

    at("2026-08-27T02:00:00.000Z");
    repository.endSession(actor, "close-with-history", {
      outcome: "completed",
      summary: "done",
      releaseClaims: false,
    });

    for (const task of [first, second]) {
      expect(repository.getWorkItem(task.key)).toMatchObject({
        lastSessionClosedAt: "2026-08-27T02:00:00.000Z",
        version: task.version,
        updatedAt: task.updatedAt,
      });
    }
    expect(repository.getWorkItem(untouched.key).lastSessionClosedAt).toBeNull();

    at("2026-08-27T03:00:00.000Z");
    repository.forceCloseSession(session.id, false);
    expect(repository.getSession(session.id).closed_at).toBe("2026-08-27T02:00:00.000Z");
    for (const task of [first, second]) {
      expect(repository.getWorkItem(task.key)).toMatchObject({
        lastSessionClosedAt: "2026-08-27T02:00:00.000Z",
        version: task.version,
        updatedAt: task.updatedAt,
      });
    }
  });

  it("forceCloseSession reuses the first persisted closed_at across repeated calls", async () => {
    vi.useFakeTimers();
    const { repository, session, actor, objectiveId } = await fixture("SCFORCE");
    at("2026-08-27T01:00:00.000Z");
    const task = handleAndRelease(repository, actor, objectiveId, "forced");

    at("2026-08-27T02:00:00.000Z");
    repository.forceCloseSession(session.id, false);
    expect(repository.getSession(session.id).closed_at).toBe("2026-08-27T02:00:00.000Z");
    expect(repository.getWorkItem(task.key)).toMatchObject({
      lastSessionClosedAt: "2026-08-27T02:00:00.000Z",
      version: task.version,
      updatedAt: task.updatedAt,
    });

    at("2026-08-27T03:00:00.000Z");
    repository.endSession(actor, "end-after-force-close", {
      outcome: "completed",
      summary: "closed through another route",
      releaseClaims: false,
    });
    expect(repository.getSession(session.id).closed_at).toBe("2026-08-27T02:00:00.000Z");
    expect(repository.getWorkItem(task.key)).toMatchObject({
      lastSessionClosedAt: "2026-08-27T02:00:00.000Z",
      version: task.version,
      updatedAt: task.updatedAt,
    });

    at("2026-08-27T04:00:00.000Z");
    repository.forceCloseSession(session.id, false);
    expect(repository.getSession(session.id).closed_at).toBe("2026-08-27T02:00:00.000Z");
    expect(repository.getWorkItem(task.key)).toMatchObject({
      lastSessionClosedAt: "2026-08-27T02:00:00.000Z",
      version: task.version,
      updatedAt: task.updatedAt,
    });
  });

  it("recoverStaleSessions writes once and repeated recovery does not drift closed time", async () => {
    vi.useFakeTimers();
    const { repository, session, actor, objectiveId } = await fixture("SCRECOVER");
    at("2026-08-27T01:00:00.000Z");
    const task = handleAndRelease(repository, actor, objectiveId, "recovered");

    at("2026-08-27T02:00:00.000Z");
    expect(repository.recoverStaleSessions("2999-01-01T00:00:00.000Z")).toBe(1);
    expect(repository.getSession(session.id).closed_at).toBe("2026-08-27T02:00:00.000Z");
    expect(repository.getWorkItem(task.key)).toMatchObject({
      lastSessionClosedAt: "2026-08-27T02:00:00.000Z",
      version: task.version,
      updatedAt: task.updatedAt,
    });

    repository.database.sqlite
      .prepare("UPDATE agent_sessions SET connection_state = 'ONLINE' WHERE id = ?")
      .run(session.id);
    at("2026-08-27T03:00:00.000Z");
    expect(repository.recoverStaleSessions("2999-01-01T00:00:00.000Z")).toBe(1);
    expect(repository.getSession(session.id).closed_at).toBe("2026-08-27T02:00:00.000Z");
    expect(repository.getWorkItem(task.key).lastSessionClosedAt).toBe("2026-08-27T02:00:00.000Z");

    at("2026-08-27T04:00:00.000Z");
    expect(repository.recoverStaleSessions("2999-01-01T00:00:00.000Z")).toBe(0);
  });

  it("uses the v15 partial lifecycle index for Session-scoped handled-task lookup", async () => {
    const { repository, session } = await fixture("SCINDEX");
    const plan = repository.database.sqlite
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT event.aggregate_id
         FROM events AS event INDEXED BY idx_events_work_session_lifecycle
         WHERE event.session_id = ?
           AND event.aggregate_type = 'WORK_ITEM'
           AND event.type IN ('work.claimed', 'work.started')
         GROUP BY event.aggregate_id`,
      )
      .all(session.id) as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join("\n")).toContain("idx_events_work_session_lifecycle");
  });
});
