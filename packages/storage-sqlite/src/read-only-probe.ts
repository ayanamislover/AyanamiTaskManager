import { existsSync, readFileSync, statSync } from "node:fs";
import Database from "better-sqlite3";
import {
  assertAppliedMigrations,
  loadMigrationPlan,
  type AppliedMigration,
} from "./migration-runner.js";

/** 超过这个大小不读进内存；安装探测宁可不核对，也不为它吃掉几百 MB。 */
export const PROBE_SNAPSHOT_LIMIT_BYTES = 256 * 1024 * 1024;

export type MigrationProbe = {
  applied: number;
  mode: "snapshot" | "live" | "large";
};

/**
 * 核对一个库已应用的迁移是否都在随包集合里且哈希一致，**对数据目录零写入**
 * （de-electron §6 第 4 步、§7）。不调用 `runMigrations`：那条路径会建表、备份、迁移。
 *
 * better-sqlite3 的只读连接仍会在库旁新建并遗留 `-shm`/`-wal`（实测），所以分两种：
 * - 没有 `-wal`：上次是干净关闭，库文件本身完整一致。整份读进内存，把文件头第 18/19
 *   字节从 2（WAL）改成 1（回滚日志）后反序列化——SQLite 不接受带 WAL 头的内存库。
 * - 有 `-wal`：服务正在跑或上次崩溃，未检查点的提交只在 WAL 里。这时普通只读直连，
 *   这两个文件本来就在，读者不新建文件。
 *
 * 核对不通过抛 AtmError（MIGRATION_FILE_MISSING / MIGRATION_HASH_MISMATCH 等），与
 * 正式启动时 `runMigrations` 的判定是同一个函数。
 */
export function probeAppliedMigrations(
  databasePath: string,
  migrationDirectory: string,
): MigrationProbe {
  const plan = loadMigrationPlan(migrationDirectory);
  let mode: MigrationProbe["mode"];
  let sqlite: Database.Database;
  if (existsSync(`${databasePath}-wal`)) {
    mode = "live";
    sqlite = new Database(databasePath, { readonly: true, fileMustExist: true });
  } else {
    if (statSync(databasePath).size > PROBE_SNAPSHOT_LIMIT_BYTES)
      return { applied: 0, mode: "large" };
    const bytes = readFileSync(databasePath);
    if (bytes.length >= 20 && bytes[18] === 2 && bytes[19] === 2) {
      bytes[18] = 1;
      bytes[19] = 1;
    }
    mode = "snapshot";
    sqlite = new Database(bytes, { readonly: true });
  }
  try {
    const table = sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get();
    const applied = table
      ? (sqlite
          .prepare(
            "SELECT version, name, content_sha256, hash_origin FROM schema_migrations ORDER BY version",
          )
          .all() as AppliedMigration[])
      : [];
    assertAppliedMigrations(applied, plan);
    return { applied: applied.length, mode };
  } finally {
    sqlite.close();
  }
}
