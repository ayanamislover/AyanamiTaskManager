import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { allocateProjectCode } from "@ayanami-task/domain";
import { AtmError } from "@ayanami-task/errors";
import { createUlid, nowIso } from "@ayanami-task/protocol";
import { openManagedDatabase, quickCheck, type ManagedDatabase } from "./database.js";
import { renameWithRetry } from "./storage-file-operations.js";

const SETTING_KEY_PATTERN = /^[a-z0-9][A-Za-z0-9._-]{0,79}$/u;

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

type RegistryWorkspaceDependencies = {
  appendGlobalEvent: (type: string, aggregateId: string, actor: string, payload: unknown) => number;
  getProject: (codeOrId: string) => RegisteredProject;
  identifyProject: (path: string) => RegisteredProject | null;
  listSavedViews: (projectCodeOrId?: string) => SavedView[];
  getQuickTask: (idOrKey: string) => QuickTaskView;
};

export class RegistryWorkspace {
  readonly #dataDir: string;
  readonly #migrationsRoot: string;
  readonly #registry: ManagedDatabase;
  readonly #dependencies: RegistryWorkspaceDependencies;

  constructor(input: {
    dataDir: string;
    migrationsRoot: string;
    registry: ManagedDatabase;
    dependencies: RegistryWorkspaceDependencies;
  }) {
    this.#dataDir = input.dataDir;
    this.#migrationsRoot = input.migrationsRoot;
    this.#registry = input.registry;
    this.#dependencies = input.dependencies;
  }

  listSavedViews(projectCodeOrId?: string): SavedView[] {
    const project = projectCodeOrId ? this.#dependencies.getProject(projectCodeOrId) : null;
    const rows = this.#registry.sqlite
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
    const project =
      input.scope === "PROJECT" ? this.#dependencies.getProject(input.project ?? "") : null;
    if (!input.name.trim())
      throw new AtmError("SAVED_VIEW_NAME_REQUIRED", { message: "保存视图名称不能为空" });
    const id = createUlid();
    const now = nowIso();
    this.#registry.sqlite.transaction(() => {
      this.#registry.sqlite
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
      this.#dependencies.appendGlobalEvent("saved_view.created", id, "USER", {
        projectId: project?.id ?? null,
      });
    })();
    return this.#dependencies.listSavedViews(project?.id).find((view) => view.id === id)!;
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
    const current = this.#dependencies.listSavedViews().find((view) => view.id === id);
    if (!current)
      throw new AtmError("NOT_FOUND", {
        message: `保存视图不存在：${id}`,
        details: { entity: "SAVED_VIEW", reference: id },
      });
    if (current.version !== input.expectedVersion)
      throw new AtmError("VERSION_CONFLICT", {
        message: "保存视图版本已变化",
        details: {
          entity: "SAVED_VIEW",
          key: id,
          expected: input.expectedVersion,
          actual: current.version,
        },
      });
    const name = input.name?.trim() ?? current.name;
    if (!name) throw new AtmError("SAVED_VIEW_NAME_REQUIRED", { message: "保存视图名称不能为空" });
    this.#registry.sqlite.transaction(() => {
      this.#registry.sqlite
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
      this.#dependencies.appendGlobalEvent("saved_view.updated", id, "USER", {
        projectId: current.projectId,
      });
    })();
    return this.#dependencies.listSavedViews().find((view) => view.id === id)!;
  }

  deleteSavedView(id: string, expectedVersion: number): { ok: 1; id: string } {
    const current = this.#dependencies.listSavedViews().find((view) => view.id === id);
    if (!current)
      throw new AtmError("NOT_FOUND", {
        message: `保存视图不存在：${id}`,
        details: { entity: "SAVED_VIEW", reference: id },
      });
    if (current.version !== expectedVersion)
      throw new AtmError("VERSION_CONFLICT", {
        message: "保存视图版本已变化",
        details: {
          entity: "SAVED_VIEW",
          key: id,
          expected: expectedVersion,
          actual: current.version,
        },
      });
    this.#registry.sqlite.transaction(() => {
      this.#registry.sqlite
        .prepare("DELETE FROM saved_views WHERE id = ? AND version = ?")
        .run(id, expectedVersion);
      this.#dependencies.appendGlobalEvent("saved_view.deleted", id, "USER", {
        projectId: current.projectId,
      });
    })();
    return { ok: 1, id };
  }

  listSettings(): SettingView[] {
    return (
      this.#registry.sqlite.prepare("SELECT * FROM settings ORDER BY key").all() as any[]
    ).map((row) => ({
      key: row.key,
      value: JSON.parse(row.value_json),
      version: row.version,
      updatedAt: row.updated_at,
    }));
  }

  getSetting<T = unknown>(
    key: string,
    fallback?: T,
  ): { key: string; value: T; version: number; updatedAt: string | null } {
    const row = this.#registry.sqlite
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
    if (!SETTING_KEY_PATTERN.test(key))
      throw new AtmError("SETTING_KEY_INVALID", {
        message: "设置项 key 无效",
        details: { key },
      });
    const current = this.#registry.sqlite
      .prepare("SELECT version FROM settings WHERE key = ?")
      .get(key) as { version: number } | undefined;
    if (current && expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new AtmError("VERSION_CONFLICT", {
        message: "设置项版本已变化",
        details: { entity: "SETTING", key, expected: expectedVersion, actual: current.version },
      });
    }
    if (!current && expectedVersion !== undefined && expectedVersion !== -1)
      throw new AtmError("VERSION_CONFLICT", {
        message: "设置项尚不存在",
        details: { entity: "SETTING", key, expected: expectedVersion, actual: -1 },
      });
    const now = nowIso();
    this.#registry.sqlite.transaction(() => {
      if (current) {
        this.#registry.sqlite
          .prepare(
            "UPDATE settings SET value_json = ?, version = version + 1, updated_at = ? WHERE key = ?",
          )
          .run(JSON.stringify(value), now, key);
      } else {
        this.#registry.sqlite
          .prepare("INSERT INTO settings(key, value_json, version, updated_at) VALUES (?, ?, 0, ?)")
          .run(key, JSON.stringify(value), now);
      }
      this.#dependencies.appendGlobalEvent("setting.updated", key, "USER", {});
    })();
    return this.getSetting(key) as SettingView;
  }

  listQuickTasks(status?: string): QuickTaskView[] {
    const rows = status
      ? this.#registry.sqlite
          .prepare("SELECT * FROM quick_tasks WHERE status = ? ORDER BY updated_at DESC")
          .all(status)
      : this.#registry.sqlite.prepare("SELECT * FROM quick_tasks ORDER BY updated_at DESC").all();
    return (rows as any[]).map(quickTaskFromRow);
  }

  getQuickTask(idOrKey: string): QuickTaskView {
    const localNo = Number(idOrKey.match(/^Q-(\d+)$/u)?.[1]);
    const row = Number.isSafeInteger(localNo)
      ? this.#registry.sqlite.prepare("SELECT * FROM quick_tasks WHERE local_no = ?").get(localNo)
      : this.#registry.sqlite.prepare("SELECT * FROM quick_tasks WHERE id = ?").get(idOrKey);
    if (!row)
      throw new AtmError("NOT_FOUND", {
        message: `临时任务不存在：${idOrKey}`,
        details: { entity: "QUICK_TASK", reference: idOrKey },
      });
    return quickTaskFromRow(row);
  }

  createQuickTask(input: {
    title: string;
    note?: string;
    dueDate?: string | null;
    sourceCwd?: string | null;
    actor?: string;
  }): QuickTaskView {
    return this.#registry.sqlite.transaction(() => {
      const now = nowIso();
      const localNo = (
        this.#registry.sqlite
          .prepare("SELECT COALESCE(MAX(local_no), 0) + 1 AS value FROM quick_tasks")
          .get() as { value: number }
      ).value;
      const id = createUlid();
      this.#registry.sqlite
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
      this.#dependencies.appendGlobalEvent("quick.created", id, input.actor ?? "USER", {
        localNo,
        title: input.title,
      });
      return this.#dependencies.getQuickTask(id);
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
    return this.#registry.sqlite.transaction(() => {
      const current = this.#dependencies.getQuickTask(idOrKey);
      if (current.version !== input.expectedVersion) {
        throw new AtmError("VERSION_CONFLICT", {
          message: "临时任务版本已变化",
          details: {
            entity: "QUICK_TASK",
            key: current.key,
            expected: input.expectedVersion,
            actual: current.version,
          },
        });
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
      this.#registry.sqlite
        .prepare(`UPDATE quick_tasks SET ${updates.join(", ")} WHERE id = ?`)
        .run(...values);
      if (input.summary?.trim()) {
        this.#registry.sqlite
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
      this.#dependencies.appendGlobalEvent("quick.updated", current.id, input.actor ?? "USER", {
        status: input.status ?? current.status,
      });
      return this.#dependencies.getQuickTask(current.id);
    })();
  }

  markQuickPromoted(
    idOrKey: string,
    expectedVersion: number,
    projectId: string,
    workItemKey: string,
    actor = "SYSTEM",
  ): QuickTaskView {
    return this.#registry.sqlite.transaction(() => {
      const current = this.#dependencies.getQuickTask(idOrKey);
      if (current.status === "PROMOTED") {
        if (
          current.promotedProjectId === projectId &&
          current.promotedWorkItemKey === workItemKey
        ) {
          return current;
        }
        throw new AtmError("IDEMPOTENCY_CONFLICT", {
          message: "临时任务提升目标已变化",
          details: { entity: "QUICK_TASK", key: current.key },
        });
      }
      if (current.version !== expectedVersion)
        throw new AtmError("VERSION_CONFLICT", {
          message: "临时任务版本已变化",
          details: {
            entity: "QUICK_TASK",
            key: current.key,
            expected: expectedVersion,
            actual: current.version,
          },
        });
      this.#registry.sqlite
        .prepare(
          `UPDATE quick_tasks SET status = 'PROMOTED', promoted_project_id = ?,
           promoted_work_item_key = ?, percent = 100, version = version + 1,
           completed_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(projectId, workItemKey, nowIso(), nowIso(), current.id);
      this.#dependencies.appendGlobalEvent("quick.promoted", current.id, actor, {
        projectId,
        workItemKey,
      });
      return this.#dependencies.getQuickTask(current.id);
    })();
  }

  attachProjectPath(
    codeOrId: string,
    path: string,
    input: { primary?: boolean; actor?: string } = {},
  ): RegisteredProject {
    const project = this.#dependencies.getProject(codeOrId);
    const canonical = canonicalPath(path);
    const identified = this.#dependencies.identifyProject(canonical);
    if (identified && identified.id !== project.id) {
      throw new AtmError("PROJECT_PATH_CONFLICT", {
        message: `目录已属于项目：${identified.code}`,
        details: { conflicting_project: identified.code },
      });
    }
    const common = gitValue(canonical, ["rev-parse", "--git-common-dir"]);
    const commonPath = common
      ? canonicalPath(isAbsolute(common) ? common : resolve(canonical, common))
      : null;
    const primary = input.primary ?? project.sourcePaths.length === 0;
    this.#registry.sqlite.transaction(() => {
      if (primary) {
        this.#registry.sqlite
          .prepare("UPDATE project_paths SET is_primary = 0 WHERE project_id = ?")
          .run(project.id);
      }
      this.#registry.sqlite
        .prepare(
          `INSERT INTO project_paths(id, project_id, canonical_path, git_common_dir, is_primary, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(canonical_path) DO UPDATE SET git_common_dir = excluded.git_common_dir,
             is_primary = excluded.is_primary, last_seen_at = excluded.last_seen_at`,
        )
        .run(createUlid(), project.id, canonical, commonPath, primary ? 1 : 0, nowIso());
      this.#registry.sqlite
        .prepare("UPDATE projects SET version = version + 1, updated_at = ? WHERE id = ?")
        .run(nowIso(), project.id);
      this.#dependencies.appendGlobalEvent(
        "project.path.attached",
        project.id,
        input.actor ?? "USER",
        {
          path: canonical,
          primary,
        },
      );
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
    return this.#dependencies.getProject(project.id);
  }

  identifyProject(path: string): RegisteredProject | null {
    const canonical = canonicalPath(path);
    const direct = this.#registry.sqlite
      .prepare(
        `SELECT p.* FROM projects p JOIN project_paths pp ON pp.project_id = p.id
         WHERE pp.canonical_path = ?`,
      )
      .get(canonical) as any;
    if (direct) return this.#dependencies.getProject(direct.id);
    const marker = join(canonical, ".ayanami-task", "project.json");
    if (existsSync(marker)) {
      const identity = JSON.parse(readFileSync(marker, "utf8")) as { project_id?: string };
      if (identity.project_id) {
        const project = this.#dependencies.getProject(identity.project_id);
        const common = gitValue(canonical, ["rev-parse", "--git-common-dir"]);
        const commonPath = common
          ? canonicalPath(isAbsolute(common) ? common : resolve(canonical, common))
          : null;
        this.#registry.sqlite
          .prepare(
            `INSERT INTO project_paths(
               id, project_id, canonical_path, git_common_dir, is_primary, last_seen_at
             ) VALUES (?, ?, ?, ?, 0, ?)
             ON CONFLICT(canonical_path) DO UPDATE SET project_id = excluded.project_id,
               git_common_dir = excluded.git_common_dir, last_seen_at = excluded.last_seen_at`,
          )
          .run(createUlid(), project.id, canonical, commonPath, nowIso());
        return this.#dependencies.getProject(project.id);
      }
    }
    const common = gitValue(canonical, ["rev-parse", "--git-common-dir"]);
    if (!common) return null;
    const commonPath = canonicalPath(isAbsolute(common) ? common : resolve(canonical, common));
    const byCommon = this.#registry.sqlite
      .prepare(
        `SELECT p.* FROM projects p JOIN project_paths pp ON pp.project_id = p.id
         WHERE pp.git_common_dir = ? LIMIT 1`,
      )
      .get(commonPath) as any;
    return byCommon ? this.#dependencies.getProject(byCommon.id) : null;
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
    if (sourcePath && this.#dependencies.identifyProject(sourcePath)) {
      throw new AtmError("PROJECT_ALREADY_EXISTS", {
        message: "该目录已注册为项目",
        details: { source_path: sourcePath },
      });
    }
    const existingCodes = new Set(
      (
        this.#registry.sqlite.prepare("SELECT code FROM projects").all() as Array<{ code: string }>
      ).map((row) => row.code),
    );
    const id = createUlid();
    const requestedCode = input.code?.toUpperCase();
    const code =
      requestedCode ?? allocateProjectCode(input.name, existingCodes, existingCodes.size + 1);
    if (existingCodes.has(code))
      throw new AtmError("PROJECT_CODE_CONFLICT", {
        message: `项目代码已存在：${code}`,
        details: { code },
      });
    const now = nowIso();
    const actor = input.actor ?? "SYSTEM";
    this.#registry.sqlite.transaction(() => {
      this.#registry.sqlite
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
      this.#dependencies.appendGlobalEvent("project.creating", id, actor, { code, sourcePath });
    })();

    const temporaryDirectory = join(this.#dataDir, "projects", `.creating-${id}`);
    const finalDirectory = join(this.#dataDir, "projects", id);
    rmSync(temporaryDirectory, { recursive: true, force: true });
    mkdirSync(join(temporaryDirectory, "artifacts"), { recursive: true });
    mkdirSync(join(temporaryDirectory, "backups"), { recursive: true });
    const temporaryDatabasePath = join(temporaryDirectory, "project.sqlite");
    let projectDatabase: ManagedDatabase | null = null;
    try {
      projectDatabase = await openManagedDatabase({
        path: temporaryDatabasePath,
        migrationDirectory: join(this.#migrationsRoot, "project"),
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
      if (!quickCheck(projectDatabase.sqlite))
        throw new AtmError("PROJECT_DB_QUICK_CHECK_FAILED", {
          message: "项目数据库 quick_check 失败",
        });
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
      this.#registry.sqlite.transaction(() => {
        this.#registry.sqlite
          .prepare(
            `UPDATE projects SET db_path = ?, lifecycle = 'ACTIVE', version = version + 1,
             updated_at = ? WHERE id = ?`,
          )
          .run(databasePath, nowIso(), id);
        if (sourcePath) {
          this.#registry.sqlite
            .prepare(
              `INSERT INTO project_paths(
                 id, project_id, canonical_path, git_common_dir, is_primary, last_seen_at
               ) VALUES (?, ?, ?, ?, 1, ?)`,
            )
            .run(createUlid(), id, sourcePath, gitCommonDir, nowIso());
        }
        this.#registry.sqlite
          .prepare(
            `INSERT INTO project_summary_cache(
               project_id, project_sequence, progress, progress_source, health, lifecycle, updated_at
             ) VALUES (?, 0, 0, 'NONE', 'UNKNOWN', 'ACTIVE', ?)`,
          )
          .run(id, nowIso());
        if (this.#registry.schemaVersion >= 5) {
          this.#registry.sqlite
            .prepare(
              `INSERT INTO project_projection_state(
                 project_id, source_sequence, projected_sequence, status,
                 last_error, retry_count, updated_at
               ) VALUES (?, 0, 0, 'APPLIED', NULL, 0, ?)`,
            )
            .run(id, nowIso());
        }
        this.#dependencies.appendGlobalEvent("project.created", id, actor, {
          code,
          databasePath,
          sourcePath,
        });
      })();
      return this.#dependencies.getProject(id);
    } catch (error) {
      if (projectDatabase?.sqlite.open) projectDatabase.sqlite.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
      this.#registry.sqlite
        .prepare("UPDATE projects SET lifecycle = 'MIGRATION_FAILED', updated_at = ? WHERE id = ?")
        .run(nowIso(), id);
      throw error;
    }
  }
}
