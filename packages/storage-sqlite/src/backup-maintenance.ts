import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { asAtmError, AtmError } from "@ayanami-task/errors";
import { createUlid, nowIso } from "@ayanami-task/protocol";
import { openManagedDatabase, quickCheck, type ManagedDatabase } from "./database.js";
import {
  markProjectionDeferred,
  projectionErrorMessage,
  type ProjectionDispatchResult,
} from "./registry-projection-dispatcher.js";
import { removeSqliteSidecars, renameWithRetry, sha256File } from "./storage-file-operations.js";

export type BackupView = {
  id: string;
  scope: "REGISTRY" | "PROJECT";
  projectId: string | null;
  projectCode: string | null;
  path: string;
  sha256: string;
  sizeBytes: number;
  reason: string;
  schemaVersion: number;
  createdAt: string;
  verifiedAt: string | null;
};

export type BackupProject = {
  id: string;
  code: string;
  name: string;
  description: string;
  databasePath: string;
  lifecycle: string;
  coordinationMode: string;
  sourcePaths: string[];
  version: number;
};

export type CreateBackupInput = {
  scope: "REGISTRY" | "PROJECT";
  project?: string;
  reason:
    | "MANUAL"
    | "DAILY"
    | "WEEKLY"
    | "PRE_MIGRATION"
    | "PRE_ARCHIVE"
    | "PRE_TRASH"
    | "PRE_RESTORE"
    | "EXPORT";
  createdAt?: string;
};

export type MaintenanceResult = {
  skipped: boolean;
  dailyCreated: number;
  weeklyCreated: number;
  recoveredProjects: number;
  errors: Array<{ scope: string; project: string | null; message: string }>;
};

function backupFromRow(row: any): BackupView {
  return {
    id: row.id,
    scope: row.scope,
    projectId: row.project_id,
    projectCode: row.project_code ?? null,
    path: row.path,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    reason: row.reason,
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
  };
}

export class BackupMaintenance {
  readonly #dataDir: string;
  readonly #migrationsRoot: string;
  readonly #registry: ManagedDatabase;
  readonly #getProject: (codeOrId: string) => BackupProject;
  readonly #openProject: (codeOrId: string) => Promise<ManagedDatabase>;
  readonly #closeIdleProjects: (maxIdleMs: number, at: number) => number;
  readonly #closeProject: (projectId: string) => void;
  readonly #getSetting: (key: string, fallback: unknown) => { value: any };
  readonly #listProjects: () => BackupProject[];
  readonly #listBackups: (projectCodeOrId?: string) => BackupView[];
  readonly #createBackup: (input: CreateBackupInput) => Promise<BackupView>;
  readonly #pruneBackupRetention: (projectId: string | null, reason: string) => void;
  readonly #repairSummaries: () => Promise<{
    recoveredProjects: number;
    errors: Array<{ scope: string; project: string | null; message: string }>;
  }>;
  readonly #dispatchProject: (projectId: string) => Promise<ProjectionDispatchResult>;
  readonly #appendGlobalEvent: (
    type: string,
    aggregateId: string,
    actor: string,
    payload: unknown,
  ) => number;

  constructor(input: {
    dataDir: string;
    migrationsRoot: string;
    registry: ManagedDatabase;
    getProject: (codeOrId: string) => BackupProject;
    openProject: (codeOrId: string) => Promise<ManagedDatabase>;
    closeIdleProjects: (maxIdleMs: number, at: number) => number;
    closeProject: (projectId: string) => void;
    getSetting: (key: string, fallback: unknown) => { value: any };
    listProjects: () => BackupProject[];
    listBackups: (projectCodeOrId?: string) => BackupView[];
    createBackup: (input: CreateBackupInput) => Promise<BackupView>;
    pruneBackupRetention: (projectId: string | null, reason: string) => void;
    repairSummaries: () => Promise<{
      recoveredProjects: number;
      errors: Array<{ scope: string; project: string | null; message: string }>;
    }>;
    dispatchProject: (projectId: string) => Promise<ProjectionDispatchResult>;
    appendGlobalEvent: (
      type: string,
      aggregateId: string,
      actor: string,
      payload: unknown,
    ) => number;
  }) {
    this.#dataDir = input.dataDir;
    this.#migrationsRoot = input.migrationsRoot;
    this.#registry = input.registry;
    this.#getProject = input.getProject;
    this.#openProject = input.openProject;
    this.#closeIdleProjects = input.closeIdleProjects;
    this.#closeProject = input.closeProject;
    this.#getSetting = input.getSetting;
    this.#listProjects = input.listProjects;
    this.#listBackups = input.listBackups;
    this.#createBackup = input.createBackup;
    this.#pruneBackupRetention = input.pruneBackupRetention;
    this.#repairSummaries = input.repairSummaries;
    this.#dispatchProject = input.dispatchProject;
    this.#appendGlobalEvent = input.appendGlobalEvent;
  }

  listBackups(projectCodeOrId?: string): BackupView[] {
    const projectId = projectCodeOrId ? this.#getProject(projectCodeOrId).id : null;
    const rows = this.#registry.sqlite
      .prepare(
        `SELECT backup_catalog.*, projects.code AS project_code
         FROM backup_catalog
         LEFT JOIN projects ON projects.id = backup_catalog.project_id
         ${projectId ? "WHERE backup_catalog.project_id = ?" : ""}
         ORDER BY backup_catalog.created_at DESC`,
      )
      .all(...(projectId ? [projectId] : [])) as any[];
    return rows.map(backupFromRow);
  }

  async createBackup(input: CreateBackupInput): Promise<BackupView> {
    const project = input.scope === "PROJECT" ? this.#getProject(input.project ?? "") : null;
    if (input.scope === "PROJECT" && !project) {
      throw new AtmError("PROJECT_REQUIRED", { message: "项目备份必须指定项目" });
    }
    const id = createUlid();
    const createdAt = input.createdAt ?? nowIso();
    const stamp = createdAt.replace(/[:.]/gu, "-");
    const directory = project
      ? join(dirname(project.databasePath), "backups")
      : join(this.#dataDir, "backups", "registry");
    mkdirSync(directory, { recursive: true });
    const prefix = project?.code ?? "registry";
    const finalPath = join(
      directory,
      `${prefix}-${input.reason.toLowerCase()}-${stamp}-${id}.sqlite`,
    );
    const temporaryPath = `${finalPath}.tmp`;
    const manifestPath = `${finalPath}.manifest.json`;
    const pendingPath = `${finalPath}.pending`;
    rmSync(temporaryPath, { force: true });
    const database = project ? await this.#openProject(project.id) : this.#registry;
    let createdBackup: BackupView | null = null;
    try {
      writeFileSync(pendingPath, `${JSON.stringify({ id, finalPath })}\n`, "utf8");
      await database.sqlite.backup(temporaryPath);
      const snapshot = new Database(temporaryPath, { readonly: true, fileMustExist: true });
      const healthy = quickCheck(snapshot);
      snapshot.close();
      removeSqliteSidecars(temporaryPath);
      if (!healthy) {
        throw new AtmError("BACKUP_INTEGRITY_FAILED", { message: "备份完整性检查失败" });
      }
      await renameWithRetry(temporaryPath, finalPath);
      const sha256 = sha256File(finalPath);
      const sizeBytes = statSync(finalPath).size;
      const verifiedAt = nowIso();
      const manifest = {
        format: 1,
        id,
        scope: input.scope,
        projectId: project?.id ?? null,
        projectCode: project?.code ?? null,
        reason: input.reason,
        schemaVersion: database.schemaVersion,
        sha256,
        sizeBytes,
        createdAt,
        verifiedAt,
      };
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      createdBackup = {
        id,
        scope: input.scope,
        projectId: project?.id ?? null,
        projectCode: project?.code ?? null,
        path: finalPath,
        sha256,
        sizeBytes,
        reason: input.reason,
        schemaVersion: database.schemaVersion,
        createdAt,
        verifiedAt,
      };
      this.#registry.sqlite.transaction(() => {
        this.#registry.sqlite
          .prepare(
            `INSERT INTO backup_catalog(
               id, scope, project_id, path, sha256, size_bytes, reason,
               schema_version, created_at, verified_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.scope,
            project?.id ?? null,
            finalPath,
            sha256,
            sizeBytes,
            input.reason,
            database.schemaVersion,
            createdAt,
            verifiedAt,
          );
        this.#appendGlobalEvent("backup.created", id, "SYSTEM", {
          scope: input.scope,
          projectId: project?.id ?? null,
          reason: input.reason,
        });
      })();
    } catch (error) {
      const typed = asAtmError(error);
      rmSync(temporaryPath, { force: true });
      removeSqliteSidecars(temporaryPath);
      rmSync(finalPath, { force: true });
      rmSync(manifestPath, { force: true });
      rmSync(pendingPath, { force: true });
      try {
        this.#registry.sqlite.transaction(() => {
          this.#appendGlobalEvent("backup.failed", id, "SYSTEM", {
            scope: input.scope,
            projectId: project?.id ?? null,
            reason: input.reason,
            code: typed.code,
          });
        })();
      } catch {
        // Preserve the original backup failure when Registry diagnostics are unavailable.
      }
      throw error;
    }

    // Catalog + event is the durable commit point. Cleanup and retention after it are
    // maintenance and must not turn a valid registered backup into a false failure.
    try {
      rmSync(pendingPath, { force: true });
    } catch {
      // Startup recovery removes committed pending markers without touching their artifacts.
    }
    try {
      this.#pruneBackupRetention(project?.id ?? null, input.reason);
    } catch (error) {
      try {
        this.#appendGlobalEvent("backup.retention_failed", id, "SYSTEM", {
          scope: input.scope,
          projectId: project?.id ?? null,
          reason: input.reason,
          code: asAtmError(error).code,
        });
      } catch {
        // The valid backup and committed catalog row remain the source of truth.
      }
    }
    try {
      return this.#listBackups().find((candidate) => candidate.id === id) ?? createdBackup!;
    } catch {
      return createdBackup!;
    }
  }

  pruneBackupRetention(projectId: string | null, reason: string): void {
    const policy = this.#getSetting("backup.policy", { dailyKeep: 7, weeklyKeep: 4 }).value as {
      dailyKeep?: number;
      weeklyKeep?: number;
    };
    const keep =
      reason === "DAILY"
        ? Math.min(90, Math.max(1, Number(policy?.dailyKeep ?? 7)))
        : reason === "WEEKLY"
          ? Math.min(52, Math.max(1, Number(policy?.weeklyKeep ?? 4)))
          : null;
    if (!keep) return;
    const rows = this.#registry.sqlite
      .prepare(
        `SELECT id, path FROM backup_catalog
         WHERE scope = ? AND project_id IS ? AND reason = ?
         ORDER BY created_at DESC`,
      )
      .all(projectId ? "PROJECT" : "REGISTRY", projectId, reason) as Array<{
      id: string;
      path: string;
    }>;
    for (const row of rows.slice(keep)) {
      const deletionMarker = `${row.path}.delete-pending`;
      writeFileSync(deletionMarker, `${JSON.stringify({ id: row.id, path: row.path })}\n`, "utf8");
      // Registry deletion is the commit point: startup uses the marker to finish file cleanup,
      // while a crash before this delete keeps the still-cataloged backup intact.
      this.#registry.sqlite.prepare("DELETE FROM backup_catalog WHERE id = ?").run(row.id);
      rmSync(row.path, { force: true });
      rmSync(`${row.path}.manifest.json`, { force: true });
      rmSync(`${row.path}.pending`, { force: true });
      rmSync(deletionMarker, { force: true });
    }
  }

  async runMaintenance(at = new Date()): Promise<MaintenanceResult> {
    this.#closeIdleProjects(5 * 60_000, at.valueOf());
    const repair = await this.#repairSummaries();
    const policy = this.#getSetting("backup.policy", { enabled: true }).value as {
      enabled?: boolean;
    };
    if (policy?.enabled === false) {
      return {
        skipped: true,
        dailyCreated: 0,
        weeklyCreated: 0,
        recoveredProjects: repair.recoveredProjects,
        errors: repair.errors,
      };
    }
    const day = at.toISOString().slice(0, 10);
    const targets = [
      { scope: "REGISTRY" as const, project: null as BackupProject | null },
      ...this.#listProjects()
        .filter((project) => project.lifecycle === "ACTIVE")
        .map((project) => ({ scope: "PROJECT" as const, project })),
    ];
    let dailyCreated = 0;
    let weeklyCreated = 0;
    const errors = [...repair.errors];
    const hasOnDay = (scope: "REGISTRY" | "PROJECT", projectId: string | null, reason: string) =>
      Boolean(
        this.#registry.sqlite
          .prepare(
            `SELECT 1 FROM backup_catalog WHERE scope = ? AND project_id IS ?
             AND reason = ? AND substr(created_at, 1, 10) = ? LIMIT 1`,
          )
          .get(scope, projectId, reason, day),
      );
    const needsWeekly = (scope: "REGISTRY" | "PROJECT", projectId: string | null) => {
      const row = this.#registry.sqlite
        .prepare(
          "SELECT created_at FROM backup_catalog WHERE scope = ? AND project_id IS ? AND reason = 'WEEKLY' ORDER BY created_at DESC LIMIT 1",
        )
        .get(scope, projectId) as { created_at: string } | undefined;
      return !row || at.valueOf() - Date.parse(row.created_at) >= 7 * 24 * 60 * 60 * 1000;
    };
    for (const target of targets) {
      try {
        if (!hasOnDay(target.scope, target.project?.id ?? null, "DAILY")) {
          await this.#createBackup({
            scope: target.scope,
            ...(target.project ? { project: target.project.id } : {}),
            reason: "DAILY",
            createdAt: at.toISOString(),
          });
          dailyCreated += 1;
        }
        if (needsWeekly(target.scope, target.project?.id ?? null)) {
          await this.#createBackup({
            scope: target.scope,
            ...(target.project ? { project: target.project.id } : {}),
            reason: "WEEKLY",
            createdAt: at.toISOString(),
          });
          weeklyCreated += 1;
        }
      } catch (error) {
        errors.push({
          scope: target.scope,
          project: target.project?.code ?? null,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      skipped: false,
      dailyCreated,
      weeklyCreated,
      recoveredProjects: repair.recoveredProjects,
      errors,
    };
  }

  async restoreBackup(backupId: string): Promise<{ backup: BackupView; project: BackupProject }> {
    const row = this.#registry.sqlite
      .prepare(
        `SELECT backup_catalog.*, projects.code AS project_code
         FROM backup_catalog LEFT JOIN projects ON projects.id = backup_catalog.project_id
         WHERE backup_catalog.id = ?`,
      )
      .get(backupId) as any;
    if (!row) {
      throw new AtmError("BACKUP_NOT_FOUND", {
        message: `备份不存在：${backupId}`,
        details: { reference: backupId },
      });
    }
    const backup = backupFromRow(row);
    if (backup.scope !== "PROJECT" || !backup.projectId) {
      throw new AtmError("BACKUP_RESTORE_SCOPE_UNSUPPORTED", {
        message: "该备份范围不支持恢复",
      });
    }
    if (!existsSync(backup.path)) {
      throw new AtmError("BACKUP_FILE_MISSING", { message: "备份文件不存在" });
    }
    if (sha256File(backup.path) !== backup.sha256) {
      throw new AtmError("BACKUP_HASH_MISMATCH", { message: "备份文件哈希不匹配" });
    }
    const manifestPath = `${backup.path}.manifest.json`;
    if (!existsSync(manifestPath)) {
      throw new AtmError("BACKUP_MANIFEST_MISSING", { message: "备份清单不存在" });
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      id?: string;
      projectId?: string;
      sha256?: string;
    };
    if (
      manifest.id !== backup.id ||
      manifest.projectId !== backup.projectId ||
      manifest.sha256 !== backup.sha256
    ) {
      throw new AtmError("BACKUP_MANIFEST_MISMATCH", { message: "备份清单不匹配" });
    }

    const project = this.#getProject(backup.projectId);
    const restoreDirectory = join(this.#dataDir, "projects", `.restore-${backup.id}`);
    const candidatePath = join(restoreDirectory, "project.sqlite");
    const rollbackPath = `${project.databasePath}.restore-old-${backup.id}`;
    rmSync(restoreDirectory, { recursive: true, force: true });
    mkdirSync(join(restoreDirectory, "backups"), { recursive: true });
    copyFileSync(backup.path, candidatePath);
    let candidate: ManagedDatabase | null = null;
    let currentRenamed = false;
    let restoreCommitted = false;
    try {
      candidate = await openManagedDatabase({
        path: candidatePath,
        migrationDirectory: join(this.#migrationsRoot, "project"),
        backupDirectory: join(restoreDirectory, "backups"),
      });
      const identity = candidate.sqlite
        .prepare("SELECT project_id, project_code FROM project_meta WHERE singleton = 1")
        .get() as { project_id: string; project_code: string } | undefined;
      if (
        !identity ||
        identity.project_id !== project.id ||
        identity.project_code !== project.code
      ) {
        throw new AtmError("BACKUP_PROJECT_IDENTITY_MISMATCH", {
          message: "备份项目身份不匹配",
        });
      }
      if (!quickCheck(candidate.sqlite)) {
        throw new AtmError("BACKUP_INTEGRITY_FAILED", { message: "备份完整性检查失败" });
      }
      candidate.sqlite.pragma("wal_checkpoint(TRUNCATE)");
      candidate.sqlite.close();
      candidate = null;

      await this.#createBackup({ scope: "PROJECT", project: project.id, reason: "PRE_RESTORE" });
      this.#registry.sqlite
        .prepare("UPDATE projects SET lifecycle = 'RESTORING', updated_at = ? WHERE id = ?")
        .run(nowIso(), project.id);
      this.#closeProject(project.id);

      rmSync(rollbackPath, { force: true });
      for (const suffix of ["-wal", "-shm"]) {
        rmSync(`${project.databasePath}${suffix}`, { force: true });
      }
      await renameWithRetry(project.databasePath, rollbackPath);
      currentRenamed = true;
      await renameWithRetry(candidatePath, project.databasePath);
      this.#registry.sqlite.transaction(() => {
        this.#registry.sqlite
          .prepare(
            "UPDATE projects SET lifecycle = 'ACTIVE', version = version + 1, updated_at = ? WHERE id = ?",
          )
          .run(nowIso(), project.id);
        this.#appendGlobalEvent("backup.restored", backup.id, "USER", {
          projectId: project.id,
          projectCode: project.code,
        });
      })();
      restoreCommitted = true;

      try {
        await this.#dispatchProject(project.id);
      } catch (error) {
        markProjectionDeferred(this.#registry, project.id, projectionErrorMessage(error));
      }
      try {
        rmSync(rollbackPath, { force: true });
      } catch {
        // Registry ACTIVE is already committed; startup recovery safely removes this rollback.
      }
      return { backup, project: this.#getProject(project.id) };
    } catch (error) {
      if (!restoreCommitted) {
        this.#closeProject(project.id);
        if (currentRenamed && existsSync(rollbackPath)) {
          rmSync(project.databasePath, { force: true });
          await renameWithRetry(rollbackPath, project.databasePath);
        }
        this.#registry.sqlite
          .prepare("UPDATE projects SET lifecycle = 'ACTIVE', updated_at = ? WHERE id = ?")
          .run(nowIso(), project.id);
      }
      throw error;
    } finally {
      if (candidate?.sqlite.open) candidate.sqlite.close();
      try {
        rmSync(restoreDirectory, { recursive: true, force: true });
      } catch {
        // Startup recovery removes stale restore candidates without changing a committed result.
      }
    }
  }
}
