import type Database from "better-sqlite3";
import { AtmError } from "@ayanami-task/errors";
import type { RecordView } from "@ayanami-task/protocol";
import {
  progressUpdateViewFromRow,
  recordKey as mapRecordKey,
  recordViewFromProjectedRow,
} from "./read-model-mappers.js";
import type {
  ProgressUpdateView,
  RecordPageFilters,
  RecordProjectionPage,
} from "./read-model-types.js";
import { decodeRecordListCursor, encodeRecordListCursor } from "./record-list-pagination.js";

export class RecordReadModel {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly projectCode: () => string,
    private readonly taskKeyForId: (workItemId: string) => string | null,
  ) {}

  recordKey(row: { local_no: number; kind: string }): string {
    return mapRecordKey(this.projectCode(), row);
  }

  recordRow(reference: string): any {
    const normalized = reference.trim();
    let row = this.sqlite.prepare("SELECT * FROM records WHERE id = ?").get(normalized) as any;
    if (!row) {
      const publicPrefix = `${this.projectCode()}-`;
      if (normalized.startsWith(publicPrefix)) {
        const suffix = normalized.slice(publicPrefix.length);
        const match = /^(D|R)-(\d{3,})$/u.exec(suffix);
        if (match) {
          row = this.sqlite
            .prepare("SELECT * FROM records WHERE local_no = ?")
            .get(Number(match[2])) as any;
          if (row && (match[1] === "D") !== (row.kind === "DECISION")) row = undefined;
        }
      }
    }
    if (!row)
      throw new AtmError("RECORD_NOT_FOUND", {
        message: `Record 不存在：${reference}`,
        details: { entity: "RECORD", reference },
      });
    return row;
  }

  listRecordPage(filters: RecordPageFilters = {}): RecordProjectionPage {
    const project = this.projectCode();
    const selection = { list: "records" as const };
    const decoded = filters.cursor
      ? decodeRecordListCursor(filters.cursor, { project, selection })
      : { last: null };
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (decoded.last) {
      clauses.push("(records.updated_at, records.local_no) < (?, ?)");
      parameters.push(decoded.last.updatedAt, decoded.last.localNo);
    }
    const limit = Math.min(100, Math.max(1, filters.limit ?? 100));
    parameters.push(limit + 1, project, project, project);
    const rows = this.sqlite
      .prepare(
        `WITH selected_records AS (
           SELECT records.*
           FROM records
           ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
           ORDER BY records.updated_at DESC, records.local_no DESC
           LIMIT ?
         ), related_candidates AS (
           SELECT selected_records.id AS selected_id,
                  related.updated_at AS related_updated_at,
                  related.local_no AS related_local_no,
                  ? || CASE WHEN related.kind = 'DECISION' THEN '-D-' ELSE '-R-' END ||
                    printf('%03d', related.local_no) AS related_key,
                  row_number() OVER (
                    PARTITION BY selected_records.id
                    ORDER BY related.updated_at DESC, related.local_no DESC
                  ) AS related_rank
           FROM selected_records
           JOIN records related
             ON related.id <> selected_records.id
            AND related.status = 'ACTIVE'
            AND ((selected_records.topic IS NOT NULL AND related.topic = selected_records.topic)
              OR (selected_records.subject_key IS NOT NULL
                AND related.subject_key = selected_records.subject_key))
         ), related_aggregates AS (
           SELECT selected_id, json_group_array(related_key) AS related_records_json
           FROM (
             SELECT selected_id, related_key
             FROM related_candidates
             WHERE related_rank <= 20
             ORDER BY selected_id, related_updated_at DESC, related_local_no DESC
           ) ordered_related
           GROUP BY selected_id
         ), projected_records AS (
           SELECT selected_records.*,
                  CASE WHEN work_item.local_no IS NULL THEN NULL
                       ELSE ? || '-T-' || printf('%04d', work_item.local_no) END AS work_item_key,
                  CASE WHEN superseded.local_no IS NULL THEN NULL
                       ELSE ? || CASE WHEN superseded.kind = 'DECISION' THEN '-D-' ELSE '-R-' END ||
                            printf('%03d', superseded.local_no) END AS supersedes_key,
                  COALESCE(related_aggregates.related_records_json, '[]') AS related_records_json
           FROM selected_records
           LEFT JOIN work_items work_item ON work_item.id = selected_records.work_item_id
           LEFT JOIN records superseded ON superseded.id = selected_records.supersedes_id
           LEFT JOIN related_aggregates ON related_aggregates.selected_id = selected_records.id
         )
         SELECT * FROM projected_records
         ORDER BY updated_at DESC, local_no DESC`,
      )
      .all(...parameters) as any[];
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const items = selected.map((row) => recordViewFromProjectedRow(row, project));
    const itemCursors = selected.map((row) =>
      encodeRecordListCursor({
        project,
        selection,
        last: { updatedAt: String(row.updated_at), localNo: Number(row.local_no) },
      }),
    );
    const startCursor = encodeRecordListCursor({ project, selection, last: null });
    return {
      items,
      itemCursors,
      nextCursor: hasMore ? itemCursors.at(-1)! : null,
      retryCursor: filters.cursor ?? startCursor,
      hasMore,
    };
  }

  listRecords(limit = 100): RecordView[] {
    return this.listRecordPage({ limit }).items;
  }

  getRecord(reference: string): RecordView {
    const row = this.recordRow(reference);
    return {
      id: row.id,
      key: this.recordKey(row),
      kind: row.kind,
      title: row.title,
      summary: row.summary,
      detail: row.detail,
      importance: row.importance,
      scope: row.scope,
      workItemKey: row.work_item_id ? this.taskKeyForId(row.work_item_id) : null,
      supersedes: row.supersedes_id
        ? this.recordKey(this.recordRow(String(row.supersedes_id)))
        : null,
      status: row.status,
      topic: row.topic ?? null,
      subjectKey: row.subject_key ?? null,
      relatedRecords: this.relatedRecordKeys(row),
      opId: row.op_id ?? null,
      sourceType: row.source_type,
      sourceActorId: row.source_actor_id ?? null,
      sourceSessionId: row.source_session_id ?? null,
      sourceRef: row.source_ref ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  progressUpdateView(row: any): ProgressUpdateView {
    return progressUpdateViewFromRow(row, this.projectCode());
  }

  getProgressUpdate(id: string): ProgressUpdateView {
    const normalized = id.trim();
    const row = this.sqlite
      .prepare(
        `SELECT progress.*, item.local_no FROM progress_updates progress
         JOIN work_items item ON item.id = progress.work_item_id
         WHERE progress.id = ?`,
      )
      .get(normalized);
    if (!row)
      throw new AtmError("PROGRESS_NOT_FOUND", {
        message: `进度记录不存在：${normalized}`,
        details: { entity: "PROGRESS", reference: normalized },
      });
    return this.progressUpdateView(row);
  }

  private relatedRecordKeys(row: any): string[] {
    if (!row.topic && !row.subject_key) return [];
    return (
      this.sqlite
        .prepare(
          `SELECT local_no, kind FROM records
           WHERE id <> ? AND status = 'ACTIVE' AND (
             (? IS NOT NULL AND topic = ?) OR (? IS NOT NULL AND subject_key = ?)
           ) ORDER BY updated_at DESC LIMIT 20`,
        )
        .all(row.id, row.topic, row.topic, row.subject_key, row.subject_key) as Array<{
        local_no: number;
        kind: string;
      }>
    ).map((candidate) => this.recordKey(candidate));
  }
}
