import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  AyanamiDatabaseManager,
  BACKUP_RETENTION_DEFAULTS,
  backupKeepCount,
  pruneMigrationBackupFiles,
  runMigrations,
} from "../src/index.js";

const temporary: string[] = [];
const managers: AyanamiDatabaseManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function openManager(prefix: string) {
  const dataDir = mkdtempSync(join(tmpdir(), `atm-backup-retention-${prefix}-`));
  temporary.push(dataDir);
  const manager = await AyanamiDatabaseManager.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  managers.push(manager);
  return { dataDir, manager };
}

function backupsOf(manager: AyanamiDatabaseManager, projectId: string, reason: string) {
  return manager.listBackups(projectId).filter((backup) => backup.reason === reason);
}

async function touchProject(manager: AyanamiDatabaseManager, projectId: string, text: string) {
  const database = await manager.openProject(projectId);
  database.sqlite.prepare("UPDATE project_meta SET description = ? WHERE singleton = 1").run(text);
}

describe("备份保留策略", () => {
  it("默认每类只留两份，其余原因走 otherKeep，取值越界时收敛到上下限", () => {
    expect(BACKUP_RETENTION_DEFAULTS).toEqual({ dailyKeep: 2, weeklyKeep: 2, otherKeep: 2 });
    for (const reason of ["DAILY", "WEEKLY", "MANUAL", "PRE_RESTORE", "EXPORT"]) {
      expect(backupKeepCount(undefined, reason)).toBe(2);
      expect(backupKeepCount({}, reason)).toBe(2);
      expect(backupKeepCount({ dailyKeep: "x", weeklyKeep: "x", otherKeep: "x" }, reason)).toBe(2);
      expect(backupKeepCount({ dailyKeep: 0, weeklyKeep: 0, otherKeep: 0 }, reason)).toBe(1);
    }
    expect(backupKeepCount({ dailyKeep: 400 }, "DAILY")).toBe(90);
    expect(backupKeepCount({ weeklyKeep: 400 }, "WEEKLY")).toBe(52);
    expect(backupKeepCount({ otherKeep: 400 }, "MANUAL")).toBe(20);
    expect(backupKeepCount({ dailyKeep: 5, weeklyKeep: 6, otherKeep: 7 }, "DAILY")).toBe(5);
    expect(backupKeepCount({ dailyKeep: 5, weeklyKeep: 6, otherKeep: 7 }, "WEEKLY")).toBe(6);
    expect(backupKeepCount({ dailyKeep: 5, weeklyKeep: 6, otherKeep: 7 }, "PRE_TRASH")).toBe(7);
  });

  it("手动备份也有上限：第三份挤掉最旧的一份，文件和清单一起删掉", async () => {
    const { manager } = await openManager("manual");
    const project = await manager.createProject({
      name: "手动备份",
      sourcePath: null,
      code: "MAN",
    });
    const created = [];
    for (const index of [1, 2, 3]) {
      await touchProject(manager, project.id, `手动 ${index}`);
      created.push(
        await manager.createBackup({ scope: "PROJECT", project: project.id, reason: "MANUAL" }),
      );
    }
    const kept = backupsOf(manager, project.id, "MANUAL");
    expect(kept).toHaveLength(2);
    expect(kept.map((backup) => backup.id)).toEqual([created[2]!.id, created[1]!.id]);
    expect(existsSync(created[0]!.path)).toBe(false);
    expect(existsSync(`${created[0]!.path}.manifest.json`)).toBe(false);
    expect(existsSync(created[1]!.path)).toBe(true);
  });

  it("内容没变就沿用上一份自动备份，只把时间戳往前挪，不再多存一个文件", async () => {
    const { manager } = await openManager("reuse");
    const project = await manager.createProject({
      name: "空闲项目",
      sourcePath: null,
      code: "IDLE",
    });
    const first = await manager.runMaintenance(new Date("2026-09-01T10:00:00.000Z"));
    expect(first.dailyCreated).toBeGreaterThan(0);
    const daily = backupsOf(manager, project.id, "DAILY");
    expect(daily).toHaveLength(1);

    const second = await manager.runMaintenance(new Date("2026-09-02T10:00:00.000Z"));
    expect(second.reusedBackups).toBeGreaterThan(0);
    const afterIdle = backupsOf(manager, project.id, "DAILY");
    expect(afterIdle).toHaveLength(1);
    expect(afterIdle[0]!.id).toBe(daily[0]!.id);
    expect(afterIdle[0]!.createdAt).toBe("2026-09-02T10:00:00.000Z");
    const directory = dirname(daily[0]!.path);
    expect(
      readdirSync(directory).filter((name) => name.includes("-daily-") && name.endsWith(".sqlite")),
    ).toHaveLength(1);

    await touchProject(manager, project.id, "有变化了");
    const third = await manager.runMaintenance(new Date("2026-09-03T10:00:00.000Z"));
    expect(third.dailyCreated).toBeGreaterThan(0);
    expect(backupsOf(manager, project.id, "DAILY")).toHaveLength(2);
  });

  it("维护会把调小保留数之前留下的旧备份一并收敛", async () => {
    const { manager } = await openManager("legacy");
    const project = await manager.createProject({ name: "旧备份", sourcePath: null, code: "OLD" });
    manager.setSetting("backup.policy", { enabled: true, dailyKeep: 9, weeklyKeep: 9 });
    const legacy = [];
    for (const day of [1, 2, 3, 4]) {
      await touchProject(manager, project.id, `第 ${day} 天`);
      legacy.push(
        await manager.createBackup({
          scope: "PROJECT",
          project: project.id,
          reason: "DAILY",
          createdAt: `2026-09-0${day}T10:00:00.000Z`,
        }),
      );
    }
    expect(backupsOf(manager, project.id, "DAILY")).toHaveLength(4);

    manager.setSetting(
      "backup.policy",
      { enabled: true, dailyKeep: 2, weeklyKeep: 2, otherKeep: 2 },
      0,
    );
    const result = await manager.runMaintenance(new Date("2026-09-05T10:00:00.000Z"));
    expect(result.prunedBackups).toBeGreaterThan(0);
    const remaining = backupsOf(manager, project.id, "DAILY");
    expect(remaining).toHaveLength(2);
    expect(existsSync(legacy[0]!.path)).toBe(false);
    expect(existsSync(legacy[1]!.path)).toBe(false);
  });

  it("升级前备份只留最新两份：迁移时清一次，维护时把历史遗留的也扫掉", async () => {
    const { dataDir, manager } = await openManager("migration");
    const project = await manager.createProject({ name: "升级前", sourcePath: null, code: "MIG" });
    const directories = [
      join(dirname(manager.getProject(project.id).databasePath), "backups"),
      join(dataDir, "backups", "registry"),
    ];
    for (const directory of directories) {
      mkdirSync(directory, { recursive: true });
      for (const version of [1, 3, 5, 7]) {
        writeFileSync(
          join(directory, `pre-migration-v${version}-2026-09-0${version}T10-00-00.000Z.sqlite`),
          "x",
        );
      }
      writeFileSync(join(directory, "keep-me.sqlite"), "x");
    }

    await manager.runMaintenance(new Date("2026-09-09T10:00:00.000Z"));
    for (const directory of directories) {
      const files = readdirSync(directory).filter((name) => name.startsWith("pre-migration-"));
      expect(files.sort()).toEqual([
        "pre-migration-v5-2026-09-05T10-00-00.000Z.sqlite",
        "pre-migration-v7-2026-09-07T10-00-00.000Z.sqlite",
      ]);
      expect(existsSync(join(directory, "keep-me.sqlite"))).toBe(true);
    }
  });

  it("迁移写下新的升级前备份时，同一目录里多余的旧备份当场清掉", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-backup-retention-run-"));
    temporary.push(root);
    const migrations = join(root, "migrations");
    const backupDirectory = join(root, "backups");
    mkdirSync(migrations, { recursive: true });
    mkdirSync(backupDirectory, { recursive: true });
    writeFileSync(
      join(migrations, "0001_initial.sql"),
      "CREATE TABLE demo(id INTEGER PRIMARY KEY);",
    );
    for (const version of [1, 2, 3]) {
      writeFileSync(
        join(backupDirectory, `pre-migration-v${version}-2026-09-0${version}T10-00-00.000Z.sqlite`),
        "x",
      );
    }
    const databasePath = join(root, "demo.sqlite");
    const sqlite = new Database(databasePath);
    try {
      await runMigrations({
        sqlite,
        databasePath,
        migrationDirectory: migrations,
        backupDirectory,
        hadDatabase: true,
      });
    } finally {
      sqlite.close();
    }
    const files = readdirSync(backupDirectory)
      .filter((name) => name.startsWith("pre-migration-"))
      .sort();
    // 新写下的那份 + 最新的一份旧备份。
    expect(files).toHaveLength(2);
    expect(files).toContain("pre-migration-v3-2026-09-03T10-00-00.000Z.sqlite");
    expect(files.some((name) => name.startsWith("pre-migration-v0-"))).toBe(true);
  });

  it("单独清理升级前备份时保留最新的两份，目录不存在也不报错", () => {
    const directory = mkdtempSync(join(tmpdir(), "atm-backup-retention-files-"));
    temporary.push(directory);
    for (const version of [2, 4, 6]) {
      writeFileSync(
        join(directory, `pre-migration-v${version}-2026-09-0${version}T10-00-00.000Z.sqlite`),
        "x",
      );
    }
    expect(pruneMigrationBackupFiles(directory)).toBe(1);
    expect(readdirSync(directory).sort()).toEqual([
      "pre-migration-v4-2026-09-04T10-00-00.000Z.sqlite",
      "pre-migration-v6-2026-09-06T10-00-00.000Z.sqlite",
    ]);
    expect(pruneMigrationBackupFiles(join(directory, "不存在"))).toBe(0);
  });
});
