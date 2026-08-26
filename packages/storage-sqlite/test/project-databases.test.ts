import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
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

  it("doctor 检查并标记活动、归档和垃圾箱中的现存项目库", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-storage-"));
    temporary.push(dataDir);
    const manager = await AyanamiDatabaseManager.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const active = await manager.createProject({ name: "活动项目", sourcePath: null });
      const archived = await manager.createProject({ name: "归档项目", sourcePath: null });
      const trashed = await manager.createProject({ name: "垃圾箱项目", sourcePath: null });
      manager.setProjectLifecycle(archived.code, "ARCHIVED");
      manager.setProjectLifecycle(trashed.code, "TRASHED");

      const health = await manager.doctor();

      expect(health.projects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: active.code, lifecycle: "ACTIVE", ok: true }),
          expect.objectContaining({ code: archived.code, lifecycle: "ARCHIVED", ok: true }),
          expect.objectContaining({ code: trashed.code, lifecycle: "TRASHED", ok: true }),
        ]),
      );
      expect(health.projects).toHaveLength(3);
      expect(health.projectCounts).toEqual({
        ACTIVE: { total: 1, failed: 0 },
        ARCHIVED: { total: 1, failed: 0 },
        TRASHED: { total: 1, failed: 0 },
      });
    } finally {
      manager.close();
    }
  });

  it("doctor 会发现垃圾箱项目库中的外键损坏", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-storage-"));
    temporary.push(dataDir);
    const manager = await AyanamiDatabaseManager.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const project = await manager.createProject({ name: "损坏项目", sourcePath: null });
      manager.setProjectLifecycle(project.code, "TRASHED");
      const sqlite = new Database(project.databasePath);
      try {
        sqlite.pragma("foreign_keys = OFF");
        const now = new Date().toISOString();
        sqlite
          .prepare(
            `INSERT INTO checklist_items(
               id, work_item_id, title, kind, status, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run("broken-checklist", "missing-work-item", "损坏关系", "REQUIRED", "TODO", now, now);
      } finally {
        sqlite.close();
      }

      const health = await manager.doctor();

      expect(health.projects).toContainEqual(
        expect.objectContaining({
          code: project.code,
          lifecycle: "TRASHED",
          quickCheck: true,
          foreignKeys: false,
          ok: false,
        }),
      );
    } finally {
      manager.close();
    }
  });
});
