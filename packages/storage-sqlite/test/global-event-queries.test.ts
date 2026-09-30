import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager } from "../src/index.js";
import { LAST_BACKUP_OUTCOME_SQL, recentEventWindowSql } from "../src/global-event-queries.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const migration0008 = resolve(
  process.cwd(),
  "migrations",
  "registry",
  "0008_global_event_class_indexes.sql",
);

async function openManager() {
  const dataDir = mkdtempSync(join(tmpdir(), "atm-global-event-queries-"));
  temporary.push(dataDir);
  return AyanamiDatabaseManager.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
}

// 哪一类事件在某个库里稀少，这几条查询没有部分索引就会扫整张 global_events：
// 1.2.2 发布流水线实测服务空闲内存因此从 148MB 涨到 154MB；系统事件占多数的百万级库里，
// 业务窗口让总览 p95 到了约 286ms。部分索引只在查询条件包含索引条件时才会被选用，
// 改了任一边这里就会红。
describe("总览读全局事件的查询走部分索引", () => {
  it("业务窗口、系统窗口和最近一次备份结果各用 0008 迁移建的索引，不扫全表", async () => {
    const manager = await openManager();
    try {
      const plan = (sql: string) =>
        (
          manager.registry.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{
            detail: string;
          }>
        )
          .map((row) => row.detail)
          .join(" | ");
      expect(plan(recentEventWindowSql("business", 40))).toContain(
        "USING INDEX idx_global_events_business_class",
      );
      expect(plan(recentEventWindowSql("system", 20))).toContain(
        "USING INDEX idx_global_events_system_class",
      );
      expect(plan(LAST_BACKUP_OUTCOME_SQL)).toContain(
        "USING INDEX idx_global_events_backup_outcome",
      );
    } finally {
      manager.close();
    }
  });

  it("系统事件占多数、业务事件只有很早的几条时，两个窗口照样取对", async () => {
    const manager = await openManager();
    try {
      const sqlite = manager.registry.sqlite;
      const base = Number(
        (
          sqlite.prepare("SELECT COALESCE(MAX(sequence), 0) AS max FROM global_events").get() as {
            max: number;
          }
        ).max,
      );
      const insert = sqlite.prepare(
        `INSERT INTO global_events(sequence, type, aggregate_id, actor, payload_json, created_at)
         VALUES (?, ?, ?, ?, '{}', '2026-09-30T00:00:00.000Z')`,
      );
      sqlite.transaction(() => {
        let sequence = base;
        for (let index = 0; index < 3; index += 1)
          insert.run(++sequence, "quick.created", `quick-${index}`, "USER");
        for (let index = 0; index < 5_000; index += 1) {
          insert.run(++sequence, "agent.git_context.updated", `agent-${index}`, "codex");
          if (index % 10 === 0)
            insert.run(++sequence, "project.summary.updated", `summary-${index}`, "SYSTEM");
        }
        sqlite
          .prepare("UPDATE app_meta SET current_sequence = ? WHERE singleton = 1")
          .run(sequence);
      })();
      const business = sqlite.prepare(recentEventWindowSql("business", 40)).all() as Array<{
        type: string;
      }>;
      expect(business.map((row) => row.type)).toEqual([
        "quick.created",
        "quick.created",
        "quick.created",
      ]);
      const system = sqlite.prepare(recentEventWindowSql("system", 20)).all() as Array<{
        type: string;
      }>;
      expect(system).toHaveLength(20);
      expect(new Set(system.map((row) => row.type))).toEqual(
        new Set(["agent.git_context.updated"]),
      );
      expect(sqlite.prepare(LAST_BACKUP_OUTCOME_SQL).get()).toBeUndefined();
    } finally {
      manager.close();
    }
  });

  it("连接上设过 case_sensitive_like 也能建出 0008 的部分索引（不用 LIKE）", () => {
    for (const setting of ["ON", "OFF"]) {
      const sqlite = new Database(":memory:");
      try {
        sqlite.exec(`PRAGMA case_sensitive_like = ${setting};`);
        sqlite.exec(
          `CREATE TABLE global_events (
             sequence INTEGER PRIMARY KEY, type TEXT NOT NULL, aggregate_id TEXT,
             actor TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
           );`,
        );
        expect(() => sqlite.exec(readFileSync(migration0008, "utf8"))).not.toThrow();
      } finally {
        sqlite.close();
      }
    }
  });
});
