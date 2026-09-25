import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AyanamiDatabaseManager,
  openManagedDatabase,
  sqliteSynchronousMode,
} from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const SYNCHRONOUS = { OFF: 0, FULL: 2 } as const;
const migrationsRoot = resolve(process.cwd(), "migrations");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (name === "node_modules" || name === "dist") return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx|mts|cts)$/u.test(name) ? [path] : [];
  });
}

describe("SQLite 持久性：生产 fsync，测试不 fsync", () => {
  it("Vitest 进程里注册表与项目库都关掉了 fsync，否则每次提交的 fsync 会把用例拖成超时", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-sqlite-durability-"));
    temporary.push(dataDir);
    const manager = await AyanamiDatabaseManager.open({ dataDir, migrationsRoot });
    try {
      const project = await manager.createProject({
        name: "持久性",
        sourcePath: null,
        code: "DURABLE",
      });
      const database = await manager.openProject(project.code);
      expect(manager.registry.sqlite.pragma("synchronous", { simple: true })).toBe(SYNCHRONOUS.OFF);
      expect(database.sqlite.pragma("synchronous", { simple: true })).toBe(SYNCHRONOUS.OFF);
    } finally {
      manager.close();
    }
  });

  it("缺 VITEST 或缺显式声明时一律 FULL，单个环境变量漏进生产放松不了持久性", () => {
    expect(sqliteSynchronousMode({})).toBe("FULL");
    expect(sqliteSynchronousMode({ ATM_TEST_SQLITE_SYNCHRONOUS: "OFF" })).toBe("FULL");
    expect(sqliteSynchronousMode({ VITEST: "true" })).toBe("FULL");
    expect(sqliteSynchronousMode({ VITEST: "true", ATM_TEST_SQLITE_SYNCHRONOUS: "off" })).toBe(
      "FULL",
    );
    expect(sqliteSynchronousMode({ VITEST: "true", ATM_TEST_SQLITE_SYNCHRONOUS: "OFF" })).toBe(
      "OFF",
    );
  });

  it("去掉测试声明后真实打开的库回到 synchronous=FULL", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-sqlite-durability-full-"));
    temporary.push(dataDir);
    const previous = process.env.ATM_TEST_SQLITE_SYNCHRONOUS;
    delete process.env.ATM_TEST_SQLITE_SYNCHRONOUS;
    try {
      const database = await openManagedDatabase({
        path: join(dataDir, "registry.sqlite"),
        migrationDirectory: join(migrationsRoot, "registry"),
        backupDirectory: join(dataDir, "backups"),
      });
      try {
        expect(database.sqlite.pragma("synchronous", { simple: true })).toBe(SYNCHRONOUS.FULL);
      } finally {
        database.sqlite.close();
      }
    } finally {
      if (previous === undefined) delete process.env.ATM_TEST_SQLITE_SYNCHRONOUS;
      else process.env.ATM_TEST_SQLITE_SYNCHRONOUS = previous;
    }
  });

  it("只有 openManagedDatabase 设置 synchronous，绕开它的库不受测试开关约束", () => {
    const root = process.cwd();
    const setters = ["apps", "packages"]
      .flatMap((top) => readdirSync(join(root, top)).map((name) => join(root, top, name, "src")))
      .filter((directory) => {
        try {
          return statSync(directory).isDirectory();
        } catch {
          return false;
        }
      })
      .flatMap(sourceFiles)
      .filter((path) => /pragma\(\s*[`"']\s*synchronous\b/iu.test(readFileSync(path, "utf8")))
      .map((path) => relative(root, path).replaceAll("\\", "/"));
    // 阳性对照：扫描本身能命中唯一合法的设置点，避免正则写错后永远返回空数组。
    expect(setters).toEqual(["packages/storage-sqlite/src/database.ts"]);
  });
});
