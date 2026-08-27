import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { AyanamiDatabaseManager } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("在线备份与可回滚恢复", () => {
  it("从活跃 WAL 数据库创建校验快照，并恢复到快照时点", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-backup-"));
    temporary.push(dataDir);
    const manager = await AyanamiDatabaseManager.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const project = await manager.createProject({ name: "备份测试", sourcePath: null });
      const database = await manager.openProject(project.code);
      database.sqlite.prepare("UPDATE project_meta SET description = '快照前'").run();

      const backup = await manager.createBackup({
        scope: "PROJECT",
        project: project.code,
        reason: "MANUAL",
      });
      expect(backup.verifiedAt).not.toBeNull();
      expect(manager.listBackups(project.code)).toContainEqual(
        expect.objectContaining({ id: backup.id }),
      );

      database.sqlite.prepare("UPDATE project_meta SET description = '快照后'").run();
      await manager.restoreBackup(backup.id);
      const restored = await manager.openProject(project.code);
      expect(
        (
          restored.sqlite.prepare("SELECT description FROM project_meta").get() as {
            description: string;
          }
        ).description,
      ).toBe("快照前");
      expect(manager.listBackups(project.code)).toContainEqual(
        expect.objectContaining({ reason: "PRE_RESTORE" }),
      );
    } finally {
      manager.close();
    }
  });

  it("拒绝哈希损坏的备份且不覆盖当前项目库", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-backup-corrupt-"));
    temporary.push(dataDir);
    const manager = await AyanamiDatabaseManager.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const project = await manager.createProject({ name: "损坏测试", sourcePath: null });
      const database = await manager.openProject(project.code);
      database.sqlite.prepare("UPDATE project_meta SET description = '必须保留'").run();
      const backup = await manager.createBackup({
        scope: "PROJECT",
        project: project.code,
        reason: "MANUAL",
      });
      appendFileSync(backup.path, "corrupted");

      await expect(manager.restoreBackup(backup.id)).rejects.toMatchObject({
        code: "BACKUP_HASH_MISMATCH",
        details: null,
      });
      expect(
        (
          database.sqlite.prepare("SELECT description FROM project_meta").get() as {
            description: string;
          }
        ).description,
      ).toBe("必须保留");
      expect(manager.getProject(project.code).lifecycle).toBe("ACTIVE");
    } finally {
      manager.close();
    }
  });

  it("导出含一致性快照和校验清单的 aytproj，并提供 JSON/CSV", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-export-"));
    temporary.push(dataDir);
    const manager = await AyanamiDatabaseManager.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const project = await manager.createProject({
        name: "交换测试",
        sourcePath: null,
        code: "SWAP",
      });
      const archive = await manager.exportProject(project.code, "aytproj");
      const files = unzipSync(new Uint8Array(readFileSync(archive.path)));
      expect(Object.keys(files).sort()).toEqual([
        "SHA256SUMS.txt",
        "manifest.json",
        "project.sqlite",
      ]);
      expect(JSON.parse(strFromU8(files["manifest.json"]!))).toMatchObject({
        format: "ayanami-task-project",
        project: { code: "SWAP" },
      });
      expect(strFromU8(files["SHA256SUMS.txt"]!)).toContain("project.sqlite");

      const json = await manager.exportProject(project.code, "json");
      const csv = await manager.exportProject(project.code, "csv");
      expect(existsSync(json.path)).toBe(true);
      expect(JSON.parse(readFileSync(json.path, "utf8"))).toMatchObject({
        project: { code: "SWAP" },
      });
      expect(readFileSync(csv.path, "utf8")).toContain("project_code,task_key,parent_key");
    } finally {
      manager.close();
    }
  });
});
