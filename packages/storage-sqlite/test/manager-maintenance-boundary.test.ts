import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AyanamiDatabaseManager } from "../src/index.js";

const temporary: string[] = [];
const managers: AyanamiDatabaseManager[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const manager of managers.splice(0)) manager.close();
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function openManager(prefix: string) {
  const dataDir = mkdtempSync(join(tmpdir(), `atm-manager-boundary-${prefix}-`));
  temporary.push(dataDir);
  const manager = await AyanamiDatabaseManager.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  managers.push(manager);
  return { dataDir, manager };
}

function closeTracked(manager: AyanamiDatabaseManager): void {
  manager.close();
  const index = managers.indexOf(manager);
  if (index >= 0) managers.splice(index, 1);
}

function description(database: Awaited<ReturnType<AyanamiDatabaseManager["openProject"]>>): string {
  return String(
    (
      database.sqlite.prepare("SELECT description FROM project_meta WHERE singleton = 1").get() as {
        description: string;
      }
    ).description,
  );
}

async function restoreFixture(code: string) {
  const { dataDir, manager } = await openManager(code.toLowerCase());
  const project = await manager.createProject({ name: code, sourcePath: null, code });
  const database = await manager.openProject(project.id);
  database.sqlite.prepare("UPDATE project_meta SET description = 'snapshot'").run();
  const backup = await manager.createBackup({
    scope: "PROJECT",
    project: project.id,
    reason: "MANUAL",
  });
  database.sqlite.prepare("UPDATE project_meta SET description = 'latest'").run();
  return { dataDir, manager, project, database, backup };
}

describe("Project database pool boundaries", () => {
  it("evicts the least recently used database at max-open and preserves explicit close behavior", async () => {
    const { manager } = await openManager("lru");
    let tick = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => (tick += 1));
    const projects = [];
    for (let index = 0; index < 9; index += 1) {
      projects.push(
        await manager.createProject({
          name: `Pool ${index}`,
          sourcePath: null,
          code: `PL${index}`,
        }),
      );
    }
    const opened = [];
    for (const project of projects.slice(0, 8)) opened.push(await manager.openProject(project.id));
    expect(await manager.openProject(projects[0]!.id)).toBe(opened[0]);
    const ninth = await manager.openProject(projects[8]!.id);
    expect(opened[0]!.sqlite.open).toBe(true);
    expect(opened[1]!.sqlite.open).toBe(false);
    expect(ninth.sqlite.open).toBe(true);
    expect(manager.closeIdleProjects(0, tick + 1)).toBe(8);
    expect(opened[0]!.sqlite.open).toBe(false);
    expect(ninth.sqlite.open).toBe(false);
  });

  it("keeps openProject routed through the public getProject facade", async () => {
    const { manager } = await openManager("pool-spy");
    const project = await manager.createProject({
      name: "Pool spy",
      sourcePath: null,
      code: "PSPY",
    });
    const getProject = vi.spyOn(manager, "getProject");
    await manager.openProject(project.id);
    expect(getProject).toHaveBeenCalledWith(project.id);
  });
});

describe("Backup and restore failure atomicity", () => {
  it("keeps backup and maintenance nesting observable through public facade methods", async () => {
    const { manager } = await openManager("facade-spy");
    const project = await manager.createProject({
      name: "Facade spy",
      sourcePath: null,
      code: "FSPY",
    });
    const getProject = vi.spyOn(manager, "getProject");
    const openProject = vi.spyOn(manager, "openProject");
    const listBackups = vi.spyOn(manager, "listBackups");
    const backup = await manager.createBackup({
      scope: "PROJECT",
      project: project.id,
      reason: "MANUAL",
    });
    expect(getProject).toHaveBeenCalledWith(project.id);
    expect(openProject).toHaveBeenCalledWith(project.id);
    expect(listBackups).toHaveBeenCalledWith();

    const closeIdleProjects = vi.spyOn(manager, "closeIdleProjects").mockReturnValue(0);
    const repairSummaries = vi
      .spyOn(manager, "repairSummaries")
      .mockResolvedValue({ recoveredProjects: 0, errors: [] });
    const listProjects = vi.spyOn(manager, "listProjects").mockReturnValue([]);
    const createBackup = vi.spyOn(manager, "createBackup").mockResolvedValue(backup);
    await manager.runMaintenance(new Date("2030-01-01T10:00:00.000Z"));
    expect(closeIdleProjects).toHaveBeenCalledWith(
      5 * 60_000,
      Date.parse("2030-01-01T10:00:00.000Z"),
    );
    expect(repairSummaries).toHaveBeenCalledWith();
    expect(listProjects).toHaveBeenCalledWith();
    expect(createBackup).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "REGISTRY", reason: "DAILY" }),
    );
  });

  it("keeps post-commit retention failures separate from a valid backup result", async () => {
    const { manager } = await openManager("retention-failure");
    const project = await manager.createProject({
      name: "Retention failure",
      sourcePath: null,
      code: "RETF",
    });
    manager.setSetting("backup.policy", { enabled: true, dailyKeep: 1, weeklyKeep: 1 });
    const first = await manager.createBackup({
      scope: "PROJECT",
      project: project.id,
      reason: "DAILY",
      createdAt: "2026-08-27T10:00:00.000Z",
    });
    manager.registry.sqlite.exec(`
      CREATE TRIGGER fail_backup_retention_delete
      BEFORE DELETE ON backup_catalog
      BEGIN
        SELECT RAISE(ABORT, 'injected retention cleanup failure');
      END;
    `);

    const second = await manager.createBackup({
      scope: "PROJECT",
      project: project.id,
      reason: "DAILY",
      createdAt: "2026-08-28T10:00:00.000Z",
    });
    expect(second).toMatchObject({ projectId: project.id, reason: "DAILY" });
    expect(
      manager.listBackups(project.id).filter((backup) => backup.reason === "DAILY"),
    ).toHaveLength(2);
    expect(existsSync(first.path)).toBe(true);
    expect(existsSync(second.path)).toBe(true);
    expect(
      manager.registry.sqlite
        .prepare("SELECT COUNT(*) AS count FROM global_events WHERE type = 'backup.failed'")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      manager.registry.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM global_events WHERE type = 'backup.retention_failed'",
        )
        .get(),
    ).toEqual({ count: 1 });
    const deletionMarker = `${first.path}.delete-pending`;
    expect(existsSync(deletionMarker)).toBe(true);
    const dataDir = manager.dataDir;
    closeTracked(manager);
    const reopened = await AyanamiDatabaseManager.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    managers.push(reopened);
    expect(existsSync(deletionMarker)).toBe(false);
    expect(existsSync(first.path)).toBe(true);
    expect(
      reopened.listBackups(project.id).filter((backup) => backup.reason === "DAILY"),
    ).toHaveLength(2);
  });

  it("removes final backup artifacts when Registry catalog/event commit fails", async () => {
    const { manager, project } = await restoreFixture("BCFAIL");
    const backupDirectory = join(dirname(project.databasePath), "backups");
    const beforeFiles = readdirSync(backupDirectory).sort();
    const beforeCatalog = manager.listBackups(project.id).length;
    manager.registry.sqlite.exec(`
      CREATE TRIGGER fail_backup_created_event
      BEFORE INSERT ON global_events
      WHEN NEW.type = 'backup.created'
      BEGIN
        SELECT RAISE(ABORT, 'injected backup catalog event failure');
      END;
    `);

    await expect(
      manager.createBackup({ scope: "PROJECT", project: project.id, reason: "MANUAL" }),
    ).rejects.toThrow("injected backup catalog event failure");
    expect(manager.listBackups(project.id)).toHaveLength(beforeCatalog);
    expect(readdirSync(backupDirectory).sort()).toEqual(beforeFiles);
    expect(
      manager.registry.sqlite
        .prepare("SELECT COUNT(*) AS count FROM global_events WHERE type = 'backup.created'")
        .get(),
    ).toEqual({ count: beforeCatalog });
    expect(
      manager.registry.sqlite
        .prepare("SELECT COUNT(*) AS count FROM global_events WHERE type = 'backup.failed'")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("reconciles pending backup markers by Registry commit state after restart", async () => {
    const fixture = await restoreFixture("BPEND");
    const pruned = await fixture.manager.createBackup({
      scope: "PROJECT",
      project: fixture.project.id,
      reason: "MANUAL",
    });
    const backupDirectory = dirname(fixture.backup.path);
    const orphanPath = join(backupDirectory, "unregistered-crash.sqlite");
    copyFileSync(fixture.backup.path, orphanPath);
    writeFileSync(`${orphanPath}.manifest.json`, "{}\n", "utf8");
    writeFileSync(`${orphanPath}.pending`, "{}\n", "utf8");
    writeFileSync(`${orphanPath}.tmp-wal`, "stale", "utf8");
    writeFileSync(`${fixture.backup.path}.pending`, "{}\n", "utf8");
    writeFileSync(`${pruned.path}.delete-pending`, "{}\n", "utf8");
    fixture.manager.registry.sqlite
      .prepare("DELETE FROM backup_catalog WHERE id = ?")
      .run(pruned.id);
    closeTracked(fixture.manager);

    const reopened = await AyanamiDatabaseManager.open({
      dataDir: fixture.dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    managers.push(reopened);
    expect(existsSync(orphanPath)).toBe(false);
    expect(existsSync(`${orphanPath}.manifest.json`)).toBe(false);
    expect(existsSync(`${orphanPath}.pending`)).toBe(false);
    expect(existsSync(`${orphanPath}.tmp-wal`)).toBe(false);
    expect(existsSync(fixture.backup.path)).toBe(true);
    expect(existsSync(`${fixture.backup.path}.manifest.json`)).toBe(true);
    expect(existsSync(`${fixture.backup.path}.pending`)).toBe(false);
    expect(existsSync(pruned.path)).toBe(false);
    expect(existsSync(`${pruned.path}.manifest.json`)).toBe(false);
    expect(existsSync(`${pruned.path}.delete-pending`)).toBe(false);
  });

  it("rolls the file swap back when backup.restored Registry commit fails", async () => {
    const { manager, project, backup } = await restoreFixture("BRFAIL");
    manager.registry.sqlite.exec(`
      CREATE TRIGGER fail_backup_restored_event
      BEFORE INSERT ON global_events
      WHEN NEW.type = 'backup.restored'
      BEGIN
        SELECT RAISE(ABORT, 'injected restore commit failure');
      END;
    `);

    await expect(manager.restoreBackup(backup.id)).rejects.toThrow(
      "injected restore commit failure",
    );
    const current = await manager.openProject(project.id);
    expect(description(current)).toBe("latest");
    expect(manager.getProject(project.id).lifecycle).toBe("ACTIVE");
    expect(
      readdirSync(dirname(project.databasePath)).filter((name) => name.includes("restore-old")),
    ).toEqual([]);
    expect(existsSync(join(dirname(dirname(project.databasePath)), `.restore-${backup.id}`))).toBe(
      false,
    );
  });

  it("commits a valid restore while persisting a hard projection rejection for repair", async () => {
    const { manager, project, backup } = await restoreFixture("BPROJ");
    manager.registry.sqlite
      .prepare("DELETE FROM project_projection_state WHERE project_id = ?")
      .run(project.id);
    const createBackup = vi.spyOn(manager, "createBackup");
    const dispatchError = `injected post-restore dispatch rejection ${"x".repeat(2_100)}`;
    const dispatch = vi
      .spyOn(manager, "dispatchProject")
      .mockRejectedValueOnce(new Error(dispatchError));

    await expect(manager.restoreBackup(backup.id)).resolves.toMatchObject({
      backup: { id: backup.id },
      project: { id: project.id, lifecycle: "ACTIVE" },
    });
    expect(description(await manager.openProject(project.id))).toBe("snapshot");
    const deferred = manager.projectionState(project.id);
    expect(deferred).toMatchObject({
      status: "DEFERRED",
      retryScheduled: true,
    });
    expect(deferred.lastError).toHaveLength(2_000);
    expect(deferred.lastError).toBe(dispatchError.slice(0, 2_000));
    expect(deferred.retryCount).toBe(1);
    expect(createBackup).toHaveBeenCalledWith({
      scope: "PROJECT",
      project: project.id,
      reason: "PRE_RESTORE",
    });

    dispatch.mockRestore();
    await expect(manager.repairSummaries()).resolves.toMatchObject({ recoveredProjects: 1 });
    expect(manager.projectionState(project.id)).toMatchObject({ status: "APPLIED", lag: 0 });
  });
});

describe("Startup restore crash recovery", () => {
  it("recovers an interruption before the first rename", async () => {
    const fixture = await restoreFixture("RBFR");
    const restoreDirectory = join(
      dirname(dirname(fixture.project.databasePath)),
      `.restore-${fixture.backup.id}`,
    );
    mkdirSync(restoreDirectory, { recursive: true });
    copyFileSync(fixture.backup.path, join(restoreDirectory, "project.sqlite"));
    fixture.manager.registry.sqlite
      .prepare("UPDATE projects SET lifecycle = 'RESTORING' WHERE id = ?")
      .run(fixture.project.id);
    closeTracked(fixture.manager);

    const reopened = await AyanamiDatabaseManager.open({
      dataDir: fixture.dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    managers.push(reopened);
    expect(description(await reopened.openProject(fixture.project.id))).toBe("latest");
    expect(reopened.getProject(fixture.project.id).lifecycle).toBe("ACTIVE");
    expect(existsSync(restoreDirectory)).toBe(false);
  });

  it("restores the old database when interrupted between the two renames", async () => {
    const fixture = await restoreFixture("RBET");
    const restoreDirectory = join(
      dirname(dirname(fixture.project.databasePath)),
      `.restore-${fixture.backup.id}`,
    );
    const rollbackPath = `${fixture.project.databasePath}.restore-old-${fixture.backup.id}`;
    mkdirSync(restoreDirectory, { recursive: true });
    copyFileSync(fixture.backup.path, join(restoreDirectory, "project.sqlite"));
    fixture.manager.registry.sqlite
      .prepare("UPDATE projects SET lifecycle = 'RESTORING' WHERE id = ?")
      .run(fixture.project.id);
    closeTracked(fixture.manager);
    renameSync(fixture.project.databasePath, rollbackPath);

    const reopened = await AyanamiDatabaseManager.open({
      dataDir: fixture.dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    managers.push(reopened);
    expect(description(await reopened.openProject(fixture.project.id))).toBe("latest");
    expect(reopened.getProject(fixture.project.id).lifecycle).toBe("ACTIVE");
    expect(existsSync(rollbackPath)).toBe(false);
    expect(existsSync(restoreDirectory)).toBe(false);
  });

  it("keeps the restored current DB when Registry ACTIVE committed before rollback cleanup", async () => {
    const fixture = await restoreFixture("RACT");
    const restoreDirectory = join(
      dirname(dirname(fixture.project.databasePath)),
      `.restore-${fixture.backup.id}`,
    );
    const candidatePath = join(restoreDirectory, "project.sqlite");
    const rollbackPath = `${fixture.project.databasePath}.restore-old-${fixture.backup.id}`;
    mkdirSync(restoreDirectory, { recursive: true });
    copyFileSync(fixture.backup.path, candidatePath);
    closeTracked(fixture.manager);
    renameSync(fixture.project.databasePath, rollbackPath);
    renameSync(candidatePath, fixture.project.databasePath);

    const reopened = await AyanamiDatabaseManager.open({
      dataDir: fixture.dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    managers.push(reopened);
    expect(description(await reopened.openProject(fixture.project.id))).toBe("snapshot");
    expect(reopened.getProject(fixture.project.id).lifecycle).toBe("ACTIVE");
    expect(existsSync(rollbackPath)).toBe(false);
    expect(existsSync(restoreDirectory)).toBe(false);
  });
});

function forbiddenFacadeImports(source: string): string[] {
  return [...source.matchAll(/from\s+["']\.\/(?:index|manager|project-repository)\.js["']/gu)].map(
    (match) => match[0],
  );
}

function sqlHeavyBudgetViolations(
  files: Array<{ path: string; source: string }>,
  maximum = 1_000,
): string[] {
  return files.flatMap((file) => {
    const classified =
      /(?:commands|read-model|dispatcher|maintenance|recovery|database-pool|projection-source)\.ts$/u.test(
        file.path,
      ) && /\b(?:prepare|transaction|sqlite)\b/u.test(file.source);
    const lines = file.source.split(/\r?\n/u).length;
    return classified && lines > maximum ? [`${file.path}: ${lines} lines exceeds ${maximum}`] : [];
  });
}

describe("Manager maintenance architecture guards", () => {
  it("keeps facade prototypes/private seams and rejects reverse imports with a positive fixture", () => {
    for (const method of [
      "openProject",
      "closeIdleProjects",
      "listBackups",
      "createBackup",
      "runMaintenance",
      "restoreBackup",
      "close",
    ]) {
      expect(
        Object.getOwnPropertyDescriptor(AyanamiDatabaseManager.prototype, method)?.value,
      ).toEqual(expect.any(Function));
    }
    const managerSource = readFileSync(
      resolve(process.cwd(), "packages/storage-sqlite/src/manager.ts"),
      "utf8",
    );
    for (const seam of [
      "recoverCreatingProjects",
      "cleanupInterruptedFiles",
      "recoverProjectSessions",
      "pruneBackupRetention",
      "closeProject",
    ]) {
      expect(managerSource).toMatch(new RegExp(`private ${seam}\\(`, "u"));
    }
    for (const file of [
      "project-database-pool.ts",
      "startup-recovery.ts",
      "backup-maintenance.ts",
      "storage-file-operations.ts",
    ]) {
      const source = readFileSync(
        resolve(process.cwd(), "packages/storage-sqlite/src", file),
        "utf8",
      );
      expect(forbiddenFacadeImports(source)).toEqual([]);
    }
    expect(
      forbiddenFacadeImports('import { AyanamiDatabaseManager } from "./manager.js";'),
    ).toHaveLength(1);
    expect(
      forbiddenFacadeImports('import { ProjectRepository } from "./project-repository.js";'),
    ).toHaveLength(1);
  });

  it("enforces the SQL-heavy 1000-line budget and proves the guard can fail", () => {
    const directory = resolve(process.cwd(), "packages/storage-sqlite/src");
    const files = readdirSync(directory)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => ({ path: name, source: readFileSync(join(directory, name), "utf8") }));
    expect(sqlHeavyBudgetViolations(files)).toEqual([]);
    const oversized = `const sqlite = { prepare() {} };\n${"// line\n".repeat(1_000)}`;
    expect(
      sqlHeavyBudgetViolations([{ path: "oversized-commands.ts", source: oversized }]),
    ).toEqual(["oversized-commands.ts: 1002 lines exceeds 1000"]);
  });
});
