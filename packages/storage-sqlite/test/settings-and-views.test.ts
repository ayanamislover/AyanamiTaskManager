import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Registry 设置与保存视图", () => {
  it("持久化项目筛选并使用乐观版本防止静默覆盖", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-saved-views-"));
    temporary.push(dataDir);
    const manager = await AyanamiDatabaseManager.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      await manager.createProject({ name: "视图测试", sourcePath: null, code: "VIEW" });
      const created = manager.createSavedView({
        scope: "PROJECT",
        project: "VIEW",
        name: "需要处理",
        query: { statuses: ["BLOCKED", "WAITING_USER"] },
        sort: { field: "priority", direction: "desc" },
      });
      expect(created).toMatchObject({ projectCode: "VIEW", name: "需要处理", version: 0 });
      const updated = manager.updateSavedView(created.id, {
        expectedVersion: 0,
        name: "阻塞与等待",
        query: { status: "BLOCKED" },
        sort: {},
      });
      expect(updated).toMatchObject({ name: "阻塞与等待", version: 1 });
      expect(manager.listSavedViews("VIEW")).toEqual([
        expect.objectContaining({ id: created.id, version: 1 }),
      ]);
      expect(() =>
        manager.updateSavedView(created.id, { expectedVersion: 0, name: "过期写入" }),
      ).toThrow("VERSION_CONFLICT");
    } finally {
      manager.close();
    }
  });

  it("设置写入可重试但不允许旧版本覆盖新值", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-settings-"));
    temporary.push(dataDir);
    const manager = await AyanamiDatabaseManager.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const created = manager.setSetting("backup.policy", {
        enabled: true,
        dailyKeep: 7,
        weeklyKeep: 4,
      });
      expect(created).toMatchObject({ key: "backup.policy", version: 0, value: { enabled: true } });
      const updated = manager.setSetting("backup.policy", { enabled: false }, 0);
      expect(updated).toMatchObject({ version: 1, value: { enabled: false } });
      expect(() => manager.setSetting("backup.policy", { enabled: true }, 0)).toThrow(
        "VERSION_CONFLICT",
      );
      expect(manager.listSettings()).toContainEqual(updated);
    } finally {
      manager.close();
    }
  });
});
