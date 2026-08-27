import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AyanamiDatabaseManager } from "../src/manager.js";
import { ProjectRepository } from "../src/project-repository.js";
import {
  decodeSessionListCursor,
  encodeSessionListCursor,
  type SessionListSelection,
} from "../src/session-list-pagination.js";
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
  const root = mkdtempSync(join(tmpdir(), `atm-session-keyset-${code.toLowerCase()}-`));
  temporary.push(root);
  const manager = await AyanamiDatabaseManager.open({
    dataDir: join(root, "data"),
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  managers.push(manager);
  const project = await manager.createProject({ name: code, sourcePath: null, code });
  const database = await manager.openProject(project.code);
  return { database, repository: new ProjectRepository(database) };
}

async function insertTiedSessions(
  repository: ProjectRepository,
  database: Awaited<ReturnType<AyanamiDatabaseManager["openProject"]>>,
  count: number,
) {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(
      repository.createSession({
        agentId: `session-agent-${index}`,
        displayName: `Agent ${index}`,
        clientKind: "test",
        role: "SUBAGENT",
      }).id,
    );
  }
  database.sqlite
    .prepare(
      "UPDATE agent_sessions SET started_at = ?, updated_at = ?, heartbeat_at = ? WHERE id = ?",
    )
    .run("2026-08-28T00:00:00.000Z", "2026-08-28T00:00:00.000Z", null, ids[0]);
  const update = database.sqlite.prepare(
    "UPDATE agent_sessions SET started_at = ?, updated_at = ?, heartbeat_at = ? WHERE id = ?",
  );
  database.sqlite.transaction(() => {
    for (const id of ids) {
      update.run("2026-08-28T00:00:00.000Z", "2026-08-28T00:00:00.000Z", null, id);
    }
  })();
  return ids;
}

describe("Session keyset pagination", () => {
  it("pages 521 tied started_at rows with one limit+1 query and remains stable across heartbeat changes", async () => {
    const { database, repository } = await fixture("SL521");
    await insertTiedSessions(repository, database, 521);
    const pageSql: string[] = [];
    const originalPrepare = database.sqlite.prepare.bind(database.sqlite);
    vi.spyOn(database.sqlite, "prepare").mockImplementation(((sql: string) => {
      const statement = originalPrepare(sql);
      const originalAll = statement.all.bind(statement);
      (statement as any).all = (...parameters: unknown[]) => {
        if (sql.includes("FROM agent_sessions session") && sql.includes("LIMIT ?"))
          pageSql.push(sql);
        return originalAll(...parameters);
      };
      return statement;
    }) as typeof database.sqlite.prepare);

    const ids: string[] = [];
    let cursor: string | undefined;
    let pageCount = 0;
    do {
      const before = pageSql.length;
      const page = repository.listAgentSessionPage({
        limit: pageCount % 2 === 0 ? 37 : 53,
        cursor,
      });
      expect(pageSql.length - before).toBe(1);
      expect(pageSql.at(-1)).not.toMatch(/\bOFFSET\b/iu);
      expect(pageSql.at(-1)?.match(/\bLIMIT\s+\?/giu)).toHaveLength(1);
      ids.push(...page.items.map((session) => session.id));
      if (pageCount === 0) {
        database.sqlite
          .prepare("UPDATE agent_sessions SET heartbeat_at = ?")
          .run("2026-08-28T00:01:00.000Z");
      }
      cursor = page.nextCursor ?? undefined;
      pageCount += 1;
    } while (cursor);

    expect(ids).toHaveLength(521);
    expect(new Set(ids).size).toBe(521);
    expect(pageSql[0]).toContain("JOIN agents agent");
    expect(pageSql[0]).toContain("LEFT JOIN work_items task");
    expect(pageSql[0]).toContain("ORDER BY session.started_at DESC, session.id DESC");
    expect(repository.listAgentSessionPage({ limit: 1 }).items[0]?.lastSeenAt).toBe(
      "2026-08-28T00:01:00.000Z",
    );
  });

  it("binds sl1 to project and list selection, but not limit", async () => {
    const first = await fixture("SLBIND");
    const second = await fixture("SLOTHR");
    await insertTiedSessions(first.repository, first.database, 4);
    await insertTiedSessions(second.repository, second.database, 4);
    const cursor = first.repository.listAgentSessionPage({ limit: 1 }).nextCursor!;
    expect(cursor).toMatch(/^sl1\./u);
    expect(first.repository.listAgentSessionPage({ limit: 2, cursor }).items).toHaveLength(2);
    expect(
      captureAtmError(() => second.repository.listAgentSessionPage({ limit: 2, cursor })),
    ).toMatchObject({ code: "INVALID_CURSOR", httpStatus: 422 });
    expect(
      captureAtmError(() =>
        first.repository.listAgentSessionPage({
          limit: 2,
          cursor: `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`,
        }),
      ),
    ).toMatchObject({ code: "INVALID_CURSOR", httpStatus: 422 });

    const selection: SessionListSelection = { list: "sessions" };
    const start = encodeSessionListCursor({ project: "SLBIND", selection, last: null });
    expect(decodeSessionListCursor(start, { project: "SLBIND", selection }).last).toBeNull();
    expect(
      captureAtmError(() =>
        decodeSessionListCursor(start, {
          project: "SLBIND",
          selection: { list: "records" } as unknown as SessionListSelection,
        }),
      ),
    ).toMatchObject({ code: "INVALID_CURSOR", httpStatus: 422 });
  });
});
