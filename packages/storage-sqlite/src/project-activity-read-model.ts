import type Database from "better-sqlite3";
import { AtmError } from "@ayanami-task/errors";
import type { SearchHit, SearchPage } from "@ayanami-task/protocol";
import { presentEvent, type PresentedEvent } from "./event-presentation.js";
import type { ProgressUpdateView } from "./read-model-types.js";
import { decodeSearchCursor, encodeSearchCursor } from "./search-pagination.js";

function json<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

type ProjectMeta = { id: string; code: string; name: string; sequence: number };

type ProjectActivityDependencies = {
  sqlite: Database.Database;
  meta: () => ProjectMeta;
  getSession: (id: string) => unknown;
  getRecord: (reference: string) => unknown;
  progressUpdateView: (row: any) => ProgressUpdateView;
  projectUpdateView: (row: any) => unknown;
  rowForTaskKey: (taskKey: string) => { id: string };
  checklistConflictSnapshot: (checklistId: string) => unknown;
};

/** Owns operation tracing, search, deltas, and bounded recent-change projections. */
export class ProjectActivityReadModel {
  readonly #sqlite: Database.Database;
  readonly #dependencies: Omit<ProjectActivityDependencies, "sqlite">;

  constructor(dependencies: ProjectActivityDependencies) {
    this.#sqlite = dependencies.sqlite;
    this.#dependencies = dependencies;
  }

  getOperationTrace(opId: string, sessionId?: string | null): any {
    const normalized = opId.trim();
    if (!normalized) throw new AtmError("OPERATION_ID_INVALID", { message: "operationId 无效" });
    const normalizedSession = sessionId == null ? null : sessionId.trim();
    if (normalizedSession !== null) this.#dependencies.getSession(normalizedSession);
    const mutations = this.#sqlite
      .prepare(
        `SELECT operation, response_json, actor_session_id, created_at
         FROM idempotency_keys WHERE op_id = ? AND (? IS NULL OR actor_session_id = ?)
         ORDER BY created_at`,
      )
      .all(normalized, normalizedSession, normalizedSession)
      .map((row: any) => ({
        operation: row.operation,
        response: json(row.response_json, null),
        sessionId: row.actor_session_id,
        createdAt: row.created_at,
      }));
    const records = (
      this.#sqlite
        .prepare(
          `SELECT id FROM records
           WHERE op_id = ? AND (? IS NULL OR source_session_id = ?)
           ORDER BY created_at`,
        )
        .all(normalized, normalizedSession, normalizedSession) as Array<{ id: string }>
    ).map((row) => this.#dependencies.getRecord(row.id));
    const progress = (
      this.#sqlite
        .prepare(
          `SELECT progress.*, item.local_no FROM progress_updates progress
           JOIN work_items item ON item.id = progress.work_item_id
           WHERE progress.op_id = ? AND (? IS NULL OR progress.session_id = ?)
           ORDER BY progress.created_at`,
        )
        .all(normalized, normalizedSession, normalizedSession) as any[]
    ).map((row) => this.#dependencies.progressUpdateView(row));
    const projectUpdates = (
      this.#sqlite
        .prepare(
          `SELECT * FROM project_updates
           WHERE op_id = ? AND (? IS NULL OR session_id = ?)
           ORDER BY created_at`,
        )
        .all(normalized, normalizedSession, normalizedSession) as any[]
    ).map((row) => this.#dependencies.projectUpdateView(row));
    const events = (
      this.#sqlite
        .prepare(
          `SELECT sequence, type, aggregate_type, aggregate_id, actor_id, session_id,
                  payload_json, created_at, op_id
           FROM events
           WHERE op_id = ? AND (? IS NULL OR session_id = ?)
           ORDER BY sequence`,
        )
        .all(normalized, normalizedSession, normalizedSession) as any[]
    ).map((row) => ({
      seq: row.sequence,
      type: row.type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      actor: row.actor_id,
      sessionId: row.session_id,
      payload: json(row.payload_json, {}),
      at: row.created_at,
      opId: row.op_id,
    }));
    if (
      mutations.length === 0 &&
      records.length === 0 &&
      progress.length === 0 &&
      projectUpdates.length === 0 &&
      events.length === 0
    ) {
      throw new AtmError("OPERATION_NOT_FOUND", {
        message: `操作不存在：${normalized}`,
        details: { entity: "OPERATION", reference: normalized },
      });
    }
    return { opId: normalized, mutations, records, progress, projectUpdates, events };
  }

  search(query: string, limit = 20, cursor?: string): SearchPage {
    const bounded = Math.max(1, Math.min(30, limit));
    const normalized = query.trim();
    if (!normalized) return { hits: [], nextCursor: null, hasMore: false };
    const scope = this.#dependencies.meta().code;
    const decoded = cursor ? decodeSearchCursor(cursor, { scope, query: normalized }) : null;
    const snapshot = decoded?.snapshot ?? {
      documents: Number(
        (
          this.#sqlite
            .prepare("SELECT COALESCE(MAX(rowid), 0) AS value FROM search_documents")
            .get() as {
            value: number;
          }
        ).value,
      ),
      quickTasks: 0,
    };
    const clauses = ["documents.rowid <= ?"];
    const params: unknown[] = [snapshot.documents];
    if (decoded) {
      clauses.push(`(
        documents.updated_at < ? OR
        (documents.updated_at = ? AND documents.entity_type > ?) OR
        (documents.updated_at = ? AND documents.entity_type = ? AND documents.entity_key > ?)
      )`);
      params.push(
        decoded.last.updatedAt,
        decoded.last.updatedAt,
        decoded.last.entityType,
        decoded.last.updatedAt,
        decoded.last.entityType,
        decoded.last.entityKey,
      );
    }
    let rows: any[];
    if ([...normalized].length < 3) {
      const escaped = normalized.replace(/[\\%_]/gu, "\\$&");
      rows = this.#sqlite
        .prepare(
          `SELECT documents.entity_type, documents.entity_key, documents.title,
                  documents.body, documents.updated_at
           FROM search_documents documents
           WHERE (documents.title LIKE ? ESCAPE '\\' OR documents.body LIKE ? ESCAPE '\\')
             AND ${clauses.join(" AND ")}
           ORDER BY documents.updated_at DESC, documents.entity_type, documents.entity_key
           LIMIT ?`,
        )
        .all(`%${escaped}%`, `%${escaped}%`, ...params, bounded + 1) as any[];
    } else {
      const phrase = `"${normalized.replaceAll('"', '""')}"`;
      rows = this.#sqlite
        .prepare(
          `SELECT documents.entity_type, documents.entity_key, documents.title, documents.body,
             documents.updated_at
           FROM search_documents_fts fts
           JOIN search_documents documents
             ON documents.entity_type = fts.entity_type AND documents.entity_id = fts.entity_id
           WHERE search_documents_fts MATCH ?
             AND ${clauses.join(" AND ")}
           ORDER BY documents.updated_at DESC, documents.entity_type, documents.entity_key
           LIMIT ?`,
        )
        .all(phrase, ...params, bounded + 1) as any[];
    }
    const hits: SearchHit[] = rows.slice(0, bounded).map((row) => ({
      entityType: row.entity_type,
      entityKey: row.entity_key,
      title: row.title,
      snippet: String(row.body).slice(0, 240),
      updatedAt: row.updated_at,
    }));
    const hasMore = rows.length > bounded;
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
                project: "",
                entityType: last.entityType,
                entityKey: last.entityKey,
              },
            })
          : null,
    };
  }

  delta(
    sinceSequence: number,
    limit = 50,
    types: string[] = [],
  ): {
    events: Array<{
      seq: number;
      type: string;
      key: string | null;
      summary: string | null;
      actor: string;
      title: string;
      detail: string;
      changes?: Record<string, unknown>;
      project: { id: string; code: string; name: string };
      projectCode: string;
      projectName: string;
      opId: string | null;
      at: string;
    }>;
    currentSequence: number;
    hasMore: boolean;
  } {
    const clauses = ["sequence > ?"];
    const params: unknown[] = [sinceSequence];
    if (types.length > 0) {
      clauses.push(`type IN (${types.map(() => "?").join(",")})`);
      params.push(...types);
    }
    const bounded = Math.max(1, Math.min(100, limit));
    params.push(bounded + 1);
    const rows = this.#sqlite
      .prepare(
        `SELECT sequence, type, aggregate_type, aggregate_id, actor_type, actor_id,
                payload_json, created_at, op_id FROM events
         WHERE ${clauses.join(" AND ")} ORDER BY sequence LIMIT ?`,
      )
      .all(...params) as any[];
    const hasMore = rows.length > bounded;
    return {
      events: rows.slice(0, bounded).map((row) => {
        const payload = json<Record<string, unknown>>(row.payload_json, {});
        const meta = this.#dependencies.meta();
        const presented: PresentedEvent = presentEvent({
          type: row.type,
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          actor: row.actor_id ?? row.actor_type,
          payload,
          project: { id: meta.id, code: meta.code, name: meta.name },
        });
        return {
          seq: row.sequence,
          type: row.type,
          key: presented.key,
          summary: presented.summary,
          actor: presented.actor,
          title: presented.title,
          detail: presented.detail,
          ...(payload.changes && typeof payload.changes === "object"
            ? { changes: payload.changes as Record<string, unknown> }
            : {}),
          project: presented.project!,
          projectCode: meta.code,
          projectName: meta.name,
          opId: row.op_id ?? null,
          at: row.created_at,
        };
      }),
      currentSequence: this.#dependencies.meta().sequence,
      hasMore,
    };
  }

  recentWorkItemChanges(
    taskKey: string,
    limit = 6,
  ): Array<{
    seq: number;
    type: string;
    key: string;
    summary: string;
    opId: string | null;
    at: string;
  }> {
    const task = this.#dependencies.rowForTaskKey(taskKey);
    const bounded = Math.max(1, Math.min(6, limit));
    const rows = this.#sqlite
      .prepare(
        `SELECT sequence, type, aggregate_type, aggregate_id, actor_type, actor_id,
                payload_json, created_at, op_id
         FROM events
         WHERE aggregate_type = 'WORK_ITEM' AND aggregate_id = ?
         ORDER BY sequence DESC LIMIT ?`,
      )
      .all(task.id, bounded) as any[];
    return rows.map((row) => {
      const meta = this.#dependencies.meta();
      const presented = presentEvent({
        type: row.type,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        actor: row.actor_id ?? row.actor_type,
        payload: json<Record<string, unknown>>(row.payload_json, {}),
        project: { id: meta.id, code: meta.code, name: meta.name },
      });
      return {
        seq: Number(row.sequence),
        type: String(row.type),
        key: taskKey,
        summary: presented.summary,
        opId: row.op_id ?? null,
        at: String(row.created_at),
      };
    });
  }

  checklistConflictSnapshot(checklistId: string): {
    id: string;
    taskKey: string;
    taskVersion: number;
    title: string;
    status: string;
    evidenceRequired: boolean;
    evidenceCount: number;
    version: number;
    updatedAt: string;
  } {
    const row = this.#sqlite
      .prepare(
        `SELECT checklist.*, task.local_no AS task_local_no, task.version AS task_version
         FROM checklist_items checklist
         JOIN work_items task ON task.id = checklist.work_item_id
         WHERE checklist.id = ?`,
      )
      .get(checklistId) as any;
    if (!row)
      throw new AtmError("CHECKLIST_NOT_FOUND", {
        message: `检查项不存在：${checklistId}`,
        details: { entity: "CHECKLIST", reference: checklistId },
      });
    return {
      id: row.id,
      taskKey: `${this.#dependencies.meta().code}-T-${String(row.task_local_no).padStart(4, "0")}`,
      taskVersion: Number(row.task_version),
      title: String(row.title),
      status: String(row.status),
      evidenceRequired: Number(row.evidence_required) === 1,
      evidenceCount: json<unknown[]>(row.evidence_json, []).length,
      version: Number(row.version),
      updatedAt: String(row.updated_at),
    };
  }

  recentChecklistChanges(
    checklistId: string,
    limit = 6,
  ): Array<{
    seq: number;
    type: string;
    key: string;
    summary: string;
    opId: string | null;
    at: string;
  }> {
    this.#dependencies.checklistConflictSnapshot(checklistId);
    const bounded = Math.max(1, Math.min(6, limit));
    const rows = this.#sqlite
      .prepare(
        `SELECT sequence, type, aggregate_type, aggregate_id, actor_type, actor_id,
                payload_json, created_at, op_id
         FROM events
         WHERE aggregate_type = 'CHECKLIST' AND aggregate_id = ?
         ORDER BY sequence DESC LIMIT ?`,
      )
      .all(checklistId, bounded) as any[];
    return rows.map((row) => {
      const meta = this.#dependencies.meta();
      const presented = presentEvent({
        type: row.type,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        actor: row.actor_id ?? row.actor_type,
        payload: json<Record<string, unknown>>(row.payload_json, {}),
        project: { id: meta.id, code: meta.code, name: meta.name },
      });
      return {
        seq: Number(row.sequence),
        type: String(row.type),
        key: checklistId,
        summary: presented.summary,
        opId: row.op_id ?? null,
        at: String(row.created_at),
      };
    });
  }
}
