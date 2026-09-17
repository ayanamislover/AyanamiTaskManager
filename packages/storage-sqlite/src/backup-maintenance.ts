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
import {
  openManagedDatabase,
  quickCheck,
  foreignKeyCheck,
  type ManagedDatabase,
} from "./database.js";
import type { KnowledgeDatabase } from "./knowledge-database.js";
import {
  markProjectionDeferred,
  projectionErrorMessage,
  type ProjectionDispatchResult,
} from "./registry-projection-dispatcher.js";
import {
  BACKUP_RETENTION_DEFAULTS,
  backupKeepCount,
  pruneMigrationBackupFiles,
  type BackupPolicy,
} from "./backup-retention.js";
import { removeSqliteSidecars, renameWithRetry, sha256File } from "./storage-file-operations.js";

import type {
  BackupView,
  BackupProject,
  CreateBackupInput,
  MaintenanceResult,
} from "./backup-contracts.js";
export type {
  BackupView,
  BackupProject,
  CreateBackupInput,
  MaintenanceResult,
} from "./backup-contracts.js";

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
  #maintenanceInFlight: Promise<MaintenanceResult> | null = null;
  readonly #dataDir: string;
  readonly #migrationsRoot: string;
  readonly #registry: ManagedDatabase;
  readonly #knowledge: KnowledgeDatabase;
  readonly #getProject: (codeOrId: string) => BackupProject;
  readonly #openProject: (codeOrId: string) => Promise<ManagedDatabase>;
  readonly #closeIdleProjects: (maxIdleMs: number, at: number) => number;
  readonly #closeProject: (projectId: string) => void;
  readonly #getSetting: (key: string, fallback: unknown) => { value: any };
  readonly #listProjects: () => BackupProject[];
  readonly #listBackups: (projectCodeOrId?: string) => BackupView[];
  readonly #createBackup: (input: CreateBackupInput) => Promise<BackupView>;
  readonly #pruneBackupRetention: (
    projectId: string | null,
    reason: string,
    scope?: BackupView["scope"],
  ) => void;
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
    knowledge: KnowledgeDatabase;
    getProject: (codeOrId: string) => BackupProject;
    openProject: (codeOrId: string) => Promise<ManagedDatabase>;
    closeIdleProjects: (maxIdleMs: number, at: number) => number;
    closeProject: (projectId: string) => void;
    getSetting: (key: string, fallback: unknown) => { value: any };
    listProjects: () => BackupProject[];
    listBackups: (projectCodeOrId?: string) => BackupView[];
    createBackup: (input: CreateBackupInput) => Promise<BackupView>;
    pruneBackupRetention: (
      projectId: string | null,
      reason: string,
      scope?: BackupView["scope"],
    ) => void;
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
    this.#knowledge = input.knowledge;
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
    if (!["PROJECT", "REGISTRY", "KNOWLEDGE"].includes(input.scope))
      throw new AtmError("INVALID_ARGUMENT");
    const project = input.scope === "PROJECT" ? this.#getProject(input.project ?? "") : null;
    if (input.scope === "PROJECT" && !project) {
      throw new AtmError("PROJECT_REQUIRED", { message: "项目备份必须指定项目" });
    }
    const id = createUlid();
    const createdAt = input.createdAt ?? nowIso();
    const stamp = createdAt.replace(/[:.]/gu, "-");
    const directory = project
      ? join(dirname(project.databasePath), "backups")
      : join(this.#dataDir, "backups", input.scope === "KNOWLEDGE" ? "knowledge" : "registry");
    mkdirSync(directory, { recursive: true });
    const prefix = project?.code ?? input.scope.toLowerCase();
    const finalPath = join(
      directory,
      `${prefix}-${input.reason.toLowerCase()}-${stamp}-${id}.sqlite`,
    );
    const temporaryPath = `${finalPath}.tmp`;
    const manifestPath = `${finalPath}.manifest.json`;
    const pendingPath = `${finalPath}.pending`;
    rmSync(temporaryPath, { force: true });
    const database = project
      ? await this.#openProject(project.id)
      : input.scope === "KNOWLEDGE"
        ? (await this.#knowledge.open()).database
        : this.#registry;
    let createdBackup: BackupView | null = null;
    try {
      writeFileSync(pendingPath, `${JSON.stringify({ id, finalPath })}\n`, "utf8");
      await database.sqlite.backup(temporaryPath);
      const snapshot = new Database(temporaryPath, { readonly: true, fileMustExist: true });
      let healthy: boolean;
      try {
        healthy =
          quickCheck(snapshot) && (input.scope !== "KNOWLEDGE" || foreignKeyCheck(snapshot));
      } finally {
        snapshot.close();
      }
      removeSqliteSidecars(temporaryPath);
      if (!healthy) {
        throw new AtmError("BACKUP_INTEGRITY_FAILED", { message: "备份完整性检查失败" });
      }
      await renameWithRetry(temporaryPath, finalPath);
      const sha256 = sha256File(finalPath);
      const reusable = this.#reusableBackup(input, project?.id ?? null, sha256);
      if (reusable) {
        // 内容和上一份一模一样：删掉新快照，把旧的重新盖上今天的时间戳。
        // 空闲项目以前每天都留一份字节完全相同的副本。
        rmSync(finalPath, { force: true });
        rmSync(pendingPath, { force: true });
        this.#registry.sqlite
          .prepare("UPDATE backup_catalog SET created_at = ?, verified_at = ? WHERE id = ?")
          .run(createdAt, nowIso(), reusable.id);
        return this.#listBackups().find((candidate) => candidate.id === reusable.id) ?? reusable;
      }
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
      this.#pruneBackupRetention(project?.id ?? null, input.reason, input.scope);
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

  /** 按保留策略删掉同一范围/项目/原因下多余的备份，返回删除份数。 */
  /** 自动备份（每日/每周）若与同类上一份字节一致，直接沿用旧文件，不再多存一份。 */
  #reusableBackup(
    input: CreateBackupInput,
    projectId: string | null,
    sha256: string,
  ): BackupView | null {
    if (input.reason !== "DAILY" && input.reason !== "WEEKLY") return null;
    const row = this.#registry.sqlite
      .prepare(
        `SELECT backup_catalog.*, projects.code AS project_code
         FROM backup_catalog LEFT JOIN projects ON projects.id = backup_catalog.project_id
         WHERE backup_catalog.scope = ? AND backup_catalog.project_id IS ?
           AND backup_catalog.reason = ? AND backup_catalog.sha256 = ?
         ORDER BY backup_catalog.created_at DESC LIMIT 1`,
      )
      .get(input.scope, projectId, input.reason, sha256) as any;
    if (!row) return null;
    const backup = backupFromRow(row);
    // 旧文件被手工删掉时不能沿用，否则目录表会指向不存在的备份。
    return existsSync(backup.path) ? backup : null;
  }

  pruneBackupRetention(
    projectId: string | null,
    reason: string,
    scope: BackupView["scope"] = projectId ? "PROJECT" : "REGISTRY",
  ): number {
    // 手动与 PRE_* 备份以前没有上限，一直堆到用户投诉「为什么有这么多份」。
    const keep = backupKeepCount(
      this.#getSetting("backup.policy", BACKUP_RETENTION_DEFAULTS).value as BackupPolicy,
      reason,
    );
    const rows = this.#registry.sqlite
      .prepare(
        `SELECT id, path FROM backup_catalog
         WHERE scope = ? AND project_id IS ? AND reason = ?
         ORDER BY created_at DESC`,
      )
      .all(scope, projectId, reason) as Array<{
      id: string;
      path: string;
    }>;
    let removed = 0;
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
      removed += 1;
    }
    return removed;
  }

  /**
   * 历史遗留的备份一并按当前策略收敛：保留策略以前只在「刚建了同类备份」时才跑，
   * 所以调小保留数或从没再建过同类备份的项目，旧文件会一直留着。
   */
  pruneAllRetention(): number {
    const groups = this.#registry.sqlite
      .prepare(
        "SELECT scope, project_id, reason FROM backup_catalog GROUP BY scope, project_id, reason",
      )
      .all() as Array<{ scope: BackupView["scope"]; project_id: string | null; reason: string }>;
    let removed = 0;
    for (const group of groups) {
      try {
        removed += this.pruneBackupRetention(group.project_id, group.reason, group.scope);
      } catch {
        // 单个分组清不掉不影响其他分组，也不该让整次维护失败。
      }
    }
    for (const directory of this.#backupDirectories()) {
      removed += pruneMigrationBackupFiles(directory);
    }
    return removed;
  }

  /** 所有可能存放备份的目录：注册表、知识库和每个项目各一个。 */
  #backupDirectories(): string[] {
    const directories = [
      join(this.#dataDir, "backups", "registry"),
      join(this.#dataDir, "backups", "knowledge"),
    ];
    for (const project of this.#listProjects()) {
      directories.push(join(dirname(project.databasePath), "backups"));
    }
    return directories;
  }

  async runMaintenance(at = new Date()): Promise<MaintenanceResult> {
    if (this.#maintenanceInFlight) return this.#maintenanceInFlight;
    const pending = this.performMaintenance(at);
    this.#maintenanceInFlight = pending;
    try {
      return await pending;
    } finally {
      if (this.#maintenanceInFlight === pending) this.#maintenanceInFlight = null;
    }
  }

  private async performMaintenance(at: Date): Promise<MaintenanceResult> {
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
        reusedBackups: 0,
        prunedBackups: 0,
        recoveredProjects: repair.recoveredProjects,
        errors: repair.errors,
      };
    }
    const day = at.toISOString().slice(0, 10);
    const targets = [
      { scope: "REGISTRY" as const, project: null as BackupProject | null },
      ...(existsSync(this.#knowledge.path) ? [{ scope: "KNOWLEDGE" as const, project: null }] : []),
      ...this.#listProjects()
        .filter((project) => project.lifecycle === "ACTIVE")
        .map((project) => ({ scope: "PROJECT" as const, project })),
    ];
    let dailyCreated = 0;
    let weeklyCreated = 0;
    let reusedBackups = 0;
    const errors = [...repair.errors];
    // 沿用旧备份时目录表里仍是那一行，靠 id 有没有变来区分「新建」和「沿用」。
    const latestBackupId = (scope: BackupView["scope"], projectId: string | null, reason: string) =>
      (
        this.#registry.sqlite
          .prepare(
            `SELECT id FROM backup_catalog WHERE scope = ? AND project_id IS ? AND reason = ?
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(scope, projectId, reason) as { id: string } | undefined
      )?.id ?? null;
    const hasOnDay = (scope: BackupView["scope"], projectId: string | null, reason: string) =>
      Boolean(
        this.#registry.sqlite
          .prepare(
            `SELECT 1 FROM backup_catalog WHERE scope = ? AND project_id IS ?
             AND reason = ? AND substr(created_at, 1, 10) = ? LIMIT 1`,
          )
          .get(scope, projectId, reason, day),
      );
    const needsWeekly = (scope: BackupView["scope"], projectId: string | null) => {
      const row = this.#registry.sqlite
        .prepare(
          "SELECT created_at FROM backup_catalog WHERE scope = ? AND project_id IS ? AND reason = 'WEEKLY' ORDER BY created_at DESC LIMIT 1",
        )
        .get(scope, projectId) as { created_at: string } | undefined;
      return !row || at.valueOf() - Date.parse(row.created_at) >= 7 * 24 * 60 * 60 * 1000;
    };
    for (const target of targets) {
      try {
        const projectId = target.project?.id ?? null;
        if (!hasOnDay(target.scope, projectId, "DAILY")) {
          const previous = latestBackupId(target.scope, projectId, "DAILY");
          const backup = await this.#createBackup({
            scope: target.scope,
            ...(target.project ? { project: target.project.id } : {}),
            reason: "DAILY",
            createdAt: at.toISOString(),
          });
          if (backup.id === previous) reusedBackups += 1;
          else dailyCreated += 1;
        }
        if (needsWeekly(target.scope, projectId)) {
          const previous = latestBackupId(target.scope, projectId, "WEEKLY");
          const backup = await this.#createBackup({
            scope: target.scope,
            ...(target.project ? { project: target.project.id } : {}),
            reason: "WEEKLY",
            createdAt: at.toISOString(),
          });
          if (backup.id === previous) reusedBackups += 1;
          else weeklyCreated += 1;
        }
      } catch (error) {
        errors.push({
          scope: target.scope,
          project: target.project?.code ?? null,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    let prunedBackups = 0;
    try {
      prunedBackups = this.pruneAllRetention();
    } catch (error) {
      errors.push({
        scope: "BACKUP_RETENTION",
        project: null,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return {
      skipped: false,
      dailyCreated,
      weeklyCreated,
      reusedBackups,
      prunedBackups,
      recoveredProjects: repair.recoveredProjects,
      errors,
    };
  }

  async restoreBackup(
    backupId: string,
  ): Promise<{ backup: BackupView; project: BackupProject | null }> {
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
    if ((backup.scope !== "PROJECT" || !backup.projectId) && backup.scope !== "KNOWLEDGE") {
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
      scope?: string;
    };
    if (
      manifest.id !== backup.id ||
      manifest.projectId !== backup.projectId ||
      manifest.sha256 !== backup.sha256 ||
      manifest.scope !== backup.scope
    ) {
      throw new AtmError("BACKUP_MANIFEST_MISMATCH", { message: "备份清单不匹配" });
    }

    if (backup.scope === "KNOWLEDGE") {
      try {
        await this.#createBackup({ scope: "KNOWLEDGE", reason: "PRE_RESTORE" });
      } catch (error) {
        // Corrupt sources cannot produce a SQLite backup. restoreFrom retains their
        // exact original file as a recovery artifact instead of destroying it.
        if (!(error instanceof AtmError) || error.code !== "KNOWLEDGE_UNAVAILABLE") throw error;
      }
      await this.#knowledge.restoreFrom(backup.path);
      try {
        this.#appendGlobalEvent("backup.restored", backup.id, "USER", { scope: "KNOWLEDGE" });
      } catch {
        /* The knowledge commit is durable even when the Registry event is unavailable. */
      }
      return { backup, project: null };
    }
    const project = this.#getProject(backup.projectId!);
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
