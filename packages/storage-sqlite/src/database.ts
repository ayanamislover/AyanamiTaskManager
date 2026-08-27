import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { AtmError } from "@ayanami-task/errors";
import { runMigrations } from "./migration-runner.js";

export type ManagedDatabase = {
  sqlite: Database.Database;
  path: string;
  schemaVersion: number;
};

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function sqliteCapabilities(sqlite: Database.Database): {
  version: string;
  fts5: boolean;
  trigram: boolean;
  wal: boolean;
} {
  const version = (
    sqlite.prepare("SELECT sqlite_version() AS version").get() as { version: string }
  ).version;
  const fts5 =
    Number(
      (
        sqlite.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled").get() as {
          enabled: number;
        }
      ).enabled,
    ) === 1;
  let trigram = false;
  try {
    sqlite.exec(
      "CREATE VIRTUAL TABLE temp.__atm_trigram_test USING fts5(value, tokenize='trigram')",
    );
    sqlite.exec("DROP TABLE temp.__atm_trigram_test");
    trigram = true;
  } catch {
    trigram = false;
  }
  const journal = String(sqlite.pragma("journal_mode", { simple: true })).toLowerCase();
  return { version, fts5, trigram, wal: journal === "wal" || journal === "memory" };
}

export function assertSqliteCapabilities(sqlite: Database.Database): void {
  const capabilities = sqliteCapabilities(sqlite);
  if (compareVersions(capabilities.version, "3.51.3") < 0) {
    throw new AtmError("SQLITE_VERSION_UNSAFE", {
      message: `SQLite 版本不安全：${capabilities.version}`,
      details: { version: capabilities.version },
    });
  }
  if (!capabilities.fts5 || !capabilities.trigram)
    throw new AtmError("SQLITE_FTS5_TRIGRAM_REQUIRED", {
      message: "SQLite 需要 FTS5 trigram 支持",
      details: { fts5: capabilities.fts5, trigram: capabilities.trigram },
    });
}

export async function openManagedDatabase(input: {
  path: string;
  migrationDirectory: string;
  backupDirectory: string;
}): Promise<ManagedDatabase> {
  const hadDatabase = existsSync(input.path) && statSync(input.path).size > 0;
  mkdirSync(dirname(input.path), { recursive: true });
  const sqlite = new Database(input.path);
  try {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("synchronous = FULL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    sqlite.pragma("wal_autocheckpoint = 1000");
    sqlite.pragma("temp_store = MEMORY");
    assertSqliteCapabilities(sqlite);
    const schemaVersion = await runMigrations({
      sqlite,
      databasePath: input.path,
      migrationDirectory: input.migrationDirectory,
      backupDirectory: input.backupDirectory,
      hadDatabase,
    });
    return { sqlite, path: input.path, schemaVersion };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

export function quickCheck(sqlite: Database.Database): boolean {
  const rows = sqlite.pragma("quick_check") as Array<{ quick_check: string }>;
  return rows.length === 1 && rows[0]?.quick_check === "ok";
}

export function foreignKeyCheck(sqlite: Database.Database): boolean {
  const rows = sqlite.pragma("foreign_key_check") as Array<Record<string, unknown>>;
  return rows.length === 0;
}
