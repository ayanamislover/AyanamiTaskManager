import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Registry 与每项目独立数据库", () => {
  it("一次创建十个项目时分配十个可独立打开的项目库", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-storage-"));
    temporary.push(dataDir);
    const manager = await AyanamiDatabaseManager.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const projects = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          manager.createProject({ name: `测试项目 ${index + 1}`, sourcePath: null }),
        ),
      );
      expect(new Set(projects.map((project) => project.databasePath)).size).toBe(10);
      expect(projects.every((project) => project.lifecycle === "ACTIVE")).toBe(true);
      const health = await manager.doctor();
      expect(health.registry.ok).toBe(true);
      expect(health.projects).toHaveLength(10);
      expect(health.projects.every((project) => project.ok && project.separateDatabase)).toBe(true);
    } finally {
      manager.close();
    }
  });
});
