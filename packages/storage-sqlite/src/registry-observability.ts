import Database from "better-sqlite3";
import { resolve } from "node:path";
import { AtmError } from "@ayanami-task/errors";
import {
  createUlid,
  nowIso,
  type ProjectionFailureView,
  type ProjectionStateView,
  type ProjectionSummary,
  type SearchHit,
  type SearchPage,
} from "@ayanami-task/protocol";
import {
  foreignKeyCheck,
  quickCheck,
  sqliteCapabilities,
  type ManagedDatabase,
} from "./database.js";
import {
  presentEvent,
  type EventProjectContext,
  type PresentedEvent,
} from "./event-presentation.js";
import type { RegisteredProject } from "./registry-workspace.js";
import { decodeSearchCursor, encodeSearchCursor } from "./search-pagination.js";

export type StoredWorkItemEngineeringMetrics = {
  taskKey: string;
  baseline: string;
  baselineCapturedAt: string;
  metrics: Record<string, unknown> | null;
  capturedAt: string | null;
  updatedAt: string;
};

type ProjectionStateRow = {
  project_id: string;
  code: string;
  name: string;
  lifecycle: string;
  source_sequence: number;
  projected_sequence: number;
  status: "APPLIED" | "DEFERRED";
  last_error: string | null;
  retry_count: number;
  updated_at: string;
};

function projectionStateFromRow(row: ProjectionStateRow): ProjectionStateView {
  const sourceSeq = Number(row.source_sequence);
  const projectedSeq = Number(row.projected_sequence);
  return {
    project: {
      id: row.project_id,
      code: row.code,
      name: row.name,
      lifecycle: row.lifecycle,
    },
    status: row.status,
    sourceSeq,
    projectedSeq,
    lag: sourceSeq - projectedSeq,
    retryScheduled: row.status === "DEFERRED",
    lastError: row.last_error?.slice(0, 2_000) ?? null,
    retryCount: Number(row.retry_count),
    updatedAt: row.updated_at,
  };
}

function workItemLocalNo(projectCode: string, taskKey: string): number {
  const prefix = `${projectCode.toUpperCase()}-T-`;
  const normalized = taskKey.toUpperCase();
  const localNo = normalized.startsWith(prefix)
    ? Number(normalized.slice(prefix.length))
    : Number.NaN;
  if (!Number.isInteger(localNo) || localNo <= 0)
    throw new AtmError("INVALID_WORK_ITEM_KEY", {
      message: `WorkItem key 无效：${taskKey}`,
      details: { reference: taskKey },
    });
  return localNo;
}

type RegistryObservabilityDependencies = {
  openProject: (codeOrId: string) => Promise<ManagedDatabase>;
  getProject: (codeOrId: string) => RegisteredProject;
  ensureWorkItemEngineeringBaseline: (
    projectCode: string,
    taskKey: string,
    baseline: string,
    capturedAt?: string,
  ) => Promise<StoredWorkItemEngineeringMetrics>;
  workItemEngineeringMetrics: (
    projectCode: string,
    taskKey: string,
  ) => Promise<StoredWorkItemEngineeringMetrics | null>;
  listProjects: (includeArchived?: boolean) => RegisteredProject[];
  listProjectionStates: (includeTrashed?: boolean) => ProjectionStateView[];
  projectionSummary: (includeTrashed?: boolean) => ProjectionSummary;
  projectionFailures: (includeTrashed?: boolean) => ProjectionFailureView[];
};

export class RegistryObservability {
  readonly #registry: ManagedDatabase;
  readonly #dependencies: RegistryObservabilityDependencies;

  constructor(registry: ManagedDatabase, dependencies: RegistryObservabilityDependencies) {
    this.#registry = registry;
    this.#dependencies = dependencies;
  }

  #projectContextForGlobalEvent(
    payload: Record<string, unknown>,
    aggregateId: string | null,
  ): EventProjectContext | null {
    const projectId =
      typeof payload.projectId === "string"
        ? payload.projectId
        : typeof payload.project_id === "string"
          ? payload.project_id
          : null;
    const row = this.#registry.sqlite
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

  #presentGlobalRow(row: {
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
      project: this.#projectContextForGlobalEvent(payload, row.aggregate_id),
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

  async saveProjectEngineeringMetrics(
    projectCode: string,
    metrics: Record<string, unknown> & { head: string; capturedAt: string },
  ): Promise<Record<string, unknown>> {
    const database = await this.#dependencies.openProject(projectCode);
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
    const database = await this.#dependencies.openProject(projectCode);
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
    const project = this.#dependencies.getProject(projectCode);
    const localNo = workItemLocalNo(project.code, taskKey);
    const database = await this.#dependencies.openProject(projectCode);
    database.sqlite
      .prepare(
        `INSERT INTO engineering_work_item_metrics(
           work_item_id, baseline_ref, baseline_captured_at, payload_json, captured_at, updated_at
         )
         SELECT id, ?, ?, NULL, NULL, ? FROM work_items WHERE local_no = ?
         ON CONFLICT(work_item_id) DO NOTHING`,
      )
      .run(baseline, capturedAt, capturedAt, localNo);
    const result = await this.#dependencies.workItemEngineeringMetrics(projectCode, taskKey);
    if (!result)
      throw new AtmError("WORK_ITEM_NOT_FOUND", {
        message: `WorkItem 不存在：${taskKey}`,
        details: { entity: "WORK_ITEM", reference: taskKey },
      });
    return result;
  }

  async saveWorkItemEngineeringMetrics(
    projectCode: string,
    taskKey: string,
    baseline: string,
    metrics: Record<string, unknown> & { capturedAt: string },
  ): Promise<StoredWorkItemEngineeringMetrics> {
    const project = this.#dependencies.getProject(projectCode);
    const localNo = workItemLocalNo(project.code, taskKey);
    const database = await this.#dependencies.openProject(projectCode);
    await this.#dependencies.ensureWorkItemEngineeringBaseline(
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
    return (await this.#dependencies.workItemEngineeringMetrics(projectCode, taskKey))!;
  }

  async workItemEngineeringMetrics(
    projectCode: string,
    taskKey: string,
  ): Promise<StoredWorkItemEngineeringMetrics | null> {
    const project = this.#dependencies.getProject(projectCode);
    const localNo = workItemLocalNo(project.code, taskKey);
    const database = await this.#dependencies.openProject(projectCode);
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
    const registryCapabilities = sqliteCapabilities(this.#registry.sqlite);
    const registry = {
      ok: quickCheck(this.#registry.sqlite),
      sqliteVersion: registryCapabilities.version,
      fts5: registryCapabilities.fts5,
      trigram: registryCapabilities.trigram,
    };
    const registryPath = resolve(this.#registry.path).toLowerCase();
    const projectionStates = this.#dependencies.listProjectionStates(true);
    const projectionByProject = new Map(
      projectionStates.map((state) => [state.project.id, state] as const),
    );
    const projects = this.#dependencies.listProjects(true).map((project) => {
      let sqlite: Database.Database | null = null;
      try {
        sqlite = new Database(project.databasePath, {
          readonly: true,
          fileMustExist: true,
        });
        const projectQuickCheck = quickCheck(sqlite);
        const projectForeignKeys = foreignKeyCheck(sqlite);
        const lifecycleAvailable = project.lifecycle !== "MIGRATION_FAILED";
        return {
          code: project.code,
          lifecycle: project.lifecycle,
          ok: lifecycleAvailable && projectQuickCheck && projectForeignKeys,
          quickCheck: projectQuickCheck,
          foreignKeys: projectForeignKeys,
          separateDatabase: resolve(project.databasePath).toLowerCase() !== registryPath,
          projection: projectionByProject.get(project.id) ?? null,
        };
      } catch {
        return {
          code: project.code,
          lifecycle: project.lifecycle,
          ok: false,
          quickCheck: false,
          foreignKeys: false,
          separateDatabase: true,
          projection: projectionByProject.get(project.id) ?? null,
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
    return {
      registry,
      projects,
      projectCounts,
      projectionSummary: this.#dependencies.projectionSummary(),
      projectionFailures: this.#dependencies.projectionFailures(),
    };
  }

  projectionState(projectCodeOrId: string): ProjectionStateView {
    const project = this.#dependencies.getProject(projectCodeOrId);
    const row = this.#registry.sqlite
      .prepare(
        `SELECT projects.id AS project_id, projects.code, projects.name, projects.lifecycle,
                state.source_sequence, state.projected_sequence, state.status,
                state.last_error, state.retry_count, state.updated_at
         FROM projects
         JOIN project_projection_state state ON state.project_id = projects.id
         WHERE projects.id = ?`,
      )
      .get(project.id) as ProjectionStateRow | undefined;
    if (!row) {
      throw new AtmError("INTERNAL_ERROR", {
        message: `项目缺少 Projection 状态：${project.code}`,
        details: { entity: "PROJECTION_STATE", project: project.code },
      });
    }
    return projectionStateFromRow(row);
  }

  listProjectionStates(includeTrashed = false): ProjectionStateView[] {
    const rows = this.#registry.sqlite
      .prepare(
        `SELECT projects.id AS project_id, projects.code, projects.name, projects.lifecycle,
                state.source_sequence, state.projected_sequence, state.status,
                state.last_error, state.retry_count, state.updated_at
         FROM projects
         JOIN project_projection_state state ON state.project_id = projects.id
         ${includeTrashed ? "" : "WHERE projects.lifecycle <> 'TRASHED'"}
         ORDER BY projects.code`,
      )
      .all() as ProjectionStateRow[];
    return rows.map(projectionStateFromRow);
  }

  projectionSummary(includeTrashed = false): ProjectionSummary {
    const projects = this.#dependencies
      .listProjects(true)
      .filter((project) => includeTrashed || project.lifecycle !== "TRASHED");
    const states = this.#dependencies.listProjectionStates(includeTrashed);
    const missingCount = projects.length - states.length;
    const appliedCount = states.filter(
      (state) => state.status === "APPLIED" && state.lag === 0,
    ).length;
    const deferredCount = states.filter((state) => state.status === "DEFERRED").length;
    const lags = states.map((state) => state.lag);
    const maxLag = lags.reduce(
      (selected, lag) =>
        Math.abs(lag) > Math.abs(selected) ||
        (Math.abs(lag) === Math.abs(selected) && lag > selected)
          ? lag
          : selected,
      0,
    );
    return {
      status:
        missingCount > 0 || states.some((state) => state.status === "DEFERRED" || state.lag !== 0)
          ? "DEFERRED"
          : "APPLIED",
      total: projects.length,
      appliedCount,
      deferredCount,
      missingCount,
      retryScheduledCount: states.filter((state) => state.retryScheduled).length,
      lagging: states.filter((state) => state.lag !== 0).length,
      maxLag,
      totalLag: lags.reduce((total, lag) => total + lag, 0),
    };
  }

  projectionFailures(includeTrashed = false): ProjectionFailureView[] {
    const states = this.#dependencies.listProjectionStates(includeTrashed);
    const stateByProject = new Map(states.map((state) => [state.project.id, state] as const));
    const failures: ProjectionFailureView[] = [];
    for (const project of this.#dependencies
      .listProjects(true)
      .filter((candidate) => includeTrashed || candidate.lifecycle !== "TRASHED")) {
      const identity = {
        id: project.id,
        code: project.code,
        name: project.name,
        lifecycle: project.lifecycle,
      };
      const state = stateByProject.get(project.id) ?? null;
      if (!state) {
        failures.push({
          project: identity,
          reason: "MISSING",
          lag: null,
          lastError: "Projection 状态缺失",
          state: null,
        });
      } else if (state.lag < 0) {
        failures.push({
          project: identity,
          reason: "INVERTED",
          lag: state.lag,
          lastError: state.lastError,
          state,
        });
      } else if (state.status === "DEFERRED" || state.lag > 0) {
        failures.push({
          project: identity,
          reason: "DEFERRED",
          lag: state.lag,
          lastError: state.lastError,
          state,
        });
      }
    }
    return failures;
  }

  globalSearch(query: string, limit = 20, cursor?: string): SearchPage {
    const boundedLimit = Math.min(30, Math.max(1, limit));
    const normalized = query.trim();
    if (!normalized) return { hits: [], nextCursor: null, hasMore: false };
    const scope = "*";
    const decoded = cursor ? decodeSearchCursor(cursor, { scope, query: normalized }) : null;
    const snapshot = decoded?.snapshot ?? {
      documents: Number(
        (
          this.#registry.sqlite
            .prepare("SELECT COALESCE(MAX(rowid), 0) AS value FROM global_search_documents")
            .get() as { value: number }
        ).value,
      ),
      quickTasks: Number(
        (
          this.#registry.sqlite
            .prepare("SELECT COALESCE(MAX(rowid), 0) AS value FROM quick_tasks")
            .get() as { value: number }
        ).value,
      ),
    };
    const keyset = decoded
      ? `(
          updated_at < ? OR
          (updated_at = ? AND COALESCE(project, '') > ?) OR
          (updated_at = ? AND COALESCE(project, '') = ? AND entity_type > ?) OR
          (updated_at = ? AND COALESCE(project, '') = ? AND entity_type = ? AND entity_key > ?)
        )`
      : "1 = 1";
    const keysetParams = decoded
      ? [
          decoded.last.updatedAt,
          decoded.last.updatedAt,
          decoded.last.project,
          decoded.last.updatedAt,
          decoded.last.project,
          decoded.last.entityType,
          decoded.last.updatedAt,
          decoded.last.project,
          decoded.last.entityType,
          decoded.last.entityKey,
        ]
      : [];
    const escaped = `%${normalized.replace(/[\\%_]/gu, "\\$&")}%`;
    const rows = (
      [...normalized].length >= 3
        ? this.#registry.sqlite
            .prepare(
              `WITH candidates AS (
                 SELECT documents.entity_type, documents.entity_key, documents.title,
                        documents.summary, documents.updated_at, projects.code AS project
                 FROM global_search_documents_fts search
                 JOIN global_search_documents documents
                   ON documents.project_id = search.project_id
                  AND documents.entity_type = search.entity_type
                  AND documents.entity_key = search.entity_key
                 JOIN projects ON projects.id = documents.project_id
                 WHERE global_search_documents_fts MATCH ? AND documents.rowid <= ?
                 UNION ALL
                 SELECT 'QUICK_TASK', 'Q-' || printf('%04d', quick.local_no), quick.title,
                        quick.note, quick.updated_at, NULL
                 FROM quick_tasks quick
                 WHERE quick.rowid <= ?
                   AND (quick.title LIKE ? ESCAPE '\\' OR quick.note LIKE ? ESCAPE '\\')
               )
               SELECT entity_type, entity_key, title, summary, updated_at, project
               FROM candidates WHERE ${keyset}
               ORDER BY updated_at DESC, COALESCE(project, ''), entity_type, entity_key
               LIMIT ?`,
            )
            .all(
              `"${normalized.replaceAll('"', '""')}"`,
              snapshot.documents,
              snapshot.quickTasks,
              escaped,
              escaped,
              ...keysetParams,
              boundedLimit + 1,
            )
        : this.#registry.sqlite
            .prepare(
              `WITH candidates AS (
                 SELECT documents.entity_type, documents.entity_key, documents.title,
                        documents.summary, documents.updated_at, projects.code AS project
                 FROM global_search_documents documents
                 JOIN projects ON projects.id = documents.project_id
                 WHERE documents.rowid <= ?
                   AND (documents.title LIKE ? ESCAPE '\\' OR documents.summary LIKE ? ESCAPE '\\')
                 UNION ALL
                 SELECT 'QUICK_TASK', 'Q-' || printf('%04d', quick.local_no), quick.title,
                        quick.note, quick.updated_at, NULL
                 FROM quick_tasks quick
                 WHERE quick.rowid <= ?
                   AND (quick.title LIKE ? ESCAPE '\\' OR quick.note LIKE ? ESCAPE '\\')
               )
               SELECT entity_type, entity_key, title, summary, updated_at, project
               FROM candidates WHERE ${keyset}
               ORDER BY updated_at DESC, COALESCE(project, ''), entity_type, entity_key
               LIMIT ?`,
            )
            .all(
              snapshot.documents,
              escaped,
              escaped,
              snapshot.quickTasks,
              escaped,
              escaped,
              ...keysetParams,
              boundedLimit + 1,
            )
    ) as Array<{
      entity_type: string;
      entity_key: string;
      title: string;
      summary: string;
      updated_at: string;
      project: string | null;
    }>;
    const hits: SearchHit[] = rows.slice(0, boundedLimit).map((row) => ({
      entityType: row.entity_type,
      entityKey: row.entity_key,
      title: row.title,
      snippet: String(row.summary).slice(0, 240),
      updatedAt: row.updated_at,
      project: row.project,
    }));
    const hasMore = rows.length > boundedLimit;
    const last = hits.at(-1);
    return {
      hits,
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeSearchCursor({
              scope,
              query: normalized,
              snapshot,
              last: {
                updatedAt: last.updatedAt,
                project: last.project ?? "",
                entityType: last.entityType,
                entityKey: last.entityKey,
              },
            })
          : null,
    };
  }

  overview(): Record<string, unknown> {
    const projects = this.#registry.sqlite
      .prepare(
        `SELECT projects.id, projects.code, projects.name, projects.lifecycle,
                summaries.project_sequence, summaries.progress, summaries.progress_source, summaries.health,
                summaries.current_objective, summaries.current_milestone,
                summaries.active_count, summaries.ready_count, summaries.blocked_count,
                summaries.waiting_user_count, summaries.waiting_agent_count,
                summaries.stale_claim_count, summaries.active_agent_count, summaries.overdue_count,
                summaries.last_project_update_at, summaries.last_activity_at, summaries.next_target_date,
                projection.source_sequence AS _projection_source_sequence,
                projection.projected_sequence AS _projection_projected_sequence,
                projection.status AS _projection_status,
                projection.last_error AS _projection_last_error,
                projection.retry_count AS _projection_retry_count,
                projection.updated_at AS _projection_updated_at
         FROM projects
         LEFT JOIN project_summary_cache summaries ON summaries.project_id = projects.id
         LEFT JOIN project_projection_state projection ON projection.project_id = projects.id
         WHERE projects.lifecycle <> 'TRASHED'
         ORDER BY COALESCE(summaries.last_activity_at, projects.updated_at) DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    const projectViews = projects.map((row) => {
      const {
        _projection_source_sequence: sourceSequence,
        _projection_projected_sequence: projectedSequence,
        _projection_status: projectionStatus,
        _projection_last_error: projectionLastError,
        _projection_retry_count: projectionRetryCount,
        _projection_updated_at: projectionUpdatedAt,
        ...project
      } = row;
      return {
        ...project,
        projection:
          typeof projectionStatus === "string"
            ? projectionStateFromRow({
                project_id: String(row.id),
                code: String(row.code),
                name: String(row.name),
                lifecycle: String(row.lifecycle),
                source_sequence: Number(sourceSequence),
                projected_sequence: Number(projectedSequence),
                status: projectionStatus as "APPLIED" | "DEFERRED",
                last_error: projectionLastError === null ? null : String(projectionLastError),
                retry_count: Number(projectionRetryCount),
                updated_at: String(projectionUpdatedAt),
              })
            : null,
      };
    });
    const totals = this.#registry.sqlite
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status IN ('OPEN','IN_PROGRESS','BLOCKED') THEN 1 ELSE 0 END) AS open,
                SUM(CASE WHEN status = 'BLOCKED' THEN 1 ELSE 0 END) AS blocked
         FROM quick_tasks`,
      )
      .get() as Record<string, unknown>;
    const sequence = this.#registry.sqlite
      .prepare("SELECT current_sequence FROM app_meta WHERE singleton = 1")
      .get() as { current_sequence: number };
    const recentEventRows = this.#registry.sqlite
      .prepare(
        `SELECT sequence, type, aggregate_id, actor, payload_json, created_at
         FROM global_events
         WHERE type <> 'project.summary.updated'
         ORDER BY sequence DESC LIMIT 40`,
      )
      .all() as Array<Record<string, unknown>>;
    const recentEvents = recentEventRows.map((row) =>
      this.#presentGlobalRow({
        sequence: Number(row.sequence),
        type: String(row.type),
        aggregate_id: String(row.aggregate_id ?? ""),
        actor: String(row.actor ?? "SYSTEM"),
        payload_json: String(row.payload_json ?? "{}"),
        created_at: String(row.created_at),
      }),
    );
    return {
      sequence: sequence.current_sequence,
      projects: projectViews,
      quick: totals,
      recentEvents,
      projectionSummary: this.#dependencies.projectionSummary(),
      projectionFailures: this.#dependencies.projectionFailures(),
    };
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
    const rows = this.#registry.sqlite
      .prepare(
        `SELECT sequence, type, aggregate_id, actor, payload_json, created_at
         FROM global_events
         WHERE sequence > ? AND type <> 'project.summary.updated'
         ORDER BY sequence LIMIT ?`,
      )
      .all(Math.max(0, sinceSequence), bounded + 1) as any[];
    const page = rows.slice(0, bounded).map((row) => this.#presentGlobalRow(row));
    return {
      events: page,
      nextSequence: page.at(-1)?.seq ?? Math.max(0, sinceSequence),
      hasMore: rows.length > bounded,
    };
  }
}
