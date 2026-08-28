import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AyanamiDatabaseManager } from "../src/manager.js";
import { ProjectRepository } from "../src/project-repository.js";
import {
  decodeTaskListCursor,
  encodeTaskListCursor,
  type TaskListSelection,
} from "../src/task-list-pagination.js";
import { captureAtmError } from "./typed-error-test-helpers.js";

const temporary: string[] = [];
const managers: AyanamiDatabaseManager[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const manager of managers.splice(0)) manager.close();
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function fixture(code: string): Promise<{
  manager: AyanamiDatabaseManager;
  repository: ProjectRepository;
  database: Awaited<ReturnType<AyanamiDatabaseManager["openProject"]>>;
  objectiveId: string;
}> {
  const root = mkdtempSync(join(tmpdir(), `atm-task-keyset-${code.toLowerCase()}-`));
  temporary.push(root);
  const manager = await AyanamiDatabaseManager.open({
    dataDir: join(root, "data"),
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  managers.push(manager);
  const project = await manager.createProject({ name: code, sourcePath: null, code });
  const database = await manager.openProject(project.code);
  const repository = new ProjectRepository(database);
  const objective = repository.createObjective(
    { type: "USER", id: "USER", sessionId: null },
    { title: `${code} objective`, description: "", definitionOfDone: [] },
  );
  return { manager, repository, database, objectiveId: objective.id };
}

function insertTiedTasks(
  database: Awaited<ReturnType<AyanamiDatabaseManager["openProject"]>>,
  objectiveId: string,
  count: number,
): void {
  const insert = database.sqlite.prepare(
    `INSERT INTO work_items(
       id, local_no, objective_id, type, title, status, phase, priority, sort_key,
       created_at, updated_at
     ) VALUES (?, ?, ?, 'TASK', ?, 'READY', 'READY', 'HIGH', 1000, ?, ?)`,
  );
  const createdAt = "2026-08-27T20:00:00.000Z";
  database.sqlite.transaction(() => {
    for (let localNo = 1; localNo <= count; localNo += 1) {
      insert.run(
        `task-${String(localNo).padStart(4, "0")}`,
        localNo,
        objectiveId,
        `Task ${String(localNo).padStart(4, "0")}`,
        createdAt,
        createdAt,
      );
    }
  })();
}

describe("WorkItem keyset pagination", () => {
  it("pages 521 fully tied rows without duplicates, omissions or a second has-more query", async () => {
    const { repository, database, objectiveId } = await fixture("TK521");
    insertTiedTasks(database, objectiveId, 521);

    const projectionSql: string[] = [];
    const allSql: string[] = [];
    const originalPrepare = database.sqlite.prepare.bind(database.sqlite);
    vi.spyOn(database.sqlite, "prepare").mockImplementation(((sql: string) => {
      const statement = originalPrepare(sql);
      const originalAll = statement.all.bind(statement);
      (statement as any).all = (...params: unknown[]) => {
        allSql.push(sql);
        return originalAll(...params);
      };
      if (sql.includes("WITH selected AS")) projectionSql.push(sql);
      return statement;
    }) as typeof database.sqlite.prepare);

    const localNumbers: number[] = [];
    let cursor: string | undefined;
    let pageIndex = 0;
    do {
      const before = projectionSql.length;
      const allBefore = allSql.length;
      const page = repository.listTaskViewPage(
        { limit: pageIndex % 2 === 0 ? 37 : 53, cursor },
        pageIndex % 2 === 0 ? "core" : "full",
      );
      expect(projectionSql.length - before).toBe(1);
      expect(allSql.length - allBefore).toBe(1);
      expect(allSql.at(-1)).toBe(projectionSql.at(-1));
      expect(projectionSql.at(-1)).not.toMatch(/\bOFFSET\b/iu);
      expect(projectionSql.at(-1)?.match(/\bLIMIT\s+\?/giu)).toHaveLength(1);
      localNumbers.push(...page.items.map((item) => item.localNo));
      cursor = page.nextCursor ?? undefined;
      pageIndex += 1;
    } while (cursor);

    expect(localNumbers).toEqual(Array.from({ length: 521 }, (_, index) => index + 1));
    expect(new Set(localNumbers).size).toBe(521);
  });

  it("uses the same tl1 selection for the desktop metadata projection", async () => {
    const { repository, database, objectiveId } = await fixture("TKUI521");
    insertTiedTasks(database, objectiveId, 521);

    const localNumbers: number[] = [];
    let cursor: string | undefined;
    do {
      const page = repository.listWorkItemPage({ limit: 41, cursor });
      localNumbers.push(...page.items.map((item) => item.localNo));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(localNumbers).toEqual(Array.from({ length: 521 }, (_, index) => index + 1));
    expect(new Set(localNumbers).size).toBe(521);
  });

  it("binds tl1 cursors to project and the canonical selection, but not page presentation", async () => {
    const first = await fixture("TKBIND");
    const second = await fixture("TKOTHR");
    insertTiedTasks(first.database, first.objectiveId, 4);
    insertTiedTasks(second.database, second.objectiveId, 4);

    const firstPage = first.repository.listTaskViewPage({ limit: 1 }, "core");
    const cursor = firstPage.nextCursor!;
    expect(cursor).toMatch(/^tl1\./u);

    expect(first.repository.listTaskViewPage({ limit: 2, cursor }, "full").items).toHaveLength(2);
    expect(
      captureAtmError(() =>
        first.repository.listTaskViewPage({ limit: 2, cursor, status: "DONE" }, "core"),
      ),
    ).toMatchObject({ code: "INVALID_CURSOR", httpStatus: 422 });
    expect(
      captureAtmError(() => second.repository.listTaskViewPage({ limit: 2, cursor }, "core")),
    ).toMatchObject({ code: "INVALID_CURSOR", httpStatus: 422 });
    expect(
      captureAtmError(() =>
        first.repository.listTaskViewPage(
          {
            limit: 2,
            cursor: `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`,
          },
          "core",
        ),
      ),
    ).toMatchObject({ code: "INVALID_CURSOR", httpStatus: 422 });
  });

  it("hashes every selection field while leaving limit and projection outside cursor identity", () => {
    const selection: TaskListSelection = {
      status: "READY",
      owner: "agent-a",
      parent: "parent-id",
      milestone: "milestone-id",
      ready: true,
      query: "分页查询",
    };
    const cursor = encodeTaskListCursor({ project: "TLSEL", selection, last: null });
    expect(decodeTaskListCursor(cursor, { project: "TLSEL", selection }).last).toBeNull();

    for (const field of Object.keys(selection) as Array<keyof TaskListSelection>) {
      const changed = {
        ...selection,
        [field]: field === "ready" ? false : `${selection[field]}-x`,
      };
      expect(
        captureAtmError(() =>
          decodeTaskListCursor(cursor, { project: "TLSEL", selection: changed }),
        ),
      ).toMatchObject({ code: "INVALID_CURSOR", httpStatus: 422 });
    }
  });
});
