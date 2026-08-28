import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AyanamiDatabaseManager } from "../src/manager.js";
import { ProjectRepository } from "../src/project-repository.js";

type ReadExecution = { kind: "all" | "get"; sql: string };

const temporary: string[] = [];
const managers: AyanamiDatabaseManager[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const manager of managers.splice(0)) manager.close();
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function executionCounter(sqlite: Database.Database) {
  const executions: ReadExecution[] = [];
  const originalPrepare = sqlite.prepare.bind(sqlite);
  vi.spyOn(sqlite, "prepare").mockImplementation(((sql: string) => {
    const statement = originalPrepare(sql);
    const originalAll = statement.all.bind(statement);
    const originalGet = statement.get.bind(statement);
    (statement as any).all = (...parameters: unknown[]) => {
      executions.push({ kind: "all", sql });
      return originalAll(...parameters);
    };
    (statement as any).get = (...parameters: unknown[]) => {
      executions.push({ kind: "get", sql });
      return originalGet(...parameters);
    };
    return statement;
  }) as typeof sqlite.prepare);
  return {
    measure<T>(action: () => T): { result: T; executions: ReadExecution[] } {
      const start = executions.length;
      const result = action();
      return { result, executions: executions.slice(start) };
    },
  };
}

function enforceFixedReads(label: string, actual: number, expected: number): void {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, received ${actual}`);
}

async function openFixture(code: string) {
  const root = mkdtempSync(join(tmpdir(), `atm-query-count-${code.toLowerCase()}-`));
  temporary.push(root);
  const manager = await AyanamiDatabaseManager.open({
    dataDir: join(root, "data"),
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  managers.push(manager);
  const project = await manager.createProject({ name: code, sourcePath: null, code });
  const database = await manager.openProject(project.code);
  return { root, manager, project, database, repository: new ProjectRepository(database) };
}

describe("Read-model SQL execution guards", () => {
  it("self-validates the counter against real Statement.all and Statement.get calls", () => {
    const sqlite = new Database(":memory:");
    try {
      sqlite.exec("CREATE TABLE sample(value INTEGER); INSERT INTO sample VALUES (1), (2)");
      const counter = executionCounter(sqlite);
      const measured = counter.measure(() => {
        sqlite.prepare("SELECT value FROM sample ORDER BY value").all();
        sqlite.prepare("SELECT value FROM sample WHERE value = ?").get(1);
      });
      expect(measured.executions.map((entry) => entry.kind)).toEqual(["all", "get"]);
      expect(() =>
        enforceFixedReads("counter self-check", measured.executions.length, 2),
      ).not.toThrow();
    } finally {
      sqlite.close();
    }
  });

  it("keeps listProjects at two executions and rejects the former per-project path query", async () => {
    const { root, manager, project } = await openFixture("QREG");
    const primary = join(root, "primary");
    const secondary = join(root, "secondary");
    mkdirSync(primary);
    mkdirSync(secondary);
    manager.attachProjectPath(project.code, primary, { primary: true });
    manager.attachProjectPath(project.code, secondary);
    const archived = await manager.createProject({
      name: "Archived",
      sourcePath: null,
      code: "QRA",
    });
    const trashed = await manager.createProject({ name: "Trashed", sourcePath: null, code: "QRT" });
    await manager.createProject({ name: "No path", sourcePath: null, code: "QRN" });
    manager.setProjectLifecycle(archived.code, "ARCHIVED");
    manager.setProjectLifecycle(trashed.code, "TRASHED");

    const counter = executionCounter(manager.registry.sqlite);
    const bounded = counter.measure(() => manager.listProjects());
    expect(() => enforceFixedReads("listProjects", bounded.executions.length, 2)).not.toThrow();
    expect(bounded.executions.map((entry) => entry.kind)).toEqual(["all", "all"]);
    expect(bounded.result.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["QREG", "QRA", "QRN"]),
    );
    expect(bounded.result.map((entry) => entry.code)).not.toContain("QRT");
    expect(bounded.result.find((entry) => entry.code === "QREG")?.sourcePaths).toHaveLength(2);

    const unbounded = counter.measure(() => manager.listProjects(true));
    expect(() =>
      enforceFixedReads("listProjects(true)", unbounded.executions.length, 2),
    ).not.toThrow();
    expect(unbounded.result.map((entry) => entry.code)).toContain("QRT");

    const linear = counter.measure(() => {
      const rows = manager.registry.sqlite
        .prepare("SELECT id FROM projects WHERE lifecycle <> 'TRASHED' ORDER BY updated_at DESC")
        .all() as Array<{ id: string }>;
      const paths = manager.registry.sqlite.prepare(
        "SELECT canonical_path FROM project_paths WHERE project_id = ? ORDER BY is_primary DESC, last_seen_at DESC",
      );
      for (const row of rows) paths.all(row.id);
    });
    expect(linear.executions.length).toBe(1 + bounded.result.length);
    expect(() =>
      enforceFixedReads("linear listProjects mutation", linear.executions.length, 2),
    ).toThrow(/expected 2/u);
  });

  it("hydrates a 41-item WorkItem page in two executions and rejects row-wise hydration", async () => {
    const { database, repository } = await openFixture("QTASK");
    const objective = repository.createObjective(
      { type: "USER", id: "USER", sessionId: null },
      { title: "Query guard", description: "", definitionOfDone: [] },
    );
    const now = "2026-08-28T01:00:00.000Z";
    const insert = database.sqlite.prepare(
      `INSERT INTO work_items(
         id, local_no, objective_id, type, title, status, phase, priority, sort_key,
         created_at, updated_at
       ) VALUES (?, ?, ?, 'TASK', ?, ?, ?, 'HIGH', 1000, ?, ?)`,
    );
    database.sqlite.transaction(() => {
      for (let localNo = 1; localNo <= 45; localNo += 1) {
        const done = localNo === 5;
        insert.run(
          `task-${localNo}`,
          localNo,
          objective.id,
          `Task ${localNo}`,
          done ? "DONE" : "READY",
          done ? "DONE" : "READY",
          now,
          now,
        );
      }
      database.sqlite
        .prepare(
          `UPDATE work_items
           SET parent_id = 'task-1', duplicate_of_id = 'task-2', superseded_by_id = 'task-3'
           WHERE id = 'task-4'`,
        )
        .run();
      database.sqlite
        .prepare("UPDATE work_items SET parent_id = 'task-4' WHERE id = 'task-5'")
        .run();
      database.sqlite
        .prepare(
          `INSERT INTO checklist_items(
             id, work_item_id, title, kind, status, weight, created_at, updated_at
           ) VALUES ('check-4', 'task-4', 'Checklist', 'REQUIRED', 'DONE', 2, ?, ?)`,
        )
        .run(now, now);
      database.sqlite
        .prepare(
          `INSERT INTO blockers(
             id, local_no, work_item_id, severity, title, detail, status, actor, created_at, updated_at
           ) VALUES ('blocker-4', 1, 'task-4', 'HIGH', 'Blocked', 'Awaiting review',
                     'ACTIVE', 'USER', ?, ?)`,
        )
        .run(now, now);
      database.sqlite
        .prepare(
          `INSERT INTO work_item_relations(source_id, target_id, relation_type, created_at)
           VALUES ('task-4', 'task-6', 'DISCOVERED_FROM', ?),
                  ('task-7', 'task-4', 'DISCOVERED_FROM', ?)`,
        )
        .run(now, now);
    })();

    const counter = executionCounter(database.sqlite);
    const bounded = counter.measure(() => repository.listWorkItemPage({ limit: 41 }));
    expect(() => enforceFixedReads("listWorkItemPage", bounded.executions.length, 2)).not.toThrow();
    expect(bounded.executions.map((entry) => entry.kind)).toEqual(["get", "all"]);
    const hydrated = bounded.result.items.find((entry) => entry.localNo === 4)!;
    expect(hydrated).toMatchObject({
      parentKey: "QTASK-T-0001",
      duplicateOf: "QTASK-T-0002",
      supersededBy: "QTASK-T-0003",
      discoveredFrom: "QTASK-T-0006",
      discoveredCount: 1,
      progressBreakdown: {
        doneWeight: 1,
        totalWeight: 1,
        doneStages: 1,
        totalStages: 1,
        blocker: "Awaiting review",
      },
    });

    const linear = counter.measure(() => {
      const rows = database.sqlite
        .prepare("SELECT * FROM work_items ORDER BY local_no LIMIT ?")
        .all(41) as any[];
      const children = database.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM work_items WHERE parent_id = ?",
      );
      const checklist = database.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM checklist_items WHERE work_item_id = ?",
      );
      const blocker = database.sqlite.prepare(
        "SELECT id FROM blockers WHERE work_item_id = ? AND status = 'ACTIVE' LIMIT 1",
      );
      const reference = database.sqlite.prepare("SELECT local_no FROM work_items WHERE id = ?");
      for (const row of rows) {
        children.get(row.id);
        checklist.get(row.id);
        blocker.get(row.id);
        for (const id of [row.parent_id, row.duplicate_of_id, row.superseded_by_id]) {
          if (id) reference.get(id);
        }
      }
    });
    expect(linear.executions.length).toBeGreaterThan(100);
    expect(() =>
      enforceFixedReads("linear WorkItem hydration mutation", linear.executions.length, 2),
    ).toThrow(/expected 2/u);
  });

  it("loads 500 outbox events in one execution and rejects event-by-event lookup", async () => {
    const { database, repository } = await openFixture("QOUT");
    const eventInsert = database.sqlite.prepare(
      `INSERT INTO events(
         id, sequence, type, actor_type, actor_id, aggregate_type, aggregate_id, payload_json, created_at
       ) VALUES (?, ?, 'record.created', 'AGENT', 'query-guard', 'RECORD', ?, ?, ?)`,
    );
    const outboxInsert = database.sqlite.prepare(
      `INSERT INTO outbox(id, project_sequence, type, payload_json, created_at)
       VALUES (?, ?, 'registry.project-event', ?, ?)`,
    );
    database.sqlite.transaction(() => {
      for (let index = 1; index <= 500; index += 1) {
        const eventId = `event-${index}`;
        eventInsert.run(
          eventId,
          index,
          `record-${index}`,
          JSON.stringify({ index }),
          "2026-08-28T02:00:00.000Z",
        );
        outboxInsert.run(
          `outbox-${String(index).padStart(4, "0")}`,
          index,
          JSON.stringify({
            eventId,
            type: "fallback.type",
            aggregateType: "FALLBACK",
            aggregateId: `fallback-${index}`,
          }),
          "2026-08-28T02:00:00.000Z",
        );
      }
    })();

    const counter = executionCounter(database.sqlite);
    const bounded = counter.measure(() => repository.pendingOutbox(500));
    expect(() =>
      enforceFixedReads("pendingOutbox(500)", bounded.executions.length, 1),
    ).not.toThrow();
    expect(bounded.executions.map((entry) => entry.kind)).toEqual(["all"]);
    expect(bounded.result).toHaveLength(500);
    expect(bounded.result[0]).toMatchObject({
      eventId: "event-1",
      eventType: "record.created",
      aggregateType: "RECORD",
      aggregateId: "record-1",
      actor: "query-guard",
      eventPayload: { index: 1 },
    });

    const linear = counter.measure(() => {
      const rows = database.sqlite
        .prepare(
          `SELECT payload_json FROM outbox WHERE delivered_at IS NULL
           ORDER BY project_sequence, id LIMIT 500`,
        )
        .all() as Array<{ payload_json: string }>;
      const event = database.sqlite.prepare("SELECT id FROM events WHERE id = ?");
      for (const row of rows) {
        const payload = JSON.parse(row.payload_json) as { eventId: string };
        event.get(payload.eventId);
      }
    });
    expect(linear.executions).toHaveLength(501);
    expect(() => enforceFixedReads("linear outbox mutation", linear.executions.length, 1)).toThrow(
      /expected 1/u,
    );
  });

  it("keeps malformed, non-string and missing event fallbacks without invoking JSON errors", async () => {
    const { database, repository } = await openFixture("QBAD");
    const insert = database.sqlite.prepare(
      `INSERT INTO outbox(id, project_sequence, type, payload_json, created_at)
       VALUES (?, ?, 'registry.project-event', ?, '2026-08-28T03:00:00.000Z')`,
    );
    insert.run("bad-json", 1, "{");
    insert.run(
      "non-string-event",
      2,
      JSON.stringify({
        eventId: 42,
        type: "fallback.type",
        aggregateType: "FALLBACK",
        aggregateId: "42",
      }),
    );
    insert.run(
      "missing-event",
      3,
      JSON.stringify({
        eventId: "missing",
        type: "missing.type",
        aggregateType: "MISSING",
        aggregateId: "missing-id",
      }),
    );

    expect(repository.pendingOutbox(10)).toEqual([
      expect.objectContaining({
        id: "bad-json",
        eventId: null,
        eventType: "",
        aggregateType: "",
        aggregateId: "",
        actor: "SYSTEM",
        eventPayload: {},
        eventSequence: 1,
        eventAt: null,
      }),
      expect.objectContaining({
        id: "non-string-event",
        eventId: null,
        eventType: "fallback.type",
        aggregateType: "FALLBACK",
        aggregateId: "42",
      }),
      expect.objectContaining({
        id: "missing-event",
        eventId: "missing",
        eventType: "missing.type",
        aggregateType: "MISSING",
        aggregateId: "missing-id",
        actor: "SYSTEM",
        eventPayload: {},
        eventSequence: 3,
        eventAt: null,
      }),
    ]);
  });
});
