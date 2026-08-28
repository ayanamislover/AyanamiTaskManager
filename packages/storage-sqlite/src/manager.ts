import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { strToU8, zipSync, type Zippable } from "fflate";
import { AtmError } from "@ayanami-task/errors";
import {
  nowIso,
  type ProjectionReceipt,
  type ProjectionFailureView,
  type ProjectionStateView,
  type ProjectionSummary,
  type SearchPage,
} from "@ayanami-task/protocol";
import { openManagedDatabase, type ManagedDatabase } from "./database.js";
import {
  BackupMaintenance,
  type BackupView,
  type CreateBackupInput,
  type MaintenanceResult,
} from "./backup-maintenance.js";
import { ProjectDatabasePool } from "./project-database-pool.js";
import { ProjectRepository } from "./project-repository.js";
import {
  projectionErrorMessage,
  RegistryProjectionDispatcher,
  type ProjectionDispatchResult,
} from "./registry-projection-dispatcher.js";
import { RegistryReadModel } from "./registry-read-model.js";
import {
  RegistryObservability,
  type StoredWorkItemEngineeringMetrics,
} from "./registry-observability.js";
import {
  RegistryWorkspace,
  type QuickTaskView,
  type RegisteredProject,
  type SavedView,
  type SettingView,
} from "./registry-workspace.js";
import { StartupRecovery } from "./startup-recovery.js";
import { sha256File } from "./storage-file-operations.js";

export type {
  QuickTaskView,
  RegisteredProject,
  SavedView,
  SettingView,
} from "./registry-workspace.js";

export type { BackupView, CreateBackupInput, MaintenanceResult } from "./backup-maintenance.js";

export type { StoredWorkItemEngineeringMetrics } from "./registry-observability.js";

export type ProjectExportView = {
  format: "aytproj" | "json" | "csv";
  projectCode: string;
  path: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
};

export type { ProjectionDispatchResult } from "./registry-projection-dispatcher.js";

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function addArtifactFiles(directory: string, root: string, files: Zippable, sums: string[]): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      addArtifactFiles(path, root, files, sums);
      continue;
    }
    if (!entry.isFile()) continue;
    const relativePath = `artifacts/${path
      .slice(root.length)
      .replace(/^[\\/]+/u, "")
      .replaceAll("\\", "/")}`;
    const bytes = readFileSync(path);
    files[relativePath] = new Uint8Array(bytes);
    sums.push(`${createHash("sha256").update(bytes).digest("hex")}  ${relativePath}`);
  }
}

export class AyanamiDatabaseManager {
  readonly dataDir: string;
  readonly migrationsRoot: string;
  readonly registry: ManagedDatabase;
  readonly #backupMaintenance: BackupMaintenance;
  readonly #projectPool: ProjectDatabasePool;
  readonly #projectionDispatcher: RegistryProjectionDispatcher;
  readonly #registryReads: RegistryReadModel;
  readonly #registryObservability: RegistryObservability;
  readonly #registryWorkspace: RegistryWorkspace;
  readonly #startupRecovery: StartupRecovery;

  private constructor(input: {
    dataDir: string;
    migrationsRoot: string;
    registry: ManagedDatabase;
  }) {
    this.dataDir = input.dataDir;
    this.migrationsRoot = input.migrationsRoot;
    this.registry = input.registry;
    this.#registryReads = new RegistryReadModel(input.registry.sqlite);
    this.#registryWorkspace = new RegistryWorkspace({
      dataDir: input.dataDir,
      migrationsRoot: input.migrationsRoot,
      registry: input.registry,
      dependencies: {
        appendGlobalEvent: (type, aggregateId, actor, payload) =>
          this.appendGlobalEvent(type, aggregateId, actor, payload),
        getProject: (codeOrId) => this.getProject(codeOrId),
        identifyProject: (path) => this.identifyProject(path),
        listSavedViews: (projectCodeOrId) => this.listSavedViews(projectCodeOrId),
        getQuickTask: (idOrKey) => this.getQuickTask(idOrKey),
      },
    });
    this.#registryObservability = new RegistryObservability(input.registry, {
      openProject: (codeOrId) => this.openProject(codeOrId),
      getProject: (codeOrId) => this.getProject(codeOrId),
      ensureWorkItemEngineeringBaseline: (projectCode, taskKey, baseline, capturedAt) =>
        this.ensureWorkItemEngineeringBaseline(projectCode, taskKey, baseline, capturedAt),
      workItemEngineeringMetrics: (projectCode, taskKey) =>
        this.workItemEngineeringMetrics(projectCode, taskKey),
      listProjects: (includeArchived) => this.listProjects(includeArchived),
      listProjectionStates: (includeTrashed) => this.listProjectionStates(includeTrashed),
      projectionSummary: (includeTrashed) => this.projectionSummary(includeTrashed),
      projectionFailures: (includeTrashed) => this.projectionFailures(includeTrashed),
    });
    this.#projectPool = new ProjectDatabasePool({
      migrationsRoot: input.migrationsRoot,
      getProject: (codeOrId) => this.getProject(codeOrId),
      markMigrationFailed: (projectId) => {
        this.registry.sqlite
          .prepare(
            "UPDATE projects SET lifecycle = 'MIGRATION_FAILED', updated_at = ? WHERE id = ?",
          )
          .run(nowIso(), projectId);
      },
    });
    this.#projectionDispatcher = new RegistryProjectionDispatcher({
      registry: input.registry,
      getProject: (codeOrId) => this.getProject(codeOrId),
      projectProjection: async (codeOrId) =>
        new ProjectRepository(await this.openProject(codeOrId)),
      appendGlobalEvent: (type, aggregateId, actor, payload, dedupeKey) =>
        this.appendGlobalEvent(type, aggregateId, actor, payload, dedupeKey),
      projectionReceipt: (projectId, sourceSequence, retryScheduled, fallbackError) =>
        this.projectionReceipt(projectId, sourceSequence, retryScheduled, fallbackError),
    });
    this.#startupRecovery = new StartupRecovery({
      dataDir: input.dataDir,
      registry: input.registry,
      getSetting: <T>(key: string, fallback: T) => this.getSetting<T>(key, fallback),
      listProjects: () => this.listProjects(),
      recoverStaleSessions: async (projectId, cutoff) => {
        const repository = new ProjectRepository(await this.openProject(projectId));
        repository.recoverStaleSessions(cutoff);
      },
    });
    this.#backupMaintenance = new BackupMaintenance({
      dataDir: input.dataDir,
      migrationsRoot: input.migrationsRoot,
      registry: input.registry,
      getProject: (codeOrId) => this.getProject(codeOrId),
      openProject: (codeOrId) => this.openProject(codeOrId),
      closeIdleProjects: (maxIdleMs, at) => this.closeIdleProjects(maxIdleMs, at),
      closeProject: (projectId) => this.closeProject(projectId),
      getSetting: (key, fallback) => this.getSetting(key, fallback),
      listProjects: () => this.listProjects(),
      listBackups: (codeOrId) =>
        codeOrId === undefined ? this.listBackups() : this.listBackups(codeOrId),
      createBackup: (backupInput) => this.createBackup(backupInput),
      pruneBackupRetention: (projectId, reason) => this.pruneBackupRetention(projectId, reason),
      repairSummaries: () => this.repairSummaries(),
      dispatchProject: (projectId) => this.dispatchProject(projectId),
      appendGlobalEvent: (type, aggregateId, actor, payload) =>
        this.appendGlobalEvent(type, aggregateId, actor, payload),
    });
  }

  static async open(input: {
    dataDir: string;
    migrationsRoot: string;
  }): Promise<AyanamiDatabaseManager> {
    const dataDir = resolve(input.dataDir);
    const migrationsRoot = resolve(input.migrationsRoot);
    for (const relative of [
      "registry",
      "projects",
      "backups/registry",
      "exports",
      "runtime",
      "logs",
      "trash",
    ]) {
      mkdirSync(join(dataDir, relative), { recursive: true });
    }
    const registry = await openManagedDatabase({
      path: join(dataDir, "registry", "registry.sqlite"),
      migrationDirectory: join(migrationsRoot, "registry"),
      backupDirectory: join(dataDir, "backups", "registry"),
    });
    const now = nowIso();
    registry.sqlite
      .prepare(
        `INSERT INTO app_meta(singleton, current_sequence, data_version, created_at, updated_at)
         VALUES (1, 0, 1, ?, ?) ON CONFLICT(singleton) DO NOTHING`,
      )
      .run(now, now);
    const manager = new AyanamiDatabaseManager({ dataDir, migrationsRoot, registry });
    manager.recoverCreatingProjects();
    await manager.cleanupInterruptedFiles();
    await manager.recoverProjectSessions();
    await manager.repairSummaries();
    return manager;
  }

  private appendGlobalEvent(
    type: string,
    aggregateId: string,
    actor: string,
    payload: unknown,
    dedupeKey: string | null = null,
  ): number {
    const supportsDedupe = this.registry.schemaVersion >= 5;
    if (supportsDedupe && dedupeKey) {
      const existing = this.registry.sqlite
        .prepare("SELECT sequence FROM global_events WHERE dedupe_key = ?")
        .get(dedupeKey) as { sequence: number } | undefined;
      if (existing) return existing.sequence;
    }
    const now = nowIso();
    const row = this.registry.sqlite
      .prepare(
        `UPDATE app_meta SET current_sequence = current_sequence + 1, updated_at = ?
         WHERE singleton = 1 RETURNING current_sequence`,
      )
      .get(now) as { current_sequence: number };
    if (supportsDedupe) {
      this.registry.sqlite
        .prepare(
          `INSERT INTO global_events(
             sequence, type, aggregate_id, actor, payload_json, created_at, dedupe_key
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.current_sequence,
          type,
          aggregateId,
          actor,
          JSON.stringify(payload),
          now,
          dedupeKey,
        );
    } else {
      this.registry.sqlite
        .prepare(
          `INSERT INTO global_events(sequence, type, aggregate_id, actor, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(row.current_sequence, type, aggregateId, actor, JSON.stringify(payload), now);
    }
    return row.current_sequence;
  }

  private recoverCreatingProjects(): void {
    this.#startupRecovery.recoverCreatingProjects();
  }

  private cleanupInterruptedFiles(): Promise<void> {
    return this.#startupRecovery.recoverInterruptedFiles();
  }

  private recoverProjectSessions(): Promise<void> {
    return this.#startupRecovery.recoverProjectSessions();
  }

  listProjects(includeArchived = false): RegisteredProject[] {
    return this.#registryReads.listProjects(includeArchived);
  }

  listSavedViews(projectCodeOrId?: string): SavedView[] {
    return this.#registryWorkspace.listSavedViews(projectCodeOrId);
  }

  createSavedView(input: {
    scope: "GLOBAL" | "PROJECT";
    project?: string;
    name: string;
    query: Record<string, unknown>;
    sort: Record<string, unknown>;
  }): SavedView {
    return this.#registryWorkspace.createSavedView(input);
  }

  updateSavedView(
    id: string,
    input: {
      expectedVersion: number;
      name?: string;
      query?: Record<string, unknown>;
      sort?: Record<string, unknown>;
    },
  ): SavedView {
    return this.#registryWorkspace.updateSavedView(id, input);
  }

  deleteSavedView(id: string, expectedVersion: number): { ok: 1; id: string } {
    return this.#registryWorkspace.deleteSavedView(id, expectedVersion);
  }

  listSettings(): SettingView[] {
    return this.#registryWorkspace.listSettings();
  }

  getSetting<T = unknown>(
    key: string,
    fallback?: T,
  ): { key: string; value: T; version: number; updatedAt: string | null } {
    return this.#registryWorkspace.getSetting(key, fallback);
  }

  setSetting(key: string, value: unknown, expectedVersion?: number): SettingView {
    return this.#registryWorkspace.setSetting(key, value, expectedVersion);
  }

  listQuickTasks(status?: string): QuickTaskView[] {
    return this.#registryWorkspace.listQuickTasks(status);
  }

  getQuickTask(idOrKey: string): QuickTaskView {
    return this.#registryWorkspace.getQuickTask(idOrKey);
  }

  createQuickTask(input: {
    title: string;
    note?: string;
    dueDate?: string | null;
    sourceCwd?: string | null;
    actor?: string;
  }): QuickTaskView {
    return this.#registryWorkspace.createQuickTask(input);
  }

  updateQuickTask(
    idOrKey: string,
    input: {
      expectedVersion: number;
      status?: "OPEN" | "IN_PROGRESS" | "BLOCKED" | "DONE" | "CANCELLED";
      title?: string;
      note?: string;
      dueDate?: string | null;
      percent?: number | null;
      summary?: string | null;
      actor?: string;
    },
  ): QuickTaskView {
    return this.#registryWorkspace.updateQuickTask(idOrKey, input);
  }

  markQuickPromoted(
    idOrKey: string,
    expectedVersion: number,
    projectId: string,
    workItemKey: string,
    actor = "SYSTEM",
  ): QuickTaskView {
    return this.#registryWorkspace.markQuickPromoted(
      idOrKey,
      expectedVersion,
      projectId,
      workItemKey,
      actor,
    );
  }

  getProject(codeOrId: string): RegisteredProject {
    return this.#registryReads.getProject(codeOrId);
  }

  attachProjectPath(
    codeOrId: string,
    path: string,
    input: { primary?: boolean; actor?: string } = {},
  ): RegisteredProject {
    return this.#registryWorkspace.attachProjectPath(codeOrId, path, input);
  }

  identifyProject(path: string): RegisteredProject | null {
    return this.#registryWorkspace.identifyProject(path);
  }

  async createProject(input: {
    name: string;
    sourcePath: string | null;
    code?: string;
    description?: string;
    coordinationMode?: "SOLO" | "AUTO" | "MULTI";
    creationReason?: string;
    creationSignals?: Record<string, unknown>;
    actor?: string;
  }): Promise<RegisteredProject> {
    return this.#registryWorkspace.createProject(input);
  }

  async openProject(codeOrId: string): Promise<ManagedDatabase> {
    return this.#projectPool.openProject(codeOrId);
  }

  closeIdleProjects(maxIdleMs = 5 * 60_000, at = Date.now()): number {
    return this.#projectPool.closeIdleProjects(maxIdleMs, at);
  }

  async saveProjectEngineeringMetrics(
    projectCode: string,
    metrics: Record<string, unknown> & { head: string; capturedAt: string },
  ): Promise<Record<string, unknown>> {
    return this.#registryObservability.saveProjectEngineeringMetrics(projectCode, metrics);
  }

  async latestProjectEngineeringMetrics(
    projectCode: string,
  ): Promise<Record<string, unknown> | null> {
    return this.#registryObservability.latestProjectEngineeringMetrics(projectCode);
  }

  async ensureWorkItemEngineeringBaseline(
    projectCode: string,
    taskKey: string,
    baseline: string,
    capturedAt = nowIso(),
  ): Promise<StoredWorkItemEngineeringMetrics> {
    return this.#registryObservability.ensureWorkItemEngineeringBaseline(
      projectCode,
      taskKey,
      baseline,
      capturedAt,
    );
  }

  async saveWorkItemEngineeringMetrics(
    projectCode: string,
    taskKey: string,
    baseline: string,
    metrics: Record<string, unknown> & { capturedAt: string },
  ): Promise<StoredWorkItemEngineeringMetrics> {
    return this.#registryObservability.saveWorkItemEngineeringMetrics(
      projectCode,
      taskKey,
      baseline,
      metrics,
    );
  }

  async workItemEngineeringMetrics(
    projectCode: string,
    taskKey: string,
  ): Promise<StoredWorkItemEngineeringMetrics | null> {
    return this.#registryObservability.workItemEngineeringMetrics(projectCode, taskKey);
  }

  async doctor(): Promise<{
    registry: { ok: boolean; sqliteVersion: string; fts5: boolean; trigram: boolean };
    projectCounts: Record<string, { total: number; failed: number }>;
    projectionSummary: ProjectionSummary;
    projectionFailures: ProjectionFailureView[];
    projects: Array<{
      code: string;
      lifecycle: string;
      ok: boolean;
      quickCheck: boolean;
      foreignKeys: boolean;
      separateDatabase: boolean;
      projection: ProjectionStateView | null;
    }>;
  }> {
    return this.#registryObservability.doctor();
  }

  projectionState(projectCodeOrId: string): ProjectionStateView {
    return this.#registryObservability.projectionState(projectCodeOrId);
  }

  listProjectionStates(includeTrashed = false): ProjectionStateView[] {
    return this.#registryObservability.listProjectionStates(includeTrashed);
  }

  projectionSummary(includeTrashed = false): ProjectionSummary {
    return this.#registryObservability.projectionSummary(includeTrashed);
  }

  projectionFailures(includeTrashed = false): ProjectionFailureView[] {
    return this.#registryObservability.projectionFailures(includeTrashed);
  }

  async dispatchProject(projectCodeOrId: string): Promise<ProjectionDispatchResult> {
    return this.#projectionDispatcher.dispatchProject(projectCodeOrId);
  }

  private projectionReceipt(
    projectId: string,
    sourceSequence: number,
    retryScheduled: boolean,
    fallbackError: string | null,
  ): ProjectionReceipt {
    return this.#projectionDispatcher.projectionReceipt(
      projectId,
      sourceSequence,
      retryScheduled,
      fallbackError,
    );
  }

  async repairSummaries(): Promise<{
    recoveredProjects: number;
    errors: Array<{ scope: string; project: string | null; message: string }>;
  }> {
    let recoveredProjects = 0;
    const errors: Array<{ scope: string; project: string | null; message: string }> = [];
    for (const project of this.listProjects().filter((candidate) =>
      ["ACTIVE", "ARCHIVED"].includes(candidate.lifecycle),
    )) {
      try {
        const result = await this.dispatchProject(project.id);
        if (result.projection.status === "APPLIED") {
          recoveredProjects += 1;
        } else {
          errors.push({
            scope: "PROJECTION",
            project: project.code,
            message: result.projection.lastError ?? "projection deferred",
          });
        }
      } catch (error) {
        errors.push({
          scope: "PROJECTION",
          project: project.code,
          message: projectionErrorMessage(error),
        });
      }
    }
    return { recoveredProjects, errors };
  }

  globalSearch(query: string, limit = 20, cursor?: string): SearchPage {
    return this.#registryObservability.globalSearch(query, limit, cursor);
  }

  overview(): Record<string, unknown> {
    return this.#registryObservability.overview();
  }

  globalDelta(
    sinceSequence: number,
    limit = 50,
  ): {
    events: Array<{
      seq: number;
      type: string;
      key: string | null;
      summary: string;
      actor: string;
      title: string;
      detail: string;
      project: { id: string; code: string; name: string } | null;
      at: string;
    }>;
    nextSequence: number;
    hasMore: boolean;
  } {
    return this.#registryObservability.globalDelta(sinceSequence, limit);
  }

  getImportHistory(projectCodeOrId: string, sourceSha256: string): Record<string, unknown> | null {
    const project = this.getProject(projectCodeOrId);
    const row = this.registry.sqlite
      .prepare(
        "SELECT result_json, imported_at FROM import_history WHERE source_sha256 = ? AND project_id = ?",
      )
      .get(sourceSha256, project.id) as { result_json: string; imported_at: string } | undefined;
    if (!row) return null;
    return {
      ...(JSON.parse(row.result_json) as Record<string, unknown>),
      importedAt: row.imported_at,
    };
  }

  recordImport(
    projectCodeOrId: string,
    sourceSha256: string,
    result: Record<string, unknown>,
  ): void {
    const project = this.getProject(projectCodeOrId);
    this.registry.sqlite.transaction(() => {
      this.registry.sqlite
        .prepare(
          `INSERT INTO import_history(source_sha256, project_id, result_json, imported_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(source_sha256, project_id) DO NOTHING`,
        )
        .run(sourceSha256, project.id, JSON.stringify(result), nowIso());
      this.appendGlobalEvent("import.agenttask.applied", project.id, "USER", {
        sourceSha256,
        ...result,
      });
    })();
  }

  setProjectLifecycle(
    codeOrId: string,
    lifecycle: "ACTIVE" | "ARCHIVED" | "TRASHED",
    actor = "USER",
  ): RegisteredProject {
    const project = this.getProject(codeOrId);
    if (project.lifecycle === lifecycle) return project;
    if (!["ACTIVE", "ARCHIVED", "TRASHED"].includes(project.lifecycle)) {
      throw new AtmError("PROJECT_LIFECYCLE_CONFLICT", {
        message: `项目生命周期不允许该操作：${project.lifecycle}`,
        details: { lifecycle: project.lifecycle },
      });
    }
    this.registry.sqlite.transaction(() => {
      this.registry.sqlite
        .prepare(
          "UPDATE projects SET lifecycle = ?, version = version + 1, updated_at = ? WHERE id = ?",
        )
        .run(lifecycle, nowIso(), project.id);
      this.registry.sqlite
        .prepare(
          "UPDATE project_summary_cache SET lifecycle = ?, updated_at = ? WHERE project_id = ?",
        )
        .run(lifecycle, nowIso(), project.id);
      const eventType =
        lifecycle === "ARCHIVED"
          ? "project.archived"
          : lifecycle === "TRASHED"
            ? "project.trashed"
            : "project.restored";
      this.appendGlobalEvent(eventType, project.id, actor, {
        code: project.code,
      });
    })();
    if (lifecycle === "TRASHED") this.closeProject(project.id);
    return this.getProject(project.id);
  }

  listBackups(projectCodeOrId?: string): BackupView[] {
    return this.#backupMaintenance.listBackups(projectCodeOrId);
  }

  async createBackup(input: CreateBackupInput): Promise<BackupView> {
    return this.#backupMaintenance.createBackup(input);
  }

  private pruneBackupRetention(projectId: string | null, reason: string): void {
    this.#backupMaintenance.pruneBackupRetention(projectId, reason);
  }

  async runMaintenance(at = new Date()): Promise<MaintenanceResult> {
    return this.#backupMaintenance.runMaintenance(at);
  }

  private closeProject(projectId: string): void {
    this.#projectPool.closeProject(projectId);
  }

  async restoreBackup(
    backupId: string,
  ): Promise<{ backup: BackupView; project: RegisteredProject }> {
    return this.#backupMaintenance.restoreBackup(backupId);
  }

  async exportProject(
    projectCodeOrId: string,
    format: "aytproj" | "json" | "csv" = "aytproj",
  ): Promise<ProjectExportView> {
    const project = this.getProject(projectCodeOrId);
    const database = await this.openProject(project.id);
    const createdAt = nowIso();
    const stamp = createdAt.replace(/[:.]/gu, "-");
    const path = join(
      this.dataDir,
      "exports",
      `${project.code}-${stamp}.${format === "aytproj" ? "aytproj" : format}`,
    );
    if (format === "aytproj") {
      const backup = await this.createBackup({
        scope: "PROJECT",
        project: project.id,
        reason: "EXPORT",
      });
      const snapshot = readFileSync(backup.path);
      const sums = [`${backup.sha256}  project.sqlite`];
      const files: Zippable = { "project.sqlite": new Uint8Array(snapshot) };
      addArtifactFiles(
        join(dirname(project.databasePath), "artifacts"),
        join(dirname(project.databasePath), "artifacts"),
        files,
        sums,
      );
      const manifest = {
        format: "ayanami-task-project",
        formatVersion: 1,
        applicationVersion: "1.0.18",
        project: { id: project.id, code: project.code, name: project.name },
        schemaVersion: database.schemaVersion,
        createdAt,
        snapshotSha256: backup.sha256,
      };
      files["manifest.json"] = strToU8(`${JSON.stringify(manifest, null, 2)}\n`);
      files["SHA256SUMS.txt"] = strToU8(`${sums.join("\n")}\n`);
      writeFileSync(path, zipSync(files, { level: 6 }));
    } else if (format === "json") {
      const tables = [
        "project_meta",
        "objectives",
        "milestones",
        "work_items",
        "work_item_relations",
        "checklist_items",
        "blockers",
        "progress_updates",
        "project_updates",
        "records",
        "artifacts",
        "agents",
        "agent_sessions",
        "events",
        "settings",
      ];
      const data = Object.fromEntries(
        tables.map((table) => [table, database.sqlite.prepare(`SELECT * FROM ${table}`).all()]),
      );
      writeFileSync(
        path,
        `${JSON.stringify({ format: 1, project: { id: project.id, code: project.code, name: project.name }, createdAt, data }, null, 2)}\n`,
        "utf8",
      );
    } else {
      const rows = database.sqlite
        .prepare(
          `SELECT meta.project_code AS project_code,
                  meta.project_code || '-T-' || printf('%04d', item.local_no) AS task_key,
                  CASE WHEN parent.local_no IS NULL THEN '' ELSE meta.project_code || '-T-' || printf('%04d', parent.local_no) END AS parent_key,
                  item.type, item.title, item.status, item.priority,
                  COALESCE(item.assignee_agent_id, '') AS assignee,
                  COALESCE(item.target_date, '') AS target_date,
                  item.computed_progress AS progress,
                  COALESCE(item.blocked_reason, '') AS blocker,
                  COALESCE((SELECT summary FROM progress_updates update_row WHERE update_row.work_item_id = item.id ORDER BY created_at DESC LIMIT 1), '') AS latest_update
           FROM work_items item
           CROSS JOIN project_meta meta
           LEFT JOIN work_items parent ON parent.id = item.parent_id
           WHERE item.archived_at IS NULL
           ORDER BY item.local_no`,
        )
        .all() as Array<Record<string, unknown>>;
      const columns = [
        "project_code",
        "task_key",
        "parent_key",
        "type",
        "title",
        "status",
        "priority",
        "assignee",
        "target_date",
        "progress",
        "blocker",
        "latest_update",
      ];
      const csv = [
        columns.join(","),
        ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
      ].join("\r\n");
      writeFileSync(path, `\uFEFF${csv}\r\n`, "utf8");
    }
    return {
      format,
      projectCode: project.code,
      path,
      sha256: sha256File(path),
      sizeBytes: statSync(path).size,
      createdAt,
    };
  }

  close(): void {
    this.#projectPool.closeAll();
    if (this.registry.sqlite.open) {
      this.registry.sqlite.pragma("wal_checkpoint(PASSIVE)");
      this.registry.sqlite.close();
    }
  }
}
