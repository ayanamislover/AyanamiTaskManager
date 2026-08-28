import type Database from "better-sqlite3";
import { AtmError } from "@ayanami-task/errors";
import { sessionViewFromRow } from "./read-model-mappers.js";
import type { SessionPageFilters, SessionProjectionPage, SessionView } from "./read-model-types.js";
import {
  decodeSessionListCursor,
  encodeSessionListCursor,
  type SessionListSelection,
} from "./session-list-pagination.js";

export class SessionReadModel {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly projectCode: () => string,
    private readonly taskKeyForId: (workItemId: string) => string | null,
  ) {}

  getSession(id: string): any {
    const row = this.sqlite
      .prepare(
        `SELECT session.*, agent.display_name, agent.client_kind, agent.capabilities_json
         FROM agent_sessions session
         JOIN agents agent ON agent.id = session.agent_id
         WHERE session.id = ?`,
      )
      .get(id);
    if (!row)
      throw new AtmError("SESSION_NOT_FOUND", {
        message: `Session 不存在：${id}`,
        details: { entity: "SESSION", reference: id },
      });
    return row;
  }

  getSessionView(id: string): SessionView {
    return this.sessionViewFromRow(this.getSession(id));
  }

  sessionViewFromRow(row: any): SessionView {
    return sessionViewFromRow(
      row,
      this.projectCode(),
      row.current_work_item_id ? this.taskKeyForId(String(row.current_work_item_id)) : null,
    );
  }

  listAgentSessionPage(filters: SessionPageFilters = {}): SessionProjectionPage {
    const project = this.projectCode();
    const selection: SessionListSelection = { list: "sessions" };
    const decoded = filters.cursor
      ? decodeSessionListCursor(filters.cursor, { project, selection })
      : { last: null };
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (decoded.last) {
      clauses.push("(session.started_at, session.id) < (?, ?)");
      parameters.push(decoded.last.startedAt, decoded.last.id);
    }
    const limit = Math.min(100, Math.max(1, filters.limit ?? 100));
    parameters.push(limit + 1);
    const rows = this.sqlite
      .prepare(
        `SELECT session.id, session.agent_id, agent.display_name, agent.client_kind,
                agent.capabilities_json, session.parent_session_id, session.predecessor_session_id,
                session.thread_id, session.role, session.cwd, session.work_state,
                session.connection_state, session.current_work_item_id,
                task.local_no AS current_task_local_no, session.heartbeat_at,
                session.version, session.started_at, session.updated_at, session.closed_at,
                session.retirement_reason, session.close_reason,
                session.git_repo_root, session.worktree_root, session.git_common_dir,
                session.git_is_linked_worktree, session.git_branch, session.git_head,
                session.git_detached, session.git_dirty, session.git_available, session.git_error
         FROM agent_sessions session
         JOIN agents agent ON agent.id = session.agent_id
         LEFT JOIN work_items task ON task.id = session.current_work_item_id
         ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY session.started_at DESC, session.id DESC
         LIMIT ?`,
      )
      .all(...parameters) as any[];
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const items = selected.map((row) => sessionViewFromRow(row, project));
    const itemCursors = selected.map((row) =>
      encodeSessionListCursor({
        project,
        selection,
        last: { startedAt: String(row.started_at), id: String(row.id) },
      }),
    );
    const startCursor = encodeSessionListCursor({ project, selection, last: null });
    return {
      items,
      itemCursors,
      nextCursor: hasMore ? itemCursors.at(-1)! : null,
      retryCursor: filters.cursor ?? startCursor,
      hasMore,
    };
  }

  listAgentSessions(limit = 100): any[] {
    const project = this.projectCode();
    return this.sqlite
      .prepare(
        `SELECT session.id, session.agent_id, agent.display_name, agent.client_kind,
                session.role, session.connection_state, session.work_state,
                session.current_work_item_id AS current_task_id,
                session.parent_session_id, session.thread_id, session.started_at,
                session.cwd, session.git_branch, session.git_head, session.git_repo_root,
                session.worktree_root, session.git_common_dir, session.git_is_linked_worktree,
                session.git_detached, session.git_dirty, session.git_available, session.git_error,
                task.local_no AS current_task_local_no,
                COALESCE(session.heartbeat_at, session.updated_at) AS last_seen_at,
                session.closed_at AS ended_at, NULL AS outcome, NULL AS summary
         FROM agent_sessions session
         JOIN agents agent ON agent.id = session.agent_id
         LEFT JOIN work_items task ON task.id = session.current_work_item_id
         ORDER BY COALESCE(session.heartbeat_at, session.updated_at) DESC LIMIT ?`,
      )
      .all(Math.min(200, Math.max(1, limit)))
      .map((row: any) => ({
        ...row,
        current_task_key:
          typeof row.current_task_local_no === "number"
            ? `${project}-T-${String(row.current_task_local_no).padStart(4, "0")}`
            : null,
      })) as any[];
  }

  countAgentSessions(): number {
    const row = this.sqlite.prepare("SELECT COUNT(*) AS count FROM agent_sessions").get() as {
      count: number;
    };
    return Number(row.count);
  }
}
