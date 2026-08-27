import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AyanamiDatabaseManager } from "../src/manager.js";
import { ProjectRepository } from "../src/project-repository.js";
import {
  decodeRecordListCursor,
  encodeRecordListCursor,
  type RecordListSelection,
} from "../src/record-list-pagination.js";
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

async function fixture(code: string) {
  const root = mkdtempSync(join(tmpdir(), `atm-record-keyset-${code.toLowerCase()}-`));
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

function insertTiedRecords(
  database: Awaited<ReturnType<AyanamiDatabaseManager["openProject"]>>,
  count: number,
): void {
  const insert = database.sqlite.prepare(
    `INSERT INTO records(
       id, local_no, kind, title, summary, detail, importance, status, scope, actor,
       version, created_at, updated_at, source_type, source_actor_id, source_session_id,
       source_ref, topic, subject_key, op_id
     ) VALUES (?, ?, 'FACT', ?, ?, '', 'NORMAL', 'ACTIVE', 'PROJECT', 'agent-a',
       0, ?, ?, 'AGENT', 'agent-a', 'session-a', ?, 'stable-page', ?, ?)`,
  );
  const at = "2026-08-27T20:00:00.000Z";
  database.sqlite.transaction(() => {
    for (let localNo = 1; localNo <= count; localNo += 1) {
      insert.run(
        `record-${String(localNo).padStart(4, "0")}`,
        localNo,
        `Record ${localNo}`,
        `Summary ${localNo}`,
        at,
        at,
        `source:${localNo}`,
        `record:${localNo}`,
        `record-op-${localNo}`,
      );
    }
  })();
}

describe("Record keyset pagination", () => {
  it("pages 521 tied rows with one limit+1 projection query per page and no gaps", async () => {
    const { database, repository } = await fixture("RL521");
    insertTiedRecords(database, 521);

    const pageSql: string[] = [];
    const originalPrepare = database.sqlite.prepare.bind(database.sqlite);
    vi.spyOn(database.sqlite, "prepare").mockImplementation(((sql: string) => {
      const statement = originalPrepare(sql);
      const originalAll = statement.all.bind(statement);
      (statement as any).all = (...parameters: unknown[]) => {
        if (sql.includes("WITH selected_records AS")) pageSql.push(sql);
        return originalAll(...parameters);
      };
      return statement;
    }) as typeof database.sqlite.prepare);

    const keys: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const before = pageSql.length;
      const page = repository.listRecordPage({ limit: pages % 2 === 0 ? 37 : 53, cursor });
      expect(pageSql.length - before).toBe(1);
      expect(pageSql.at(-1)).not.toMatch(/\bOFFSET\b/iu);
      expect(pageSql.at(-1)?.match(/\bLIMIT\s+\?/giu)).toHaveLength(1);
      keys.push(...page.items.map((record) => record.key));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor);

    expect(keys).toEqual(
      Array.from({ length: 521 }, (_, index) => `RL521-R-${String(521 - index).padStart(3, "0")}`),
    );
    expect(new Set(keys).size).toBe(521);
    expect(pageSql[0]).toContain("related_candidates AS");
    expect(pageSql[0]).toContain("row_number() OVER");
    expect(pageSql[0]).toContain("related_aggregates AS");
  });

  it("projects canonical fields and all relations without per-item queries", async () => {
    const { database, repository } = await fixture("RLVIEW");
    insertTiedRecords(database, 3);
    database.sqlite
      .prepare("UPDATE records SET supersedes_id = ?, work_item_id = NULL WHERE local_no = 3")
      .run("record-0002");

    const page = repository.listRecordPage({ limit: 2 });
    expect(page.items[0]).toMatchObject({
      key: "RLVIEW-R-003",
      supersedes: "RLVIEW-R-002",
      sourceType: "AGENT",
      sourceActorId: "agent-a",
      sourceSessionId: "session-a",
      sourceRef: "source:3",
      relatedRecords: ["RLVIEW-R-002", "RLVIEW-R-001"],
      opId: "record-op-3",
      createdAt: "2026-08-27T20:00:00.000Z",
      updatedAt: "2026-08-27T20:00:00.000Z",
    });
  });

  it("binds rl1 to project and list selection, but not limit", async () => {
    const first = await fixture("RLBIND");
    const second = await fixture("RLOTHR");
    insertTiedRecords(first.database, 4);
    insertTiedRecords(second.database, 4);
    const cursor = first.repository.listRecordPage({ limit: 1 }).nextCursor!;
    expect(cursor).toMatch(/^rl1\./u);
    expect(first.repository.listRecordPage({ limit: 2, cursor }).items).toHaveLength(2);
    expect(
      captureAtmError(() => second.repository.listRecordPage({ limit: 2, cursor })),
    ).toMatchObject({ code: "INVALID_CURSOR", httpStatus: 422 });
    expect(
      captureAtmError(() =>
        first.repository.listRecordPage({
          limit: 2,
          cursor: `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`,
        }),
      ),
    ).toMatchObject({ code: "INVALID_CURSOR", httpStatus: 422 });

    const selection: RecordListSelection = { list: "records" };
    const start = encodeRecordListCursor({ project: "RLBIND", selection, last: null });
    expect(decodeRecordListCursor(start, { project: "RLBIND", selection }).last).toBeNull();
    expect(
      captureAtmError(() =>
        decodeRecordListCursor(start, {
          project: "RLBIND",
          selection: { list: "sessions" } as unknown as RecordListSelection,
        }),
      ),
    ).toMatchObject({ code: "INVALID_CURSOR", httpStatus: 422 });
  });
});
