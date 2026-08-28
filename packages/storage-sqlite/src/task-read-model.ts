import type Database from "better-sqlite3";
import { AtmError } from "@ayanami-task/errors";
import type { TaskViewName } from "@ayanami-task/protocol";
import {
  progressBreakdownFromHydratedRow,
  readJson,
  taskKey,
  workItemFromRow,
} from "./read-model-mappers.js";
import type {
  ChecklistView,
  TaskViewProjectionPage,
  WorkItemListFilters,
  WorkItemPageFilters,
  WorkItemProgressBreakdown,
  WorkItemProjectionPage,
  WorkItemView,
} from "./read-model-types.js";
import {
  canonicalTaskListSelection,
  decodeTaskListCursor,
  encodeTaskListCursor,
  type TaskListSelection,
} from "./task-list-pagination.js";
import { taskViewProjectionSql, type TaskViewProjectionRow } from "./task-view-query.js";

function hydratedWorkItemSql(
  whereSql: string,
  selectionTailSql: string,
  resultOrderSql: string,
): string {
  return `WITH selected AS (
            SELECT work_items.*
            FROM work_items
            WHERE ${whereSql}
            ${selectionTailSql}
          ), child_summary AS (
            SELECT child.parent_id AS work_item_id,
                   COALESCE(SUM(CASE WHEN child.status = 'DONE' THEN child.weight ELSE 0 END), 0) AS done_weight,
                   COALESCE(SUM(child.weight), 0) AS total_weight,
                   SUM(CASE WHEN child.status = 'DONE' THEN 1 ELSE 0 END) AS done_stages,
                   COUNT(*) AS total_stages
            FROM work_items child
            JOIN selected ON selected.id = child.parent_id
            WHERE child.archived_at IS NULL AND child.status <> 'CANCELLED'
            GROUP BY child.parent_id
          ), checklist_summary AS (
            SELECT checklist.work_item_id,
                   COALESCE(SUM(CASE WHEN checklist.status = 'DONE' THEN checklist.weight ELSE 0 END), 0) AS done_weight,
                   COALESCE(SUM(checklist.weight), 0) AS total_weight,
                   SUM(CASE WHEN checklist.status = 'DONE' THEN 1 ELSE 0 END) AS done_stages,
                   COUNT(*) AS total_stages
            FROM checklist_items checklist
            JOIN selected ON selected.id = checklist.work_item_id
            WHERE checklist.status <> 'SKIPPED'
            GROUP BY checklist.work_item_id
          ), blocker_ranked AS (
            SELECT blocker.work_item_id,
                   COALESCE(NULLIF(blocker.detail, ''), NULLIF(blocker.waiting_for, ''), blocker.title) AS reason,
                    row_number() OVER (
                      PARTITION BY blocker.work_item_id
                      ORDER BY blocker.created_at DESC
                   ) AS blocker_rank
            FROM blockers blocker
            JOIN selected ON selected.id = blocker.work_item_id
            WHERE blocker.status = 'ACTIVE'
          ), discovered_from_ranked AS (
            SELECT relation.source_id AS work_item_id, target.local_no,
                   row_number() OVER (
                      PARTITION BY relation.source_id
                   ) AS relation_rank
            FROM work_item_relations relation
            JOIN selected ON selected.id = relation.source_id
            JOIN work_items target ON target.id = relation.target_id
            WHERE relation.relation_type = 'DISCOVERED_FROM'
          ), discovered_counts AS (
            SELECT relation.target_id AS work_item_id, COUNT(*) AS discovered_count
            FROM work_item_relations relation
            JOIN selected ON selected.id = relation.target_id
            WHERE relation.relation_type = 'DISCOVERED_FROM'
            GROUP BY relation.target_id
          )
          SELECT selected.*,
                 parent.local_no AS parent_local_no,
                 duplicate.local_no AS duplicate_of_local_no,
                 superseded.local_no AS superseded_by_local_no,
                 discovered_from.local_no AS discovered_from_local_no,
                 COALESCE(discovered_counts.discovered_count, 0) AS discovered_count,
                 COALESCE(child_summary.done_weight, 0) AS child_done_weight,
                 COALESCE(child_summary.total_weight, 0) AS child_total_weight,
                 COALESCE(child_summary.done_stages, 0) AS child_done_stages,
                 COALESCE(child_summary.total_stages, 0) AS child_total_stages,
                 COALESCE(checklist_summary.done_weight, 0) AS checklist_done_weight,
                 COALESCE(checklist_summary.total_weight, 0) AS checklist_total_weight,
                 COALESCE(checklist_summary.done_stages, 0) AS checklist_done_stages,
                 COALESCE(checklist_summary.total_stages, 0) AS checklist_total_stages,
                 blocker.reason AS active_blocker_reason
          FROM selected
          LEFT JOIN work_items parent ON parent.id = selected.parent_id
          LEFT JOIN work_items duplicate ON duplicate.id = selected.duplicate_of_id
          LEFT JOIN work_items superseded ON superseded.id = selected.superseded_by_id
          LEFT JOIN child_summary ON child_summary.work_item_id = selected.id
          LEFT JOIN checklist_summary ON checklist_summary.work_item_id = selected.id
          LEFT JOIN blocker_ranked blocker
            ON blocker.work_item_id = selected.id AND blocker.blocker_rank = 1
          LEFT JOIN discovered_from_ranked discovered_from
            ON discovered_from.work_item_id = selected.id AND discovered_from.relation_rank = 1
          LEFT JOIN discovered_counts ON discovered_counts.work_item_id = selected.id
          ${resultOrderSql}`;
}

export class TaskReadModel {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly projectCode: () => string,
  ) {}

  rowForTaskKey(value: string): any {
    const code = this.projectCode();
    const prefix = `${code}-T-`;
    const suffix = value.startsWith(prefix) ? value.slice(prefix.length) : "";
    const localNo = /^\d+$/u.test(suffix) ? Number(suffix) : Number.NaN;
    if (!Number.isSafeInteger(localNo)) this.workItemNotFound(value);
    const row = this.sqlite.prepare("SELECT * FROM work_items WHERE local_no = ?").get(localNo);
    if (!row) this.workItemNotFound(value);
    return row;
  }

  taskKeyForId(workItemId: string): string | null {
    const row = this.sqlite
      .prepare("SELECT local_no FROM work_items WHERE id = ?")
      .get(workItemId) as { local_no: number } | undefined;
    return row ? taskKey(this.projectCode(), row.local_no) : null;
  }

  workItemViewFromRow(row: any): WorkItemView {
    const code = this.projectCode();
    return workItemFromRow(
      {
        ...row,
        parent_key: row.parent_id ? this.taskKeyForId(row.parent_id) : null,
        duplicate_of_key: row.duplicate_of_id ? this.taskKeyForId(row.duplicate_of_id) : null,
        superseded_by_key: row.superseded_by_id ? this.taskKeyForId(row.superseded_by_id) : null,
      },
      code,
      this.progressBreakdownForRow(row),
    );
  }

  getWorkItem(value: string): WorkItemView & {
    checklist: ChecklistView[];
    dependencies: string[];
    discoveredFrom: string | null;
    discovered: string[];
    executionSession: Record<string, unknown> | null;
  } {
    const row = this.rowForTaskKey(value);
    const code = this.projectCode();
    const checklist = (
      this.sqlite
        .prepare("SELECT * FROM checklist_items WHERE work_item_id = ? ORDER BY created_at")
        .all(row.id) as any[]
    ).map((item) => ({
      id: item.id,
      title: item.title,
      kind: item.kind,
      status: item.status,
      weight: item.weight,
      evidenceRequired: Number(item.evidence_required) === 1,
      evidence: readJson(item.evidence_json, []),
      version: item.version,
    }));
    const dependencies = (
      this.sqlite
        .prepare(
          `SELECT source.local_no FROM work_item_relations relation
           JOIN work_items source ON source.id = relation.source_id
           WHERE relation.target_id = ? AND relation.relation_type = 'BLOCKS'`,
        )
        .all(row.id) as Array<{ local_no: number }>
    ).map((dependency) => taskKey(code, dependency.local_no));
    const discoveredFromRow = this.sqlite
      .prepare(
        `SELECT target.local_no FROM work_item_relations relation
         JOIN work_items target ON target.id = relation.target_id
         WHERE relation.source_id = ? AND relation.relation_type = 'DISCOVERED_FROM'
         ORDER BY relation.created_at LIMIT 1`,
      )
      .get(row.id) as { local_no: number } | undefined;
    const discovered = (
      this.sqlite
        .prepare(
          `SELECT source.local_no FROM work_item_relations relation
           JOIN work_items source ON source.id = relation.source_id
           WHERE relation.target_id = ? AND relation.relation_type = 'DISCOVERED_FROM'
           ORDER BY relation.created_at, source.local_no`,
        )
        .all(row.id) as Array<{ local_no: number }>
    ).map((entry) => taskKey(code, entry.local_no));
    const executionSession = row.claimed_by_session_id
      ? ((this.sqlite
          .prepare(
            `SELECT session.id, session.agent_id, agent.display_name, session.role,
                    session.connection_state, session.work_state, session.cwd,
                    session.git_branch, session.git_head, session.git_repo_root,
                    session.worktree_root, session.git_is_linked_worktree,
                    session.git_detached, session.git_dirty, session.git_available, session.git_error
             FROM agent_sessions session
             JOIN agents agent ON agent.id = session.agent_id
             WHERE session.id = ?`,
          )
          .get(row.claimed_by_session_id) as Record<string, unknown> | undefined) ?? null)
      : null;
    return {
      ...this.workItemViewFromRow(row),
      checklist,
      dependencies,
      discoveredFrom: discoveredFromRow ? taskKey(code, discoveredFromRow.local_no) : null,
      discovered,
      executionSession,
    };
  }

  listTaskViewPage(
    filters: WorkItemPageFilters = {},
    view: TaskViewName = "core",
  ): TaskViewProjectionPage {
    const { clauses, params, selection } = this.taskViewFilter(filters);
    const project = this.projectCode();
    const decoded = filters.cursor
      ? decodeTaskListCursor(filters.cursor, { project, selection })
      : { last: null };
    this.appendKeyset(decoded.last, clauses, params);
    const limit = Math.min(100, Math.max(1, filters.limit ?? 20));
    params.push(limit + 1);
    const rows = this.sqlite
      .prepare(
        taskViewProjectionSql({
          whereSql: clauses.join(" AND "),
          selectionTailSql: `ORDER BY CASE priority
            WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1
            WHEN 'NORMAL' THEN 2 ELSE 3 END,
            sort_key, created_at, local_no LIMIT ?`,
          view,
        }),
      )
      .all(...params) as TaskViewProjectionRow[];
    return this.taskViewPage(rows, limit, filters.cursor, project, selection);
  }

  listWorkItemPage(filters: WorkItemPageFilters = {}): WorkItemProjectionPage {
    const { clauses, params, selection } = this.taskViewFilter(filters);
    const project = this.projectCode();
    const decoded = filters.cursor
      ? decodeTaskListCursor(filters.cursor, { project, selection })
      : { last: null };
    this.appendKeyset(decoded.last, clauses, params);
    const limit = Math.min(100, Math.max(1, filters.limit ?? 20));
    params.push(limit + 1);
    const rows = this.sqlite
      .prepare(
        hydratedWorkItemSql(
          clauses.join(" AND "),
          `ORDER BY CASE priority
             WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1
             WHEN 'NORMAL' THEN 2 ELSE 3 END,
             sort_key, created_at, local_no LIMIT ?`,
          `ORDER BY CASE selected.priority
             WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END,
             selected.sort_key, selected.created_at, selected.local_no`,
        ),
      )
      .all(...params) as any[];
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const itemCursors = selected.map((row) => this.taskCursor(project, selection, row));
    const startCursor = encodeTaskListCursor({ project, selection, last: null });
    return {
      items: selected.map((row) => this.hydratedWorkItem(row, project)),
      itemCursors,
      nextCursor: hasMore ? itemCursors.at(-1)! : null,
      retryCursor: filters.cursor ?? startCursor,
      hasMore,
    };
  }

  listTaskViewRows(
    filters: WorkItemListFilters = {},
    view: TaskViewName = "core",
  ): TaskViewProjectionRow[] {
    const { clauses, params } = this.taskViewFilter(filters);
    params.push(Math.min(100, Math.max(1, filters.limit ?? 20)), Math.max(0, filters.offset ?? 0));
    return this.sqlite
      .prepare(
        taskViewProjectionSql({
          whereSql: clauses.join(" AND "),
          selectionTailSql: `ORDER BY CASE priority
            WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1
            WHEN 'NORMAL' THEN 2 ELSE 3 END,
            sort_key, created_at, local_no LIMIT ? OFFSET ?`,
          view,
        }),
      )
      .all(...params) as TaskViewProjectionRow[];
  }

  getTaskViewRow(value: string, view: TaskViewName = "core"): TaskViewProjectionRow {
    const code = this.projectCode();
    const prefix = `${code}-T-`;
    const suffix = value.startsWith(prefix) ? value.slice(prefix.length) : "";
    const localNo = /^\d+$/u.test(suffix) ? Number(suffix) : Number.NaN;
    if (!Number.isSafeInteger(localNo)) this.workItemNotFound(value);
    const row = this.sqlite
      .prepare(
        taskViewProjectionSql({
          whereSql: "archived_at IS NULL AND local_no = ?",
          selectionTailSql: "",
          view,
        }),
      )
      .get(localNo) as TaskViewProjectionRow | undefined;
    if (!row) this.workItemNotFound(value);
    return row;
  }

  listWorkItems(filters: WorkItemListFilters = {}): WorkItemView[] {
    const { clauses, params } = this.taskViewFilter(filters);
    params.push(Math.min(100, Math.max(1, filters.limit ?? 20)), Math.max(0, filters.offset ?? 0));
    const code = this.projectCode();
    const rows = this.sqlite
      .prepare(
        hydratedWorkItemSql(
          clauses.join(" AND "),
          `ORDER BY CASE priority
             WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END,
             sort_key, created_at LIMIT ? OFFSET ?`,
          `ORDER BY CASE selected.priority
             WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END,
             selected.sort_key, selected.created_at`,
        ),
      )
      .all(...params) as any[];
    return rows.map((row) => this.hydratedWorkItem(row, code));
  }

  workItemSuggestionCandidates(
    reference: string,
    limit = 50,
  ): { total: number; candidates: Array<{ key: string; status: string }> } {
    const totalRow = this.sqlite
      .prepare("SELECT COUNT(*) AS count FROM work_items WHERE archived_at IS NULL")
      .get() as { count: number };
    const boundedLimit = Math.min(100, Math.max(1, limit));
    const code = this.projectCode();
    const normalized = reference.trim().toUpperCase();
    const prefix = `${code}-T-`;
    const suffix = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
    const digits = suffix.match(/\d+/gu)?.join("") ?? "";
    const approximateLocalNo = digits.length > 0 ? Number(digits) : null;
    const safeLocalNo =
      approximateLocalNo !== null && Number.isSafeInteger(approximateLocalNo)
        ? approximateLocalNo
        : null;
    const rows = (
      safeLocalNo === null
        ? this.sqlite
            .prepare(
              `SELECT local_no, status FROM work_items WHERE archived_at IS NULL
               ORDER BY local_no LIMIT ?`,
            )
            .all(boundedLimit)
        : this.sqlite
            .prepare(
              `SELECT local_no, status FROM work_items WHERE archived_at IS NULL
               ORDER BY ABS(local_no - ?), local_no LIMIT ?`,
            )
            .all(safeLocalNo, boundedLimit)
    ) as Array<{ local_no: number; status: string }>;
    return {
      total: Number(totalRow.count),
      candidates: rows.map((row) => ({ key: taskKey(code, row.local_no), status: row.status })),
    };
  }

  private taskViewFilter(filters: WorkItemListFilters): {
    clauses: string[];
    params: unknown[];
    selection: TaskListSelection;
  } {
    const clauses = ["archived_at IS NULL"];
    const params: unknown[] = [];
    const parentIds: string[] = [];
    if (filters.parentId) parentIds.push(filters.parentId);
    if (filters.parentKey) parentIds.push(this.rowForTaskKey(filters.parentKey).id);
    const selection = canonicalTaskListSelection({
      status: filters.status ?? null,
      owner: filters.assigneeAgentId ?? null,
      parent: [...new Set(parentIds)].sort().join("\u0000") || null,
      milestone: filters.milestoneId ?? null,
      ready: filters.readyOnly === true,
      query: filters.query ?? null,
    });
    if (selection.status) {
      clauses.push("status = ?");
      params.push(selection.status);
    }
    if (selection.owner) {
      clauses.push("assignee_agent_id = ?");
      params.push(selection.owner);
    }
    for (const parentId of parentIds) {
      clauses.push("parent_id = ?");
      params.push(parentId);
    }
    if (selection.milestone) {
      clauses.push("milestone_id = ?");
      params.push(selection.milestone);
    }
    if (selection.query) {
      clauses.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
      const escaped = selection.query.replace(/[\\%_]/gu, "\\$&");
      params.push(`%${escaped}%`, `%${escaped}%`);
    }
    if (selection.ready) {
      clauses.push(
        `status = 'READY' AND NOT EXISTS (
          SELECT 1 FROM work_item_relations relation
          JOIN work_items dependency ON dependency.id = relation.source_id
          WHERE relation.target_id = work_items.id AND relation.relation_type = 'BLOCKS'
            AND dependency.status <> 'DONE'
        )`,
      );
    }
    return { clauses, params, selection };
  }

  private appendKeyset(
    last: { priorityRank: number; sortKey: number; createdAt: string; localNo: number } | null,
    clauses: string[],
    params: unknown[],
  ): void {
    if (!last) return;
    clauses.push(
      `(CASE priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1
         WHEN 'NORMAL' THEN 2 ELSE 3 END, sort_key, created_at, local_no) > (?, ?, ?, ?)`,
    );
    params.push(last.priorityRank, last.sortKey, last.createdAt, last.localNo);
  }

  private hydratedWorkItem(row: any, projectCode: string): WorkItemView {
    return workItemFromRow(
      {
        ...row,
        parent_key:
          typeof row.parent_local_no === "number"
            ? taskKey(projectCode, row.parent_local_no)
            : null,
        duplicate_of_key:
          typeof row.duplicate_of_local_no === "number"
            ? taskKey(projectCode, row.duplicate_of_local_no)
            : null,
        superseded_by_key:
          typeof row.superseded_by_local_no === "number"
            ? taskKey(projectCode, row.superseded_by_local_no)
            : null,
      },
      projectCode,
      progressBreakdownFromHydratedRow(row),
    );
  }

  private progressBreakdownForRow(row: any): WorkItemProgressBreakdown {
    type Denominator = {
      done_weight: number;
      total_weight: number;
      done_stages: number;
      total_stages: number;
    };
    const children = this.sqlite
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN status = 'DONE' THEN weight ELSE 0 END), 0) AS done_weight,
                COALESCE(SUM(weight), 0) AS total_weight,
                SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) AS done_stages,
                COUNT(*) AS total_stages
         FROM work_items
         WHERE parent_id = ? AND archived_at IS NULL AND status <> 'CANCELLED'`,
      )
      .get(row.id) as Denominator;
    const checklist = this.sqlite
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN status = 'DONE' THEN weight ELSE 0 END), 0) AS done_weight,
                COALESCE(SUM(weight), 0) AS total_weight,
                SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) AS done_stages,
                COUNT(*) AS total_stages
         FROM checklist_items WHERE work_item_id = ? AND status <> 'SKIPPED'`,
      )
      .get(row.id) as Denominator;
    const denominator = children.total_stages > 0 ? children : checklist;
    const activeBlocker = this.sqlite
      .prepare(
        `SELECT COALESCE(NULLIF(detail, ''), NULLIF(waiting_for, ''), title) AS reason
         FROM blockers WHERE work_item_id = ? AND status = 'ACTIVE'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(row.id) as { reason: string } | undefined;
    return {
      computed: Number(row.computed_progress),
      reported: row.reported_progress === null ? null : Number(row.reported_progress),
      source: String(row.progress_source),
      doneWeight: Number(denominator.done_weight),
      totalWeight: Number(denominator.total_weight),
      doneStages: Number(denominator.done_stages),
      totalStages: Number(denominator.total_stages),
      blocker: row.blocked_reason ?? activeBlocker?.reason ?? null,
    };
  }

  private taskViewPage(
    rows: TaskViewProjectionRow[],
    limit: number,
    cursor: string | undefined,
    project: string,
    selection: TaskListSelection,
  ): TaskViewProjectionPage {
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const itemCursors = items.map((row) =>
      encodeTaskListCursor({
        project,
        selection,
        last: {
          priorityRank: Number(row.priorityRank),
          sortKey: Number(row.sortKey),
          createdAt: row.createdAt,
          localNo: Number(row.localNo),
        },
      }),
    );
    const startCursor = encodeTaskListCursor({ project, selection, last: null });
    return {
      items,
      itemCursors,
      nextCursor: hasMore ? itemCursors.at(-1)! : null,
      retryCursor: cursor ?? startCursor,
      hasMore,
    };
  }

  private taskCursor(project: string, selection: TaskListSelection, row: any): string {
    return encodeTaskListCursor({
      project,
      selection,
      last: {
        priorityRank:
          row.priority === "CRITICAL"
            ? 0
            : row.priority === "HIGH"
              ? 1
              : row.priority === "NORMAL"
                ? 2
                : 3,
        sortKey: Number(row.sort_key),
        createdAt: row.created_at,
        localNo: Number(row.local_no),
      },
    });
  }

  private workItemNotFound(value: string): never {
    throw new AtmError("WORK_ITEM_NOT_FOUND", {
      message: `WorkItem 不存在：${value}`,
      details: { entity: "WORK_ITEM", reference: value },
    });
  }
}
