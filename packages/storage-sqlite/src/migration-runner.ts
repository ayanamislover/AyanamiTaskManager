import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { AtmError } from "@ayanami-task/errors";

export type Migration = {
  version: number;
  name: string;
  path: string;
  sql: string;
  sha256: string;
};

export function loadMigrationPlan(directory: string): Migration[] {
  const files = readdirSync(directory)
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort();
  const plan = files.map((name) => {
    const version = Number(name.slice(0, 4));
    const path = join(directory, name);
    const sql = readFileSync(path, "utf8");
    return {
      version,
      name,
      path,
      sql,
      sha256: createHash("sha256").update(sql).digest("hex"),
    };
  });
  for (let index = 0; index < plan.length; index += 1) {
    if (plan[index]!.version !== index + 1) {
      throw new AtmError("MIGRATION_GAP", {
        message: `迁移序号断裂：expected ${index + 1}, found ${plan[index]!.version}`,
        details: { expected: index + 1, actual: plan[index]!.version },
      });
    }
  }
  if (plan.length === 0)
    throw new AtmError("MIGRATION_PLAN_EMPTY", {
      message: "迁移计划为空",
      details: { directory },
    });
  return plan;
}

type AppliedMigration = {
  version: number;
  name: string;
  content_sha256: string;
  hash_origin: string;
};

function ensureMigrationTable(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      hash_origin TEXT NOT NULL CHECK(hash_origin IN ('APPLIED','LEGACY_BASELINE_UNVERIFIED'))
    )
  `);
}

function assertAppliedPlan(applied: AppliedMigration[], plan: Migration[]): void {
  const byVersion = new Map(plan.map((migration) => [migration.version, migration]));
  const appliedVersions = new Set(applied.map((migration) => migration.version));
  const maximum = Math.max(0, ...appliedVersions);
  for (const migration of plan) {
    if (migration.version < maximum && !appliedVersions.has(migration.version)) {
      throw new AtmError("MIGRATION_HISTORY_GAP", {
        message: `迁移历史断裂：${migration.version}`,
        details: { version: migration.version },
      });
    }
  }
  for (const row of applied) {
    const local = byVersion.get(row.version);
    if (!local)
      throw new AtmError("MIGRATION_FILE_MISSING", {
        message: `迁移文件缺失：${row.version}`,
        details: { version: row.version },
      });
    if (local.name !== row.name)
      throw new AtmError("MIGRATION_NAME_MISMATCH", {
        message: `迁移名称不匹配：${row.version}`,
        details: { version: row.version, expected: row.name, actual: local.name },
      });
    if (local.sha256 !== row.content_sha256) {
      throw new AtmError("MIGRATION_HASH_MISMATCH", {
        message: `迁移哈希不匹配：${row.version}`,
        details: { version: row.version },
      });
    }
    if (!new Set(["APPLIED", "LEGACY_BASELINE_UNVERIFIED"]).has(row.hash_origin)) {
      throw new AtmError("MIGRATION_HASH_ORIGIN", {
        message: `迁移哈希来源无效：${row.version}`,
        details: { version: row.version },
      });
    }
  }
}

export async function runMigrations(input: {
  sqlite: Database.Database;
  databasePath: string;
  migrationDirectory: string;
  backupDirectory: string;
  hadDatabase: boolean;
}): Promise<number> {
  const plan = loadMigrationPlan(input.migrationDirectory);
  ensureMigrationTable(input.sqlite);
  const applied = input.sqlite
    .prepare(
      "SELECT version, name, content_sha256, hash_origin FROM schema_migrations ORDER BY version",
    )
    .all() as AppliedMigration[];
  assertAppliedPlan(applied, plan);
  const appliedVersions = new Set(applied.map((row) => row.version));
  const pending = plan.filter((migration) => !appliedVersions.has(migration.version));
  if (pending.length > 0 && input.hadDatabase) {
    mkdirSync(input.backupDirectory, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(":", "-");
    const target = join(
      input.backupDirectory,
      `pre-migration-v${applied.at(-1)?.version ?? 0}-${stamp}.sqlite`,
    );
    await input.sqlite.backup(target);
  }
  const apply = input.sqlite.transaction((migration: Migration) => {
    input.sqlite.exec(migration.sql);
    input.sqlite
      .prepare(
        `INSERT INTO schema_migrations(version, name, applied_at, content_sha256, hash_origin)
         VALUES (?, ?, ?, ?, 'APPLIED')`,
      )
      .run(migration.version, migration.name, new Date().toISOString(), migration.sha256);
  });
  for (const migration of pending) apply(migration);
  return plan.at(-1)!.version;
}

export function databaseDirectory(path: string): string {
  return dirname(path);
}
