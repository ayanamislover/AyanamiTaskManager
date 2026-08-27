import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { strToU8, zipSync, type Zippable } from "fflate";
import { allocateProjectCode } from "@ayanami-task/domain";
import { createUlid, nowIso } from "@ayanami-task/protocol";
import {
  foreignKeyCheck,
  openManagedDatabase,
  quickCheck,
  sqliteCapabilities,
  type ManagedDatabase,
} from "./database.js";
import {
  presentEvent,
  type EventProjectContext,
  type PresentedEvent,
} from "./event-presentation.js";
import { ProjectRepository } from "./project-repository.js";

const TRANSIENT_RENAME_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);
const SETTING_KEY_PATTERN = /^[a-z0-9][A-Za-z0-9._-]{0,79}$/u;

async function renameWithRetry(source: string, destination: string): Promise<void> {
  const attempts = process.platform === "win32" ? 8 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!TRANSIENT_RENAME_ERRORS.has(code) || attempt === attempts - 1) throw error;
      await delay(25 * 2 ** attempt);
    }
  }
}

export type RegisteredProject = {
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

export type QuickTaskView = {
  id: string;
  key: string;
  title: string;
  note: string;
  status: string;
  dueDate: string | null;
  percent: number | null;
  latestSummary: string | null;
  sourceCwd: string | null;
  version: number;
  updatedAt: string;
  promotedProjectId: string | null;
  promotedWorkItemKey: string | null;
};

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

export type StoredWorkItemEngineeringMetrics = {
  taskKey: string;
  baseline: string;
  baselineCapturedAt: string;
  metrics: Record<string, unknown> | null;
  capturedAt: string | null;
  updatedAt: string;
};

export type ProjectExportView = {
  format: "aytproj" | "json" | "csv";
  projectCode: string;
  path: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
};

export type SavedView = {
  id: string;
  scope: "GLOBAL" | "PROJECT";
  projectId: string | null;
  projectCode: string | null;
  name: string;
  query: Record<string, unknown>;
  sort: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type SettingView = {
  key: string;
  value: unknown;
  version: number;
  updatedAt: string;
};

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  return realpathSync.native(absolute).replace(/[\\/]+$/u, "");
}

function gitValue(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

function projectFromRow(row: any, paths: string[] = []): RegisteredProject {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    databasePath: row.db_path,
    lifecycle: row.lifecycle,
    coordinationMode: row.coordination_mode,
    sourcePaths: paths,
    version: row.version,
  };
}

function quickTaskFromRow(row: any): QuickTaskView {
  return {
    id: row.id,
    key: `Q-${String(row.local_no).padStart(4, "0")}`,
    title: row.title,
    note: row.note,
    status: row.status,
    dueDate: row.due_date,
    percent: row.percent,
    latestSummary: row.latest_summary,
    sourceCwd: row.source_cwd,
    version: row.version,
    updatedAt: row.updated_at,
    promotedProjectId: row.promoted_project_id,
    promotedWorkItemKey: row.promoted_work_item_key,
  };
}

function workItemLocalNo(projectCode: string, taskKey: string): number {
  const prefix = `${projectCode.toUpperCase()}-T-`;
  const normalized = taskKey.toUpperCase();
  const localNo = normalized.startsWith(prefix)
    ? Number(normalized.slice(prefix.length))
    : Number.NaN;
  if (!Number.isInteger(localNo) || localNo <= 0)
    throw new Error(`INVALID_WORK_ITEM_KEY: ${taskKey}`);
  return localNo;
}

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

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

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
  readonly #projects = new Map<string, { database: ManagedDatabase; lastUsed: number }>();
  readonly #maxOpenProjects = 8;

  private constructor(input: {
    dataDir: string;
    migrationsRoot: string;
    registry: ManagedDatabase;
  }) {
    this.dataDir = input.dataDir;
    this.migrationsRoot = input.migrationsRoot;
    this.registry = input.registry;
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
    manager.cleanupInterruptedFiles();
    await manager.recoverProjectSessions();
    await manager.repairSummaries();
    return manager;
  }

  private appendGlobalEvent(
    type: string,
    aggregateId: string,
    actor: string,
    payload: unknown,
  ): number {
    const now = nowIso();
    const row = this.registry.sqlite
      .prepare(
        `UPDATE app_meta SET current_sequence = current_sequence + 1, updated_at = ?
         WHERE singleton = 1 RETURNING current_sequence`,
      )
      .get(now) as { current_sequence: number };
    this.registry.sqlite
      .prepare(
        `INSERT INTO global_events(sequence, type, aggregate_id, actor, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(row.current_sequence, type, aggregateId, actor, JSON.stringify(payload), now);
    return row.current_sequence;
  }

  private projectContextForGlobalEvent(
    payload: Record<string, unknown>,
    aggregateId: string | null,
  ): EventProjectContext | null {
    const projectId =
      typeof payload.projectId === "string"
        ? payload.projectId
        : typeof payload.project_id === "string"
          ? payload.project_id
          : null;
    const row = this.registry.sqlite
      .prepare(
        `SELECT id, code, name FROM projects
         WHERE (? IS NOT NULL AND id = ?) OR (? IS NOT NULL AND code = ?)
            OR (? IS NOT NULL AND id = ?)
         LIMIT 1`,
      )
      .get(projectId, projectId, projectId, projectId, aggregateId, aggregateId) as
      | { id: string; code: string; name: string }
      | undefined;
    return row ?? null;
  }

  private presentGlobalRow(row: {
    sequence: number;
    type: string;
    aggregate_id: string;
    actor: string;
    payload_json: string;
    created_at: string;
  }): PresentedEvent & {
    seq: number;
    sequence: number;
    at: string;
    payload_json: string;
    projectCode: string | null;
    projectName: string | null;
  } {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    const presented = presentEvent({
      type: row.type,
      aggregateId: row.aggregate_id,
      actor: row.actor,
      payload,
      project: this.projectContextForGlobalEvent(payload, row.aggregate_id),
    });
    return {
      ...presented,
      seq: row.sequence,
      sequence: row.sequence,
      at: row.created_at,
      payload_json: row.payload_json,
      projectCode: presented.project?.code ?? null,
      projectName: presented.project?.name ?? null,
    };
  }

  private recoverCreatingProjects(): void {
    const creating = this.registry.sqlite
      .prepare("SELECT * FROM projects WHERE lifecycle = 'CREATING'")
      .all() as any[];
    for (const row of creating) {
      const finalDirectory = join(this.dataDir, "projects", row.id);
      const databasePath = join(finalDirectory, "project.sqlite");
      if (existsSync(databasePath)) {
        try {
          const sqlite = new Database(databasePath, { readonly: true, fileMustExist: true });
          const healthy = quickCheck(sqlite);
          sqlite.close();
          if (healthy) {
            this.registry.sqlite
              .prepare(
                "UPDATE projects SET db_path = ?, lifecycle = 'ACTIVE', updated_at = ? WHERE id = ?",
              )
              .run(databasePath, nowIso(), row.id);
            continue;
          }
        } catch {
          // The deterministic fallback below leaves the code allocated but removes the broken saga.
        }
      }
      for (const name of [`.creating-${row.id}`, `${row.id}.creating`]) {
        rmSync(join(this.dataDir, "projects", name), { recursive: true, force: true });
      }
      this.registry.sqlite
        .prepare("UPDATE projects SET lifecycle = 'TRASHED', updated_at = ? WHERE id = ?")
        .run(nowIso(), row.id);
    }
  }

  private cleanupInterruptedFiles(): void {
    const removeTemporaryFiles = (directory: string): void => {
      if (!existsSync(directory)) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".tmp")) {
          rmSync(join(directory, entry.name), { force: true });
        }
      }
    };
    removeTemporaryFiles(join(this.dataDir, "backups", "registry"));
    removeTemporaryFiles(join(this.dataDir, "exports"));
    const projectsDirectory = join(this.dataDir, "projects");
    for (const entry of readdirSync(projectsDirectory, { withFileTypes: true })) {
      const path = join(projectsDirectory, entry.name);
      if (entry.isDirectory() && entry.name.startsWith(".restore-")) {
        rmSync(path, { recursive: true, force: true });
        continue;
      }
      if (entry.isDirectory() && !entry.name.startsWith("."))
        removeTemporaryFiles(join(path, "backups"));
    }
  }

  private async recoverProjectSessions(): Promise<void> {
    const timeoutSetting = this.getSetting<number>("recovery.sessionTimeoutMinutes", 5);
    const minutes = Math.min(1440, Math.max(1, Number(timeoutSetting.value ?? 5)));
    const cutoff = new Date(Date.now() - minutes * 60_000).toISOString();
    for (const project of this.listProjects().filter(
      (candidate) => candidate.lifecycle === "ACTIVE",
    )) {
      try {
        const repository = new ProjectRepository(await this.openProject(project.id));
        repository.recoverStaleSessions(cutoff);
      } catch {
        // Project isolation is preserved; repairSummaries and doctor surface the failed project.
      }
    }
  }

  listProjects(includeArchived = false): RegisteredProject[] {
    const rows = this.registry.sqlite
      .prepare(
        `SELECT * FROM projects ${includeArchived ? "" : "WHERE lifecycle <> 'TRASHED'"}
         ORDER BY updated_at DESC`,
      )
      .all() as any[];
    const pathQuery = this.registry.sqlite.prepare(
      "SELECT canonical_path FROM project_paths WHERE project_id = ? ORDER BY is_primary DESC, last_seen_at DESC",
    );
    return rows.map((row) =>
      projectFromRow(
        row,
        (pathQuery.all(row.id) as Array<{ canonical_path: string }>).map(
          (path) => path.canonical_path,
        ),
      ),
    );
  }

  listSavedViews(projectCodeOrId?: string): SavedView[] {
    const project = projectCodeOrId ? this.getProject(projectCodeOrId) : null;
    const rows = this.registry.sqlite
      .prepare(
        `SELECT saved_views.*, projects.code AS project_code
         FROM saved_views LEFT JOIN projects ON projects.id = saved_views.project_id
         ${project ? "WHERE saved_views.project_id = ?" : ""}
         ORDER BY saved_views.updated_at DESC`,
      )
      .all(...(project ? [project.id] : [])) as any[];
    return rows.map((row) => ({
      id: row.id,
      scope: row.scope,
      projectId: row.project_id,
      projectCode: row.project_code,
      name: row.name,
      query: JSON.parse(row.query_json),
      sort: JSON.parse(row.sort_json),
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  createSavedView(input: {
    scope: "GLOBAL" | "PROJECT";
    project?: string;
    name: string;
    query: Record<string, unknown>;
    sort: Record<string, unknown>;
  }): SavedView {
    const project = input.scope === "PROJECT" ? this.getProject(input.project ?? "") : null;
    if (!input.name.trim()) throw new Error("SAVED_VIEW_NAME_REQUIRED");
    const id = createUlid();
    const now = nowIso();
    this.registry.sqlite.transaction(() => {
      this.registry.sqlite
        .prepare(
          `INSERT INTO saved_views(
             id, scope, project_id, name, query_json, sort_json, version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          id,
          input.scope,
          project?.id ?? null,
          input.name.trim(),
          JSON.stringify(input.query),
          JSON.stringify(input.sort),
          now,
          now,
        );
      this.appendGlobalEvent("saved_view.created", id, "USER", { projectId: project?.id ?? null });
    })();
    return this.listSavedViews(project?.id).find((view) => view.id === id)!;
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
    const current = this.listSavedViews().find((view) => view.id === id);
    if (!current) throw new Error(`NOT_FOUND: ${id}`);
    if (current.version !== input.expectedVersion)
      throw new Error(`VERSION_CONFLICT: ${current.version}`);
    const name = input.name?.trim() ?? current.name;
    if (!name) throw new Error("SAVED_VIEW_NAME_REQUIRED");
    this.registry.sqlite.transaction(() => {
      this.registry.sqlite
        .prepare(
          `UPDATE saved_views SET name = ?, query_json = ?, sort_json = ?,
           version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
        )
        .run(
          name,
          JSON.stringify(input.query ?? current.query),
          JSON.stringify(input.sort ?? current.sort),
          nowIso(),
          id,
          input.expectedVersion,
        );
      this.appendGlobalEvent("saved_view.updated", id, "USER", { projectId: current.projectId });
    })();
    return this.listSavedViews().find((view) => view.id === id)!;
  }

  deleteSavedView(id: string, expectedVersion: number): { ok: 1; id: string } {
    const current = this.listSavedViews().find((view) => view.id === id);
    if (!current) throw new Error(`NOT_FOUND: ${id}`);
    if (current.version !== expectedVersion)
      throw new Error(`VERSION_CONFLICT: ${current.version}`);
    this.registry.sqlite.transaction(() => {
      this.registry.sqlite
        .prepare("DELETE FROM saved_views WHERE id = ? AND version = ?")
        .run(id, expectedVersion);
      this.appendGlobalEvent("saved_view.deleted", id, "USER", { projectId: current.projectId });
    })();
    return { ok: 1, id };
  }

  listSettings(): SettingView[] {
    return (this.registry.sqlite.prepare("SELECT * FROM settings ORDER BY key").all() as any[]).map(
      (row) => ({
        key: row.key,
        value: JSON.parse(row.value_json),
        version: row.version,
        updatedAt: row.updated_at,
      }),
    );
  }

  getSetting<T = unknown>(
    key: string,
    fallback?: T,
  ): { key: string; value: T; version: number; updatedAt: string | null } {
    const row = this.registry.sqlite
      .prepare("SELECT * FROM settings WHERE key = ?")
      .get(key) as any;
    if (!row) return { key, value: fallback as T, version: -1, updatedAt: null };
    return {
      key: row.key,
      value: JSON.parse(row.value_json) as T,
      version: row.version,
      updatedAt: row.updated_at,
    };
  }

  setSetting(key: string, value: unknown, expectedVersion?: number): SettingView {
    if (!SETTING_KEY_PATTERN.test(key)) throw new Error("SETTING_KEY_INVALID");
    const current = this.registry.sqlite
      .prepare("SELECT version FROM settings WHERE key = ?")
      .get(key) as { version: number } | undefined;
    if (current && expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new Error(`VERSION_CONFLICT: ${current.version}`);
    }
    if (!current && expectedVersion !== undefined && expectedVersion !== -1)
      throw new Error("VERSION_CONFLICT: -1");
    const now = nowIso();
    this.registry.sqlite.transaction(() => {
      if (current) {
        this.registry.sqlite
          .prepare(
            "UPDATE settings SET value_json = ?, version = version + 1, updated_at = ? WHERE key = ?",
          )
          .run(JSON.stringify(value), now, key);
      } else {
        this.registry.sqlite
          .prepare("INSERT INTO settings(key, value_json, version, updated_at) VALUES (?, ?, 0, ?)")
          .run(key, JSON.stringify(value), now);
      }
      this.appendGlobalEvent("setting.updated", key, "USER", {});
    })();
    return this.getSetting(key) as SettingView;
  }

  listQuickTasks(status?: string): QuickTaskView[] {
    const rows = status
      ? this.registry.sqlite
          .prepare("SELECT * FROM quick_tasks WHERE status = ? ORDER BY updated_at DESC")
          .all(status)
      : this.registry.sqlite.prepare("SELECT * FROM quick_tasks ORDER BY updated_at DESC").all();
    return (rows as any[]).map(quickTaskFromRow);
  }

  getQuickTask(idOrKey: string): QuickTaskView {
    const localNo = Number(idOrKey.match(/^Q-(\d+)$/u)?.[1]);
    const row = Number.isSafeInteger(localNo)
      ? this.registry.sqlite.prepare("SELECT * FROM quick_tasks WHERE local_no = ?").get(localNo)
      : this.registry.sqlite.prepare("SELECT * FROM quick_tasks WHERE id = ?").get(idOrKey);
    if (!row) throw new Error(`NOT_FOUND: ${idOrKey}`);
    return quickTaskFromRow(row);
  }

  createQuickTask(input: {
    title: string;
    note?: string;
    dueDate?: string | null;
    sourceCwd?: string | null;
    actor?: string;
  }): QuickTaskView {
    return this.registry.sqlite.transaction(() => {
      const now = nowIso();
      const localNo = (
        this.registry.sqlite
          .prepare("SELECT COALESCE(MAX(local_no), 0) + 1 AS value FROM quick_tasks")
          .get() as { value: number }
      ).value;
      const id = createUlid();
      this.registry.sqlite
        .prepare(
          `INSERT INTO quick_tasks(
             id, local_no, title, note, status, due_date, source_cwd, actor,
             version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'OPEN', ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          id,
          localNo,
          input.title,
          input.note ?? "",
          input.dueDate ?? null,
          input.sourceCwd ?? null,
          input.actor ?? "USER",
          now,
          now,
        );
      this.appendGlobalEvent("quick.created", id, input.actor ?? "USER", {
        localNo,
        title: input.title,
      });
      return this.getQuickTask(id);
    })();
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
    return this.registry.sqlite.transaction(() => {
      const current = this.getQuickTask(idOrKey);
      if (current.version !== input.expectedVersion) {
        throw new Error(`VERSION_CONFLICT: ${current.version}`);
      }
      const updates: string[] = [];
      const values: unknown[] = [];
      for (const [value, column] of [
        [input.status, "status"],
        [input.title, "title"],
        [input.note, "note"],
        [input.dueDate, "due_date"],
        [input.percent, "percent"],
        [input.summary, "latest_summary"],
      ] as const) {
        if (value !== undefined) {
          updates.push(`${column} = ?`);
          values.push(value);
        }
      }
      if (updates.length === 0) return current;
      const now = nowIso();
      updates.push("version = version + 1", "updated_at = ?");
      values.push(now);
      if (input.status === "DONE") {
        updates.push("completed_at = ?", "percent = 100");
        values.push(now);
      }
      values.push(current.id);
      this.registry.sqlite
        .prepare(`UPDATE quick_tasks SET ${updates.join(", ")} WHERE id = ?`)
        .run(...values);
      if (input.summary?.trim()) {
        this.registry.sqlite
          .prepare(
            `INSERT INTO quick_task_updates(id, quick_task_id, summary, percent, actor, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            createUlid(),
            current.id,
            input.summary.trim(),
            input.percent ?? null,
            input.actor ?? "USER",
            now,
          );
      }
      this.appendGlobalEvent("quick.updated", current.id, input.actor ?? "USER", {
        status: input.status ?? current.status,
      });
      return this.getQuickTask(current.id);
    })();
  }

  markQuickPromoted(
    idOrKey: string,
    expectedVersion: number,
    projectId: string,
    workItemKey: string,
    actor = "SYSTEM",
  ): QuickTaskView {
    return this.registry.sqlite.transaction(() => {
      const current = this.getQuickTask(idOrKey);
      if (current.status === "PROMOTED") {
        if (
          current.promotedProjectId === projectId &&
          current.promotedWorkItemKey === workItemKey
        ) {
          return current;
        }
        throw new Error("IDEMPOTENCY_CONFLICT: quick promotion target changed");
      }
      if (current.version !== expectedVersion)
        throw new Error(`VERSION_CONFLICT: ${current.version}`);
      this.registry.sqlite
        .prepare(
          `UPDATE quick_tasks SET status = 'PROMOTED', promoted_project_id = ?,
           promoted_work_item_key = ?, percent = 100, version = version + 1,
           completed_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(projectId, workItemKey, nowIso(), nowIso(), current.id);
      this.appendGlobalEvent("quick.promoted", current.id, actor, { projectId, workItemKey });
      return this.getQuickTask(current.id);
    })();
  }

  getProject(codeOrId: string): RegisteredProject {
    const row = this.registry.sqlite
      .prepare("SELECT * FROM projects WHERE code = ? OR id = ?")
      .get(codeOrId.toUpperCase(), codeOrId) as any;
    if (!row) throw new Error(`PROJECT_NOT_FOUND: ${codeOrId}`);
    const paths = (
      this.registry.sqlite
        .prepare(
          "SELECT canonical_path FROM project_paths WHERE project_id = ? ORDER BY is_primary DESC",
        )
        .all(row.id) as Array<{ canonical_path: string }>
    ).map((path) => path.canonical_path);
    return projectFromRow(row, paths);
  }

  attachProjectPath(
    codeOrId: string,
    path: string,
    input: { primary?: boolean; actor?: string } = {},
  ): RegisteredProject {
    const project = this.getProject(codeOrId);
    const canonical = canonicalPath(path);
    const identified = this.identifyProject(canonical);
    if (identified && identified.id !== project.id) {
      throw new Error(`PROJECT_PATH_CONFLICT: ${identified.code}`);
    }
    const common = gitValue(canonical, ["rev-parse", "--git-common-dir"]);
    const commonPath = common
      ? canonicalPath(isAbsolute(common) ? common : resolve(canonical, common))
      : null;
    const primary = input.primary ?? project.sourcePaths.length === 0;
    this.registry.sqlite.transaction(() => {
      if (primary) {
        this.registry.sqlite
          .prepare("UPDATE project_paths SET is_primary = 0 WHERE project_id = ?")
          .run(project.id);
      }
      this.registry.sqlite
        .prepare(
          `INSERT INTO project_paths(id, project_id, canonical_path, git_common_dir, is_primary, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(canonical_path) DO UPDATE SET git_common_dir = excluded.git_common_dir,
             is_primary = excluded.is_primary, last_seen_at = excluded.last_seen_at`,
        )
        .run(createUlid(), project.id, canonical, commonPath, primary ? 1 : 0, nowIso());
      this.registry.sqlite
        .prepare("UPDATE projects SET version = version + 1, updated_at = ? WHERE id = ?")
        .run(nowIso(), project.id);
      this.appendGlobalEvent("project.path.attached", project.id, input.actor ?? "USER", {
        path: canonical,
        primary,
      });
    })();
    const markerDirectory = join(canonical, ".ayanami-task");
    mkdirSync(markerDirectory, { recursive: true });
    writeFileSync(
      join(markerDirectory, "project.json"),
      `${JSON.stringify({ schema_version: 1, project_id: project.id, project_code: project.code, name: project.name }, null, 2)}\n`,
      "utf8",
    );
    const exclude = gitValue(canonical, ["rev-parse", "--git-path", "info/exclude"]);
    if (exclude) {
      const excludePath = isAbsolute(exclude) ? exclude : resolve(canonical, exclude);
      mkdirSync(dirname(excludePath), { recursive: true });
      const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
      if (!existing.split(/\r?\n/u).includes(".ayanami-task/")) {
        writeFileSync(
          excludePath,
          `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}.ayanami-task/\n`,
          "utf8",
        );
      }
    }
    return this.getProject(project.id);
  }

  identifyProject(path: string): RegisteredProject | null {
    const canonical = canonicalPath(path);
    const direct = this.registry.sqlite
      .prepare(
        `SELECT p.* FROM projects p JOIN project_paths pp ON pp.project_id = p.id
         WHERE pp.canonical_path = ?`,
      )
      .get(canonical) as any;
    if (direct) return this.getProject(direct.id);
    const marker = join(canonical, ".ayanami-task", "project.json");
    if (existsSync(marker)) {
      const identity = JSON.parse(readFileSync(marker, "utf8")) as { project_id?: string };
      if (identity.project_id) {
        const project = this.getProject(identity.project_id);
        const common = gitValue(canonical, ["rev-parse", "--git-common-dir"]);
        const commonPath = common
          ? canonicalPath(isAbsolute(common) ? common : resolve(canonical, common))
          : null;
        this.registry.sqlite
          .prepare(
            `INSERT INTO project_paths(
               id, project_id, canonical_path, git_common_dir, is_primary, last_seen_at
             ) VALUES (?, ?, ?, ?, 0, ?)
             ON CONFLICT(canonical_path) DO UPDATE SET project_id = excluded.project_id,
               git_common_dir = excluded.git_common_dir, last_seen_at = excluded.last_seen_at`,
          )
          .run(createUlid(), project.id, canonical, commonPath, nowIso());
        return this.getProject(project.id);
      }
    }
    const common = gitValue(canonical, ["rev-parse", "--git-common-dir"]);
    if (!common) return null;
    const commonPath = canonicalPath(isAbsolute(common) ? common : resolve(canonical, common));
    const byCommon = this.registry.sqlite
      .prepare(
        `SELECT p.* FROM projects p JOIN project_paths pp ON pp.project_id = p.id
         WHERE pp.git_common_dir = ? LIMIT 1`,
      )
      .get(commonPath) as any;
    return byCommon ? this.getProject(byCommon.id) : null;
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
    const sourcePath = input.sourcePath ? canonicalPath(input.sourcePath) : null;
    if (sourcePath && this.identifyProject(sourcePath)) {
      throw new Error(`PROJECT_ALREADY_EXISTS: ${sourcePath}`);
    }
    const existingCodes = new Set(
      (
        this.registry.sqlite.prepare("SELECT code FROM projects").all() as Array<{ code: string }>
      ).map((row) => row.code),
    );
    const id = createUlid();
    const requestedCode = input.code?.toUpperCase();
    const code =
      requestedCode ?? allocateProjectCode(input.name, existingCodes, existingCodes.size + 1);
    if (existingCodes.has(code)) throw new Error(`PROJECT_CODE_CONFLICT: ${code}`);
    const now = nowIso();
    const actor = input.actor ?? "SYSTEM";
    this.registry.sqlite.transaction(() => {
      this.registry.sqlite
        .prepare(
          `INSERT INTO projects(
             id, code, name, description, lifecycle, coordination_mode, creation_reason,
             creation_signals_json, version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'CREATING', ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          id,
          code,
          input.name,
          input.description ?? "",
          input.coordinationMode ?? "AUTO",
          input.creationReason ?? null,
          JSON.stringify(input.creationSignals ?? {}),
          now,
          now,
        );
      this.appendGlobalEvent("project.creating", id, actor, { code, sourcePath });
    })();

    const temporaryDirectory = join(this.dataDir, "projects", `.creating-${id}`);
    const finalDirectory = join(this.dataDir, "projects", id);
    rmSync(temporaryDirectory, { recursive: true, force: true });
    mkdirSync(join(temporaryDirectory, "artifacts"), { recursive: true });
    mkdirSync(join(temporaryDirectory, "backups"), { recursive: true });
    const temporaryDatabasePath = join(temporaryDirectory, "project.sqlite");
    let projectDatabase: ManagedDatabase | null = null;
    try {
      projectDatabase = await openManagedDatabase({
        path: temporaryDatabasePath,
        migrationDirectory: join(this.migrationsRoot, "project"),
        backupDirectory: join(temporaryDirectory, "backups"),
      });
      projectDatabase.sqlite
        .prepare(
          `INSERT INTO project_meta(
             singleton, project_id, project_code, name, description, lifecycle,
             coordination_mode, health, current_sequence, schema_version, version, created_at, updated_at
           ) VALUES (1, ?, ?, ?, ?, 'ACTIVE', ?, 'UNKNOWN', 0, ?, 0, ?, ?)`,
        )
        .run(
          id,
          code,
          input.name,
          input.description ?? "",
          input.coordinationMode ?? "AUTO",
          projectDatabase.schemaVersion,
          now,
          now,
        );
      const counterInsert = projectDatabase.sqlite.prepare(
        "INSERT INTO counters(name, next_value) VALUES (?, 1)",
      );
      for (const counter of ["objective", "milestone", "work_item", "blocker", "record"]) {
        counterInsert.run(counter);
      }
      if (!quickCheck(projectDatabase.sqlite)) throw new Error("PROJECT_DB_QUICK_CHECK_FAILED");
      projectDatabase.sqlite.pragma("wal_checkpoint(TRUNCATE)");
      projectDatabase.sqlite.close();
      projectDatabase = null;
      await renameWithRetry(temporaryDirectory, finalDirectory);
      const databasePath = join(finalDirectory, "project.sqlite");
      writeFileSync(
        join(finalDirectory, "manifest.json"),
        `${JSON.stringify({ schema_version: 1, project_id: id, project_code: code, name: input.name }, null, 2)}\n`,
        "utf8",
      );
      let gitCommonDir: string | null = null;
      if (sourcePath) {
        const markerDirectory = join(sourcePath, ".ayanami-task");
        mkdirSync(markerDirectory, { recursive: true });
        writeFileSync(
          join(markerDirectory, "project.json"),
          `${JSON.stringify({ schema_version: 1, project_id: id, project_code: code, name: input.name }, null, 2)}\n`,
          "utf8",
        );
        const common = gitValue(sourcePath, ["rev-parse", "--git-common-dir"]);
        gitCommonDir = common
          ? canonicalPath(isAbsolute(common) ? common : resolve(sourcePath, common))
          : null;
        const exclude = gitValue(sourcePath, ["rev-parse", "--git-path", "info/exclude"]);
        if (exclude) {
          const excludePath = isAbsolute(exclude) ? exclude : resolve(sourcePath, exclude);
          mkdirSync(dirname(excludePath), { recursive: true });
          const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
          if (!existing.split(/\r?\n/u).includes(".ayanami-task/")) {
            writeFileSync(
              excludePath,
              `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}.ayanami-task/\n`,
              "utf8",
            );
          }
        }
      }
      this.registry.sqlite.transaction(() => {
        this.registry.sqlite
          .prepare(
            `UPDATE projects SET db_path = ?, lifecycle = 'ACTIVE', version = version + 1,
             updated_at = ? WHERE id = ?`,
          )
          .run(databasePath, nowIso(), id);
        if (sourcePath) {
          this.registry.sqlite
            .prepare(
              `INSERT INTO project_paths(
                 id, project_id, canonical_path, git_common_dir, is_primary, last_seen_at
               ) VALUES (?, ?, ?, ?, 1, ?)`,
            )
            .run(createUlid(), id, sourcePath, gitCommonDir, nowIso());
        }
        this.registry.sqlite
          .prepare(
            `INSERT INTO project_summary_cache(
               project_id, project_sequence, progress, progress_source, health, lifecycle, updated_at
             ) VALUES (?, 0, 0, 'NONE', 'UNKNOWN', 'ACTIVE', ?)`,
          )
          .run(id, nowIso());
        this.appendGlobalEvent("project.created", id, actor, { code, databasePath, sourcePath });
      })();
      return this.getProject(id);
    } catch (error) {
      if (projectDatabase?.sqlite.open) projectDatabase.sqlite.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
      this.registry.sqlite
        .prepare("UPDATE projects SET lifecycle = 'MIGRATION_FAILED', updated_at = ? WHERE id = ?")
        .run(nowIso(), id);
      throw error;
    }
  }

  async openProject(codeOrId: string): Promise<ManagedDatabase> {
    const project = this.getProject(codeOrId);
    if (project.lifecycle !== "ACTIVE" && project.lifecycle !== "ARCHIVED") {
      throw new Error(`PROJECT_DB_UNAVAILABLE: ${project.lifecycle}`);
    }
    const cached = this.#projects.get(project.id);
    if (cached) {
      cached.lastUsed = Date.now();
      return cached.database;
    }
    while (this.#projects.size >= this.#maxOpenProjects) {
      const oldest = [...this.#projects.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!oldest) break;
      oldest[1].database.sqlite.pragma("wal_checkpoint(PASSIVE)");
      oldest[1].database.sqlite.close();
      this.#projects.delete(oldest[0]);
    }
    try {
      const database = await openManagedDatabase({
        path: project.databasePath,
        migrationDirectory: join(this.migrationsRoot, "project"),
        backupDirectory: join(dirname(project.databasePath), "backups"),
      });
      this.#projects.set(project.id, { database, lastUsed: Date.now() });
      return database;
    } catch (error) {
      this.registry.sqlite
        .prepare("UPDATE projects SET lifecycle = 'MIGRATION_FAILED', updated_at = ? WHERE id = ?")
        .run(nowIso(), project.id);
      throw error;
    }
  }

  closeIdleProjects(maxIdleMs = 5 * 60_000, at = Date.now()): number {
    let closed = 0;
    for (const [projectId, cached] of [...this.#projects]) {
      if (at - cached.lastUsed < maxIdleMs) continue;
      this.closeProject(projectId);
      closed += 1;
    }
    return closed;
  }

  async saveProjectEngineeringMetrics(
    projectCode: string,
    metrics: Record<string, unknown> & { head: string; capturedAt: string },
  ): Promise<Record<string, unknown>> {
    const database = await this.openProject(projectCode);
    database.sqlite.transaction(() => {
      database.sqlite
        .prepare(
          `INSERT INTO engineering_project_metrics(id, git_head, captured_at, payload_json)
           VALUES (?, ?, ?, ?)`,
        )
        .run(createUlid(), metrics.head, metrics.capturedAt, JSON.stringify(metrics));
      database.sqlite
        .prepare(
          `DELETE FROM engineering_project_metrics WHERE id IN (
             SELECT id FROM engineering_project_metrics ORDER BY captured_at DESC LIMIT -1 OFFSET 120
           )`,
        )
        .run();
    })();
    return metrics;
  }

  async latestProjectEngineeringMetrics(
    projectCode: string,
  ): Promise<Record<string, unknown> | null> {
    const database = await this.openProject(projectCode);
    const row = database.sqlite
      .prepare(
        "SELECT payload_json FROM engineering_project_metrics ORDER BY captured_at DESC LIMIT 1",
      )
      .get() as { payload_json: string } | undefined;
    return row ? (JSON.parse(row.payload_json) as Record<string, unknown>) : null;
  }

  async ensureWorkItemEngineeringBaseline(
    projectCode: string,
    taskKey: string,
    baseline: string,
    capturedAt = nowIso(),
  ): Promise<StoredWorkItemEngineeringMetrics> {
    const project = this.getProject(projectCode);
    const localNo = workItemLocalNo(project.code, taskKey);
    const database = await this.openProject(projectCode);
    database.sqlite
      .prepare(
        `INSERT INTO engineering_work_item_metrics(
           work_item_id, baseline_ref, baseline_captured_at, payload_json, captured_at, updated_at
         )
         SELECT id, ?, ?, NULL, NULL, ? FROM work_items WHERE local_no = ?
         ON CONFLICT(work_item_id) DO NOTHING`,
      )
      .run(baseline, capturedAt, capturedAt, localNo);
    const result = await this.workItemEngineeringMetrics(projectCode, taskKey);
    if (!result) throw new Error(`WORK_ITEM_NOT_FOUND: ${taskKey}`);
    return result;
  }

  async saveWorkItemEngineeringMetrics(
    projectCode: string,
    taskKey: string,
    baseline: string,
    metrics: Record<string, unknown> & { capturedAt: string },
  ): Promise<StoredWorkItemEngineeringMetrics> {
    const project = this.getProject(projectCode);
    const localNo = workItemLocalNo(project.code, taskKey);
    const database = await this.openProject(projectCode);
    await this.ensureWorkItemEngineeringBaseline(
      projectCode,
      taskKey,
      baseline,
      metrics.capturedAt,
    );
    database.sqlite
      .prepare(
        `UPDATE engineering_work_item_metrics
         SET payload_json = ?, captured_at = ?, updated_at = ?
         WHERE work_item_id = (SELECT id FROM work_items WHERE local_no = ?)`,
      )
      .run(JSON.stringify(metrics), metrics.capturedAt, metrics.capturedAt, localNo);
    return (await this.workItemEngineeringMetrics(projectCode, taskKey))!;
  }

  async workItemEngineeringMetrics(
    projectCode: string,
    taskKey: string,
  ): Promise<StoredWorkItemEngineeringMetrics | null> {
    const project = this.getProject(projectCode);
    const localNo = workItemLocalNo(project.code, taskKey);
    const database = await this.openProject(projectCode);
    const row = database.sqlite
      .prepare(
        `SELECT meta.project_code || '-T-' || printf('%04d', work_items.local_no) AS task_key,
                metrics.baseline_ref, metrics.baseline_captured_at,
                metrics.payload_json, metrics.captured_at, metrics.updated_at
         FROM engineering_work_item_metrics AS metrics
         JOIN work_items ON work_items.id = metrics.work_item_id
         JOIN project_meta AS meta ON meta.singleton = 1
         WHERE work_items.local_no = ?`,
      )
      .get(localNo) as
      | {
          task_key: string;
          baseline_ref: string;
          baseline_captured_at: string;
          payload_json: string | null;
          captured_at: string | null;
          updated_at: string;
        }
      | undefined;
    return row
      ? {
          taskKey: row.task_key,
          baseline: row.baseline_ref,
          baselineCapturedAt: row.baseline_captured_at,
          metrics: row.payload_json
            ? (JSON.parse(row.payload_json) as Record<string, unknown>)
            : null,
          capturedAt: row.captured_at,
          updatedAt: row.updated_at,
        }
      : null;
  }

  async doctor(): Promise<{
    registry: { ok: boolean; sqliteVersion: string; fts5: boolean; trigram: boolean };
    projectCounts: Record<string, { total: number; failed: number }>;
    projects: Array<{
      code: string;
      lifecycle: string;
      ok: boolean;
      quickCheck: boolean;
      foreignKeys: boolean;
      separateDatabase: boolean;
    }>;
  }> {
    const registryCapabilities = sqliteCapabilities(this.registry.sqlite);
    const registry = {
      ok: quickCheck(this.registry.sqlite),
      sqliteVersion: registryCapabilities.version,
      fts5: registryCapabilities.fts5,
      trigram: registryCapabilities.trigram,
    };
    const registryPath = resolve(this.registry.path).toLowerCase();
    const projects = this.listProjects(true).map((project) => {
      let sqlite: Database.Database | null = null;
      try {
        sqlite = new Database(project.databasePath, {
          readonly: true,
          fileMustExist: true,
        });
        const projectQuickCheck = quickCheck(sqlite);
        const projectForeignKeys = foreignKeyCheck(sqlite);
        return {
          code: project.code,
          lifecycle: project.lifecycle,
          ok: projectQuickCheck && projectForeignKeys,
          quickCheck: projectQuickCheck,
          foreignKeys: projectForeignKeys,
          separateDatabase: resolve(project.databasePath).toLowerCase() !== registryPath,
        };
      } catch {
        return {
          code: project.code,
          lifecycle: project.lifecycle,
          ok: false,
          quickCheck: false,
          foreignKeys: false,
          separateDatabase: true,
        };
      } finally {
        sqlite?.close();
      }
    });
    const projectCounts: Record<string, { total: number; failed: number }> = {};
    for (const project of projects) {
      const current = projectCounts[project.lifecycle] ?? { total: 0, failed: 0 };
      current.total += 1;
      if (!project.ok) current.failed += 1;
      projectCounts[project.lifecycle] = current;
    }
    return { registry, projects, projectCounts };
  }

  async dispatchProject(projectCodeOrId: string): Promise<{ delivered: number; sequence: number }> {
    const project = this.getProject(projectCodeOrId);
    const repository = new ProjectRepository(await this.openProject(project.id));
    const pending = repository.pendingOutbox();
    const projection = repository.summaryProjection();
    const cached = this.registry.sqlite
      .prepare("SELECT project_sequence FROM project_summary_cache WHERE project_id = ?")
      .get(project.id) as { project_sequence: number } | undefined;
    if (pending.length === 0 && cached?.project_sequence === projection.projectSequence) {
      return { delivered: 0, sequence: projection.projectSequence };
    }
    const rebuildSearch = !cached || pending.length === 0;
    const documents = rebuildSearch
      ? repository.searchProjection()
      : repository.searchProjectionForChanges(pending);
    this.registry.sqlite.transaction(() => {
      this.registry.sqlite
        .prepare(
          `INSERT INTO project_summary_cache(
             project_id, project_sequence, progress, progress_source, health, lifecycle,
             current_objective, current_milestone, active_count, ready_count, blocked_count,
             waiting_user_count, waiting_agent_count, stale_claim_count, active_agent_count, overdue_count,
             last_project_update_at, last_activity_at, next_target_date, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id) DO UPDATE SET
             project_sequence = excluded.project_sequence,
             progress = excluded.progress,
             progress_source = excluded.progress_source,
             health = excluded.health,
             lifecycle = excluded.lifecycle,
             current_objective = excluded.current_objective,
             current_milestone = excluded.current_milestone,
             active_count = excluded.active_count,
             ready_count = excluded.ready_count,
             blocked_count = excluded.blocked_count,
             waiting_user_count = excluded.waiting_user_count,
             waiting_agent_count = excluded.waiting_agent_count,
             stale_claim_count = excluded.stale_claim_count,
             active_agent_count = excluded.active_agent_count,
             overdue_count = excluded.overdue_count,
             last_project_update_at = excluded.last_project_update_at,
             last_activity_at = excluded.last_activity_at,
             next_target_date = excluded.next_target_date,
             updated_at = excluded.updated_at`,
        )
        .run(
          project.id,
          projection.projectSequence,
          projection.progress,
          projection.progressSource,
          projection.health,
          projection.lifecycle,
          projection.currentObjective,
          projection.currentMilestone,
          projection.activeCount,
          projection.readyCount,
          projection.blockedCount,
          projection.waitingUserCount,
          projection.waitingAgentCount,
          projection.staleClaimCount,
          projection.activeAgentCount,
          projection.overdueCount,
          projection.lastProjectUpdateAt,
          projection.lastActivityAt,
          projection.nextTargetDate,
          nowIso(),
        );
      if (rebuildSearch) {
        this.registry.sqlite
          .prepare("DELETE FROM global_search_documents WHERE project_id = ?")
          .run(project.id);
        this.registry.sqlite
          .prepare("DELETE FROM global_search_documents_fts WHERE project_id = ?")
          .run(project.id);
      }
      const documentInsert = this.registry.sqlite.prepare(
        `INSERT INTO global_search_documents(
           project_id, entity_type, entity_key, title, summary, project_sequence, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id, entity_type, entity_key) DO UPDATE SET
            title = excluded.title, summary = excluded.summary,
            project_sequence = excluded.project_sequence, updated_at = excluded.updated_at`,
      );
      const ftsDelete = this.registry.sqlite.prepare(
        `DELETE FROM global_search_documents_fts
         WHERE project_id = ? AND entity_type = ? AND entity_key = ?`,
      );
      const ftsInsert = this.registry.sqlite.prepare(
        `INSERT INTO global_search_documents_fts(
           project_id, entity_type, entity_key, title, summary
         ) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const document of documents) {
        ftsDelete.run(project.id, document.entity_type, document.entity_key);
        documentInsert.run(
          project.id,
          document.entity_type,
          document.entity_key,
          document.title,
          document.summary,
          projection.projectSequence,
          document.updated_at,
        );
        ftsInsert.run(
          project.id,
          document.entity_type,
          document.entity_key,
          document.title,
          document.summary,
        );
      }
      for (const change of pending) {
        if (!change.eventType) continue;
        this.appendGlobalEvent(change.eventType, change.aggregateId || project.id, change.actor, {
          ...change.eventPayload,
          projectId: project.id,
          projectCode: project.code,
          projectName: project.name,
          projectSequence: change.project_sequence,
          sourceEventId: change.eventId,
          sourceProjectSequence: change.project_sequence,
          sourceAggregateType: change.aggregateType,
          sourceAggregateId: change.aggregateId,
        });
      }
    })();
    repository.markOutboxDelivered(pending.map((item) => item.id));
    return { delivered: pending.length, sequence: projection.projectSequence };
  }

  async repairSummaries(): Promise<void> {
    for (const project of this.listProjects().filter(
      (candidate) => candidate.lifecycle === "ACTIVE",
    )) {
      try {
        await this.dispatchProject(project.id);
      } catch {
        // A failed project remains isolated; doctor and the UI surface its lifecycle separately.
      }
    }
  }

  globalSearch(query: string, limit = 20): Array<Record<string, unknown>> {
    const boundedLimit = Math.min(30, Math.max(1, limit));
    const projectRows = (
      query.length >= 3
        ? this.registry.sqlite
            .prepare(
              `SELECT documents.entity_type, documents.entity_key, documents.title,
                    documents.summary, documents.updated_at, projects.code AS project
             FROM global_search_documents_fts search
             JOIN global_search_documents documents
               ON documents.project_id = search.project_id
              AND documents.entity_type = search.entity_type
              AND documents.entity_key = search.entity_key
             JOIN projects ON projects.id = documents.project_id
             WHERE global_search_documents_fts MATCH ?
             ORDER BY bm25(global_search_documents_fts), documents.updated_at DESC
             LIMIT ?`,
            )
            .all(`"${query.replaceAll('"', '""')}"`, boundedLimit)
        : this.registry.sqlite
            .prepare(
              `SELECT documents.entity_type, documents.entity_key, documents.title,
                    documents.summary, documents.updated_at, projects.code AS project
             FROM global_search_documents documents
             JOIN projects ON projects.id = documents.project_id
             WHERE documents.title LIKE ? ESCAPE '\\' OR documents.summary LIKE ? ESCAPE '\\'
             ORDER BY documents.updated_at DESC LIMIT ?`,
            )
            .all(
              `%${query.replace(/[\\%_]/gu, "\\$&")}%`,
              `%${query.replace(/[\\%_]/gu, "\\$&")}%`,
              boundedLimit,
            )
    ) as Array<Record<string, unknown>>;
    const remaining = Math.max(0, boundedLimit - projectRows.length);
    if (remaining === 0) return projectRows;
    const escaped = `%${query.replace(/[\\%_]/gu, "\\$&")}%`;
    const quickRows = this.registry.sqlite
      .prepare(
        `SELECT 'QUICK_TASK' AS entity_type, 'Q-' || printf('%04d', local_no) AS entity_key,
                title, note AS summary, updated_at, NULL AS project
         FROM quick_tasks WHERE title LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\'
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(escaped, escaped, remaining) as Array<Record<string, unknown>>;
    return [...projectRows, ...quickRows];
  }

  overview(): Record<string, unknown> {
    const projects = this.registry.sqlite
      .prepare(
        `SELECT projects.id, projects.code, projects.name, projects.lifecycle,
                summaries.project_sequence, summaries.progress, summaries.progress_source, summaries.health,
                summaries.current_objective, summaries.current_milestone,
                summaries.active_count, summaries.ready_count, summaries.blocked_count,
                summaries.waiting_user_count, summaries.waiting_agent_count,
                summaries.stale_claim_count, summaries.active_agent_count, summaries.overdue_count,
                summaries.last_project_update_at, summaries.last_activity_at, summaries.next_target_date
         FROM projects
         LEFT JOIN project_summary_cache summaries ON summaries.project_id = projects.id
         WHERE projects.lifecycle <> 'TRASHED'
         ORDER BY COALESCE(summaries.last_activity_at, projects.updated_at) DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    const totals = this.registry.sqlite
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status IN ('OPEN','IN_PROGRESS','BLOCKED') THEN 1 ELSE 0 END) AS open,
                SUM(CASE WHEN status = 'BLOCKED' THEN 1 ELSE 0 END) AS blocked
         FROM quick_tasks`,
      )
      .get() as Record<string, unknown>;
    const sequence = this.registry.sqlite
      .prepare("SELECT current_sequence FROM app_meta WHERE singleton = 1")
      .get() as { current_sequence: number };
    const recentEventRows = this.registry.sqlite
      .prepare(
        `SELECT sequence, type, aggregate_id, actor, payload_json, created_at
         FROM global_events
         WHERE type <> 'project.summary.updated'
         ORDER BY sequence DESC LIMIT 40`,
      )
      .all() as Array<Record<string, unknown>>;
    const recentEvents = recentEventRows.map((row) =>
      this.presentGlobalRow({
        sequence: Number(row.sequence),
        type: String(row.type),
        aggregate_id: String(row.aggregate_id ?? ""),
        actor: String(row.actor ?? "SYSTEM"),
        payload_json: String(row.payload_json ?? "{}"),
        created_at: String(row.created_at),
      }),
    );
    return { sequence: sequence.current_sequence, projects, quick: totals, recentEvents };
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
      project: EventProjectContext | null;
      at: string;
    }>;
    nextSequence: number;
    hasMore: boolean;
  } {
    const bounded = Math.min(100, Math.max(1, limit));
    const rows = this.registry.sqlite
      .prepare(
        `SELECT sequence, type, aggregate_id, actor, payload_json, created_at
         FROM global_events
         WHERE sequence > ? AND type <> 'project.summary.updated'
         ORDER BY sequence LIMIT ?`,
      )
      .all(Math.max(0, sinceSequence), bounded + 1) as any[];
    const page = rows.slice(0, bounded).map((row) => this.presentGlobalRow(row));
    return {
      events: page,
      nextSequence: page.at(-1)?.seq ?? Math.max(0, sinceSequence),
      hasMore: rows.length > bounded,
    };
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
      throw new Error(`PROJECT_LIFECYCLE_CONFLICT: ${project.lifecycle}`);
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
    const projectId = projectCodeOrId ? this.getProject(projectCodeOrId).id : null;
    const rows = this.registry.sqlite
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

  async createBackup(input: {
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
  }): Promise<BackupView> {
    const project = input.scope === "PROJECT" ? this.getProject(input.project ?? "") : null;
    if (input.scope === "PROJECT" && !project) throw new Error("PROJECT_REQUIRED");
    const id = createUlid();
    const createdAt = input.createdAt ?? nowIso();
    const stamp = createdAt.replace(/[:.]/gu, "-");
    const directory = project
      ? join(dirname(project.databasePath), "backups")
      : join(this.dataDir, "backups", "registry");
    mkdirSync(directory, { recursive: true });
    const prefix = project?.code ?? "registry";
    const finalPath = join(
      directory,
      `${prefix}-${input.reason.toLowerCase()}-${stamp}-${id}.sqlite`,
    );
    const temporaryPath = `${finalPath}.tmp`;
    rmSync(temporaryPath, { force: true });
    const database = project ? await this.openProject(project.id) : this.registry;
    try {
      await database.sqlite.backup(temporaryPath);
      const snapshot = new Database(temporaryPath, { readonly: true, fileMustExist: true });
      const healthy = quickCheck(snapshot);
      snapshot.close();
      if (!healthy) throw new Error("BACKUP_INTEGRITY_FAILED");
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
      writeFileSync(`${finalPath}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      this.registry.sqlite.transaction(() => {
        this.registry.sqlite
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
        this.appendGlobalEvent("backup.created", id, "SYSTEM", {
          scope: input.scope,
          projectId: project?.id ?? null,
          reason: input.reason,
        });
      })();
      this.pruneBackupRetention(project?.id ?? null, input.reason);
      return this.listBackups().find((candidate) => candidate.id === id)!;
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      this.registry.sqlite.transaction(() => {
        this.appendGlobalEvent("backup.failed", id, "SYSTEM", {
          scope: input.scope,
          projectId: project?.id ?? null,
          reason: input.reason,
          code: error instanceof Error ? error.message.split(":", 1)[0] : "BACKUP_FAILED",
        });
      })();
      throw error;
    }
  }

  private pruneBackupRetention(projectId: string | null, reason: string): void {
    const policy = this.getSetting<{ dailyKeep?: number; weeklyKeep?: number }>("backup.policy", {
      dailyKeep: 7,
      weeklyKeep: 4,
    }).value;
    const keep =
      reason === "DAILY"
        ? Math.min(90, Math.max(1, Number(policy?.dailyKeep ?? 7)))
        : reason === "WEEKLY"
          ? Math.min(52, Math.max(1, Number(policy?.weeklyKeep ?? 4)))
          : null;
    if (!keep) return;
    const rows = this.registry.sqlite
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
      rmSync(row.path, { force: true });
      rmSync(`${row.path}.manifest.json`, { force: true });
      this.registry.sqlite.prepare("DELETE FROM backup_catalog WHERE id = ?").run(row.id);
    }
  }

  async runMaintenance(at = new Date()): Promise<{
    skipped: boolean;
    dailyCreated: number;
    weeklyCreated: number;
    recoveredProjects: number;
    errors: Array<{ scope: string; project: string | null; message: string }>;
  }> {
    this.closeIdleProjects(5 * 60_000, at.valueOf());
    const policy = this.getSetting<{ enabled?: boolean }>("backup.policy", { enabled: true }).value;
    if (policy?.enabled === false) {
      return { skipped: true, dailyCreated: 0, weeklyCreated: 0, recoveredProjects: 0, errors: [] };
    }
    const day = at.toISOString().slice(0, 10);
    const targets = [
      { scope: "REGISTRY" as const, project: null as RegisteredProject | null },
      ...this.listProjects()
        .filter((project) => project.lifecycle === "ACTIVE")
        .map((project) => ({ scope: "PROJECT" as const, project })),
    ];
    let dailyCreated = 0;
    let weeklyCreated = 0;
    const errors: Array<{ scope: string; project: string | null; message: string }> = [];
    const hasOnDay = (scope: "REGISTRY" | "PROJECT", projectId: string | null, reason: string) =>
      Boolean(
        this.registry.sqlite
          .prepare(
            `SELECT 1 FROM backup_catalog WHERE scope = ? AND project_id IS ?
           AND reason = ? AND substr(created_at, 1, 10) = ? LIMIT 1`,
          )
          .get(scope, projectId, reason, day),
      );
    const needsWeekly = (scope: "REGISTRY" | "PROJECT", projectId: string | null) => {
      const row = this.registry.sqlite
        .prepare(
          "SELECT created_at FROM backup_catalog WHERE scope = ? AND project_id IS ? AND reason = 'WEEKLY' ORDER BY created_at DESC LIMIT 1",
        )
        .get(scope, projectId) as { created_at: string } | undefined;
      return !row || at.valueOf() - Date.parse(row.created_at) >= 7 * 24 * 60 * 60 * 1000;
    };
    for (const target of targets) {
      try {
        if (!hasOnDay(target.scope, target.project?.id ?? null, "DAILY")) {
          await this.createBackup({
            scope: target.scope,
            ...(target.project ? { project: target.project.id } : {}),
            reason: "DAILY",
            createdAt: at.toISOString(),
          });
          dailyCreated += 1;
        }
        if (needsWeekly(target.scope, target.project?.id ?? null)) {
          await this.createBackup({
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
    await this.repairSummaries();
    return {
      skipped: false,
      dailyCreated,
      weeklyCreated,
      recoveredProjects: targets.length - 1,
      errors,
    };
  }

  private closeProject(projectId: string): void {
    const cached = this.#projects.get(projectId);
    if (!cached) return;
    if (cached.database.sqlite.open) {
      cached.database.sqlite.pragma("wal_checkpoint(TRUNCATE)");
      cached.database.sqlite.close();
    }
    this.#projects.delete(projectId);
  }

  async restoreBackup(
    backupId: string,
  ): Promise<{ backup: BackupView; project: RegisteredProject }> {
    const row = this.registry.sqlite
      .prepare(
        `SELECT backup_catalog.*, projects.code AS project_code
         FROM backup_catalog LEFT JOIN projects ON projects.id = backup_catalog.project_id
         WHERE backup_catalog.id = ?`,
      )
      .get(backupId) as any;
    if (!row) throw new Error(`BACKUP_NOT_FOUND: ${backupId}`);
    const backup = backupFromRow(row);
    if (backup.scope !== "PROJECT" || !backup.projectId) {
      throw new Error("BACKUP_RESTORE_SCOPE_UNSUPPORTED");
    }
    if (!existsSync(backup.path)) throw new Error("BACKUP_FILE_MISSING");
    if (sha256File(backup.path) !== backup.sha256) throw new Error("BACKUP_HASH_MISMATCH");
    const manifestPath = `${backup.path}.manifest.json`;
    if (!existsSync(manifestPath)) throw new Error("BACKUP_MANIFEST_MISSING");
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
      throw new Error("BACKUP_MANIFEST_MISMATCH");
    }

    const project = this.getProject(backup.projectId);
    const restoreDirectory = join(this.dataDir, "projects", `.restore-${backup.id}`);
    const candidatePath = join(restoreDirectory, "project.sqlite");
    rmSync(restoreDirectory, { recursive: true, force: true });
    mkdirSync(join(restoreDirectory, "backups"), { recursive: true });
    copyFileSync(backup.path, candidatePath);
    let candidate: ManagedDatabase | null = null;
    try {
      candidate = await openManagedDatabase({
        path: candidatePath,
        migrationDirectory: join(this.migrationsRoot, "project"),
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
        throw new Error("BACKUP_PROJECT_IDENTITY_MISMATCH");
      }
      if (!quickCheck(candidate.sqlite)) throw new Error("BACKUP_INTEGRITY_FAILED");
      candidate.sqlite.pragma("wal_checkpoint(TRUNCATE)");
      candidate.sqlite.close();
      candidate = null;

      await this.createBackup({ scope: "PROJECT", project: project.id, reason: "PRE_RESTORE" });
      this.registry.sqlite
        .prepare("UPDATE projects SET lifecycle = 'RESTORING', updated_at = ? WHERE id = ?")
        .run(nowIso(), project.id);
      this.closeProject(project.id);

      const rollbackPath = `${project.databasePath}.restore-old-${backup.id}`;
      rmSync(rollbackPath, { force: true });
      for (const suffix of ["-wal", "-shm"])
        rmSync(`${project.databasePath}${suffix}`, { force: true });
      await renameWithRetry(project.databasePath, rollbackPath);
      try {
        await renameWithRetry(candidatePath, project.databasePath);
        this.registry.sqlite
          .prepare(
            "UPDATE projects SET lifecycle = 'ACTIVE', version = version + 1, updated_at = ? WHERE id = ?",
          )
          .run(nowIso(), project.id);
        await this.dispatchProject(project.id);
        this.appendGlobalEvent("backup.restored", backup.id, "USER", {
          projectId: project.id,
          projectCode: project.code,
        });
        rmSync(rollbackPath, { force: true });
      } catch (error) {
        this.closeProject(project.id);
        rmSync(project.databasePath, { force: true });
        await renameWithRetry(rollbackPath, project.databasePath);
        this.registry.sqlite
          .prepare("UPDATE projects SET lifecycle = 'ACTIVE', updated_at = ? WHERE id = ?")
          .run(nowIso(), project.id);
        throw error;
      }
      return { backup, project: this.getProject(project.id) };
    } finally {
      if (candidate?.sqlite.open) candidate.sqlite.close();
      rmSync(restoreDirectory, { recursive: true, force: true });
    }
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
        applicationVersion: "1.0.17",
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
    for (const { database } of this.#projects.values()) {
      if (database.sqlite.open) {
        database.sqlite.pragma("wal_checkpoint(PASSIVE)");
        database.sqlite.close();
      }
    }
    this.#projects.clear();
    if (this.registry.sqlite.open) {
      this.registry.sqlite.pragma("wal_checkpoint(PASSIVE)");
      this.registry.sqlite.close();
    }
  }
}
