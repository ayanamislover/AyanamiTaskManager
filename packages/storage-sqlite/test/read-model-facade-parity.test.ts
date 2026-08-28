import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AyanamiDatabaseManager } from "../src/manager.js";
import { ProjectRepository, type BriefSnapshot } from "../src/project-repository.js";

const temporary: string[] = [];
const managers: AyanamiDatabaseManager[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const manager of managers.splice(0)) manager.close();
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function fixture(code: string) {
  const root = mkdtempSync(join(tmpdir(), `atm-read-facade-${code.toLowerCase()}-`));
  temporary.push(root);
  const manager = await AyanamiDatabaseManager.open({
    dataDir: join(root, "data"),
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  managers.push(manager);
  const project = await manager.createProject({ name: code, sourcePath: null, code });
  const database = await manager.openProject(project.code);
  return { manager, database, repository: new ProjectRepository(database) };
}

describe("Read-model facade parity", () => {
  it("keeps public readers as prototype methods and read modules free of facade imports", () => {
    for (const method of [
      "getSession",
      "getSessionView",
      "listAgentSessionPage",
      "listAgentSessions",
      "countAgentSessions",
      "listRecordPage",
      "listRecords",
      "getRecord",
      "getProgressUpdate",
      "getWorkItem",
      "listTaskViewPage",
      "listWorkItemPage",
      "listTaskViewRows",
      "getTaskViewRow",
      "listWorkItems",
      "workItemSuggestionCandidates",
      "pendingOutbox",
      "briefSnapshot",
      "brief",
    ]) {
      expect(Object.getOwnPropertyDescriptor(ProjectRepository.prototype, method)?.value).toEqual(
        expect.any(Function),
      );
    }
    expect(
      Object.getOwnPropertyDescriptor(AyanamiDatabaseManager.prototype, "listProjects")?.value,
    ).toEqual(expect.any(Function));
    expect(
      Object.getOwnPropertyDescriptor(AyanamiDatabaseManager.prototype, "getProject")?.value,
    ).toEqual(expect.any(Function));

    for (const file of [
      "context-read-model.ts",
      "outbox-read-model.ts",
      "record-read-model.ts",
      "registry-read-model.ts",
      "session-read-model.ts",
      "task-read-model.ts",
    ]) {
      const source = readFileSync(
        resolve(process.cwd(), "packages/storage-sqlite/src", file),
        "utf8",
      );
      expect(source).not.toMatch(/from\s+["']\.\/(?:index|manager|project-repository)\.js["']/u);
    }
  });

  it("preserves nested prototype calls, raw Session shape and current task mapping", async () => {
    const { database, repository } = await fixture("QFACE");
    const objective = repository.createObjective(
      { type: "USER", id: "USER", sessionId: null },
      { title: "Facade parity", description: "", definitionOfDone: [] },
    );
    const created = repository.createWorkItems(
      { type: "USER", id: "USER", sessionId: null },
      "facade-task",
      [
        {
          clientRef: "task",
          objectiveId: objective.id,
          title: "Facade task",
          type: "TASK",
          priority: "NORMAL",
        },
      ],
    );
    const task = repository.getWorkItem(created.items[0]!.key);
    const sessionId = repository.createSession({
      agentId: "facade-agent",
      displayName: "Facade agent",
      clientKind: "test",
      role: "SUBAGENT",
    }).id;
    database.sqlite
      .prepare("UPDATE agent_sessions SET current_work_item_id = ? WHERE id = ?")
      .run(task.id, sessionId);
    database.sqlite
      .prepare(
        "UPDATE work_items SET claimed_by_session_id = ?, status = 'CLAIMED', phase = 'CLAIMED' WHERE id = ?",
      )
      .run(sessionId, task.id);

    const raw = repository.getSession(sessionId);
    expect(raw).toHaveProperty("current_work_item_id", task.id);
    expect(raw).not.toHaveProperty("current_task_local_no");
    const getSessionSpy = vi.spyOn(repository, "getSession");
    expect(repository.getSessionView(sessionId).currentTaskKey).toBe(task.key);
    expect(getSessionSpy).toHaveBeenCalledWith(sessionId);
    getSessionSpy.mockRestore();

    const listRecordPageSpy = vi.spyOn(repository, "listRecordPage").mockReturnValue({
      items: [],
      itemCursors: [],
      nextCursor: null,
      retryCursor: "record-start",
      hasMore: false,
    });
    expect(repository.listRecords(7)).toEqual([]);
    expect(listRecordPageSpy).toHaveBeenCalledWith({ limit: 7 });
    listRecordPageSpy.mockRestore();

    const listWorkItemsSpy = vi.spyOn(repository, "listWorkItems");
    const getWorkItemSpy = vi.spyOn(repository, "getWorkItem");
    expect(repository.briefSnapshot(sessionId).currentTask).toMatchObject({ key: task.key });
    expect(listWorkItemsSpy).toHaveBeenCalledWith({ readyOnly: true, limit: 3 });
    expect(getWorkItemSpy).toHaveBeenCalledWith(task.key);
    listWorkItemsSpy.mockRestore();
    getWorkItemSpy.mockRestore();

    const snapshot: BriefSnapshot = {
      truncated: false,
      project: "QFACE",
      seq: 1,
      objective: null,
      milestone: null,
      active: 0,
      blocked: 0,
      waitingUser: 0,
      waitingAgent: 0,
      own: [],
      next: [],
      records: [],
      currentTask: null,
      handoff: null,
      recentProgress: null,
      artifacts: [],
    };
    const briefSnapshotSpy = vi.spyOn(repository, "briefSnapshot").mockReturnValue(snapshot);
    expect(repository.brief(null, 1200)).toMatchObject({ project: "QFACE", seq: 1 });
    expect(briefSnapshotSpy).toHaveBeenCalledWith(null);
  });

  it("keeps suggestion candidates ordered by local number and distance", async () => {
    const { database, repository } = await fixture("QSORT");
    const objective = repository.createObjective(
      { type: "USER", id: "USER", sessionId: null },
      { title: "Suggestion order", description: "", definitionOfDone: [] },
    );
    const insert = database.sqlite.prepare(
      `INSERT INTO work_items(
         id, local_no, objective_id, type, title, status, phase, priority, created_at, updated_at
       ) VALUES (?, ?, ?, 'TASK', ?, 'READY', 'READY', 'NORMAL', ?, ?)`,
    );
    const now = "2026-08-28T04:00:00.000Z";
    for (const localNo of [10, 2, 9, 7]) {
      insert.run(`sort-${localNo}`, localNo, objective.id, `Task ${localNo}`, now, now);
    }

    expect(
      repository.workItemSuggestionCandidates("none", 4).candidates.map((item) => item.key),
    ).toEqual(["QSORT-T-0002", "QSORT-T-0007", "QSORT-T-0009", "QSORT-T-0010"]);
    expect(
      repository.workItemSuggestionCandidates("8", 4).candidates.map((item) => item.key),
    ).toEqual(["QSORT-T-0007", "QSORT-T-0009", "QSORT-T-0010", "QSORT-T-0002"]);
  });
});
