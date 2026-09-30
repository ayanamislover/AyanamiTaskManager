import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager } from "../src/index.js";
import { LAST_BACKUP_OUTCOME_SQL, recentEventWindowSql } from "../src/global-event-queries.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// 系统事件、备份事件稀少时，这两条查询没有部分索引就会扫整张 global_events：
// 1.2.2 发布流水线实测服务空闲内存因此从 148MB 涨到 154MB，越过 150MB 门槛。
// 部分索引只在查询条件与索引条件结构一致时才会被选用，改了任一边这里就会红。
describe("总览读全局事件的查询走部分索引", () => {
  it("系统事件窗口和最近一次备份结果都用 0008 迁移建的索引，不扫全表", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-global-event-queries-"));
    temporary.push(dataDir);
    const manager = await AyanamiDatabaseManager.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const plan = (sql: string) =>
        (
          manager.registry.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{
            detail: string;
          }>
        )
          .map((row) => row.detail)
          .join(" | ");
      expect(plan(recentEventWindowSql("system", 20))).toContain(
        "USING INDEX idx_global_events_system_class",
      );
      expect(plan(LAST_BACKUP_OUTCOME_SQL)).toContain(
        "USING INDEX idx_global_events_backup_outcome",
      );
      // 业务窗口是常态事件，按 sequence 倒序走主键很快就凑满，不需要额外索引。
      expect(plan(recentEventWindowSql("business", 40))).not.toContain("USE TEMP B-TREE");
    } finally {
      manager.close();
    }
  });
});
