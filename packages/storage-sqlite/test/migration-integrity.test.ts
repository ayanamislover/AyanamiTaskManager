import { appendFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("迁移完整性", () => {
  it("已应用迁移内容被改写后拒绝重新打开数据库", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-migration-"));
    temporary.push(root);
    const migrationsRoot = join(root, "migrations");
    cpSync(resolve(process.cwd(), "migrations"), migrationsRoot, { recursive: true });
    const dataDir = join(root, "data");
    const manager = await AyanamiDatabaseManager.open({ dataDir, migrationsRoot });
    manager.close();
    appendFileSync(join(migrationsRoot, "registry", "0001_initial.sql"), "\n-- tampered\n");
    await expect(AyanamiDatabaseManager.open({ dataDir, migrationsRoot })).rejects.toThrowError(
      "MIGRATION_HASH_MISMATCH",
    );
  });
});
