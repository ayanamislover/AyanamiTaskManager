import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager, probeAppliedMigrations } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const migrationsRoot = resolve(process.cwd(), "migrations");

/** 目录里每个文件的名字、大小、mtime、内容哈希：探测前后必须一字不差。 */
function fingerprint(directory: string): string[] {
  return readdirSync(directory)
    .sort()
    .map((name) => {
      const path = join(directory, name);
      const stat = statSync(path);
      const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
      return `${name} ${stat.size} ${stat.mtimeMs} ${hash}`;
    });
}

async function registryDatabase(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "atm-probe-"));
  temporary.push(root);
  const manager = await AyanamiDatabaseManager.open({ dataDir: root, migrationsRoot });
  manager.close();
  return join(root, "registry", "registry.sqlite");
}

describe("安装探测：只读核对已应用迁移", () => {
  it("干净关闭的库：读进内存核对，数据目录零写入（不留 -shm/-wal，mtime 不变）", async () => {
    const database = await registryDatabase();
    const directory = join(database, "..");
    const before = fingerprint(directory);
    expect(before.some((line) => line.startsWith("registry.sqlite-"))).toBe(false);
    expect(probeAppliedMigrations(database, join(migrationsRoot, "registry"))).toEqual({
      applied: 8,
      mode: "snapshot",
    });
    expect(fingerprint(directory)).toEqual(before);
  });

  it("服务正在写（已有 -wal）：只读直连，读得到只在 WAL 里的提交", async () => {
    const database = await registryDatabase();
    const writer = new Database(database);
    try {
      writer.pragma("journal_mode = WAL");
      writer.pragma("wal_autocheckpoint = 0");
      // 一条只在 WAL 里、没检查点的迁移记录：内存副本看不到它，直连必须看到。
      writer
        .prepare(
          `INSERT INTO schema_migrations(version, name, applied_at, content_sha256, hash_origin)
           VALUES (99, '0099_from_the_future.sql', '2026-09-30T00:00:00.000Z', 'x', 'APPLIED')`,
        )
        .run();
      expect(() => probeAppliedMigrations(database, join(migrationsRoot, "registry"))).toThrow(
        expect.objectContaining({ code: "MIGRATION_FILE_MISSING" }),
      );
    } finally {
      writer.close();
    }
  });

  it("随包迁移文件与库里的哈希对不上：拒绝", async () => {
    const database = await registryDatabase();
    const writer = new Database(database);
    writer
      .prepare("UPDATE schema_migrations SET content_sha256 = 'tampered' WHERE version = 3")
      .run();
    writer.close();
    expect(() => probeAppliedMigrations(database, join(migrationsRoot, "registry"))).toThrow(
      expect.objectContaining({ code: "MIGRATION_HASH_MISMATCH" }),
    );
  });
});
