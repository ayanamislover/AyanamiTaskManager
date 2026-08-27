import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager } from "../src/manager.js";
import { ProjectRepository } from "../src/project-repository.js";
import { captureAtmError } from "./typed-error-test-helpers.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe("search keyset pagination", () => {
  it("pages 1001 project hits without duplicates, omissions or late inserts", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-project-search-keyset-"));
    temporary.push(root);
    const manager = await AyanamiDatabaseManager.open({
      dataDir: root,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const project = await manager.createProject({
        name: "项目搜索分页",
        sourcePath: null,
        code: "PS1001",
      });
      const database = await manager.openProject(project.code);
      const repository = new ProjectRepository(database);
      const insertDocument = database.sqlite.prepare(
        `INSERT INTO search_documents(entity_type, entity_id, entity_key, title, body, updated_at)
         VALUES ('RECORD', ?, ?, ?, '稳定分页关键字正文', ?)`,
      );
      const insertFts = database.sqlite.prepare(
        `INSERT INTO search_documents_fts(entity_type, entity_id, entity_key, title, body)
         VALUES ('RECORD', ?, ?, ?, '稳定分页关键字正文')`,
      );
      database.sqlite.transaction(() => {
        for (let index = 0; index < 1001; index += 1) {
          const id = `record-${String(index).padStart(4, "0")}`;
          const key = `PS1001-R-${String(index + 1).padStart(4, "0")}`;
          const title = `稳定分页关键字 ${String(index).padStart(4, "0")}`;
          insertDocument.run(id, key, title, "2026-08-27T12:00:00.000Z");
          insertFts.run(id, key, title);
        }
      })();

      const expected = new Set(
        Array.from(
          { length: 1001 },
          (_, index) => `PS1001-R-${String(index + 1).padStart(4, "0")}`,
        ),
      );
      const received: string[] = [];
      let cursor: string | undefined;
      let firstCursor = "";
      do {
        const page = repository.search("稳定分页关键字", 30, cursor);
        received.push(...page.hits.map((hit) => hit.entityKey));
        if (!firstCursor && page.nextCursor) {
          firstCursor = page.nextCursor;
          insertDocument.run(
            "record-late",
            "PS1001-R-LATE",
            "稳定分页关键字 后插入",
            "2026-08-27T13:00:00.000Z",
          );
          insertFts.run("record-late", "PS1001-R-LATE", "稳定分页关键字 后插入");
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);

      expect(received).toHaveLength(1001);
      expect(new Set(received)).toEqual(expected);
      expect(received).not.toContain("PS1001-R-LATE");
      expect(captureAtmError(() => repository.search("另一个查询", 30, firstCursor))).toMatchObject(
        { code: "INVALID_CURSOR", details: null },
      );
      expect(
        captureAtmError(() =>
          repository.search(
            "稳定分页关键字",
            30,
            `${firstCursor.slice(0, -1)}${firstCursor.endsWith("a") ? "b" : "a"}`,
          ),
        ),
      ).toMatchObject({ code: "INVALID_CURSOR", details: null });
    } finally {
      manager.close();
    }
  });

  it("pages 1001+ mixed global hits with project binding and stable tie-breaks", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-global-search-keyset-"));
    temporary.push(root);
    const manager = await AyanamiDatabaseManager.open({
      dataDir: root,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const first = await manager.createProject({ name: "全局甲", sourcePath: null, code: "GSA" });
      const second = await manager.createProject({ name: "全局乙", sourcePath: null, code: "GSB" });
      const insertDocument = manager.registry.sqlite.prepare(
        `INSERT INTO global_search_documents(
           project_id, entity_type, entity_key, title, summary, project_sequence, updated_at
         ) VALUES (?, 'RECORD', ?, ?, '全局稳定分页关键字正文', 1, ?)`,
      );
      const insertFts = manager.registry.sqlite.prepare(
        `INSERT INTO global_search_documents_fts(
           project_id, entity_type, entity_key, title, summary
         ) VALUES (?, 'RECORD', ?, ?, '全局稳定分页关键字正文')`,
      );
      const insertQuick = manager.registry.sqlite.prepare(
        `INSERT INTO quick_tasks(
           id, local_no, title, note, status, actor, version, created_at, updated_at
         ) VALUES (?, ?, ?, '全局稳定分页关键字临时项', 'OPEN', 'USER', 0, ?, ?)`,
      );
      manager.registry.sqlite.transaction(() => {
        for (let index = 0; index < 1001; index += 1) {
          const project = index % 2 === 0 ? first : second;
          const key = `${project.code}-R-${String(index + 1).padStart(4, "0")}`;
          const title = `全局稳定分页关键字 ${String(index).padStart(4, "0")}`;
          insertDocument.run(project.id, key, title, "2026-08-27T12:00:00.000Z");
          insertFts.run(project.id, key, title);
        }
        for (let index = 0; index < 3; index += 1) {
          insertQuick.run(
            `quick-${index}`,
            index + 1,
            `全局稳定分页关键字 临时 ${index}`,
            "2026-08-27T12:00:00.000Z",
            "2026-08-27T12:00:00.000Z",
          );
        }
      })();

      const received: string[] = [];
      let cursor: string | undefined;
      let firstCursor = "";
      do {
        const page = manager.globalSearch("全局稳定分页关键字", 30, cursor);
        received.push(...page.hits.map((hit) => `${hit.project ?? "QUICK"}:${hit.entityKey}`));
        if (!firstCursor && page.nextCursor) {
          firstCursor = page.nextCursor;
          insertQuick.run(
            "quick-late",
            9999,
            "全局稳定分页关键字 后插入",
            "2026-08-27T13:00:00.000Z",
            "2026-08-27T13:00:00.000Z",
          );
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);

      expect(received).toHaveLength(1004);
      expect(new Set(received).size).toBe(1004);
      expect(received).not.toContain("QUICK:Q-9999");
      expect(
        captureAtmError(() => manager.globalSearch("全局稳定分页关键字", 30, firstCursor.slice(1))),
      ).toMatchObject({ code: "INVALID_CURSOR", details: null });
      const projectRepository = new ProjectRepository(await manager.openProject(first.code));
      expect(
        captureAtmError(() => projectRepository.search("全局稳定分页关键字", 30, firstCursor)),
      ).toMatchObject({ code: "INVALID_CURSOR", details: null });
    } finally {
      manager.close();
    }
  });
});
