import type Database from "better-sqlite3";
import { BRIEF_EXCLUDED_RECORD_SCOPES } from "@ayanami-task/protocol";
import type { BriefSnapshot, BriefSnapshotRecord, WorkItemView } from "./read-model-types.js";

type DetailedWorkItem = WorkItemView & { dependencies: string[] };

export class ContextReadModel {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly projectMeta: () => { code: string; sequence: number },
    private readonly listReadyWorkItems: () => WorkItemView[],
    private readonly getWorkItem: (key: string) => DetailedWorkItem,
    private readonly recordKey: (row: { local_no: number; kind: string }) => string,
  ) {}

  briefSnapshot(sessionId?: string | null): BriefSnapshot {
    const objective = this.sqlite
      .prepare("SELECT * FROM objectives WHERE status = 'ACTIVE' ORDER BY updated_at DESC LIMIT 1")
      .get() as any;
    const milestone = this.sqlite
      .prepare("SELECT * FROM milestones WHERE status = 'ACTIVE' ORDER BY sort_key LIMIT 1")
      .get() as any;
    const counts = this.sqlite
      .prepare(
        `SELECT
           SUM(CASE WHEN status IN ('CLAIMED','IN_PROGRESS','VERIFYING') THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN status = 'BLOCKED' THEN 1 ELSE 0 END) AS blocked,
           SUM(CASE WHEN status = 'WAITING_USER' THEN 1 ELSE 0 END) AS waiting_user,
           SUM(CASE WHEN status = 'WAITING_AGENT' THEN 1 ELSE 0 END) AS waiting_agent
         FROM work_items WHERE archived_at IS NULL`,
      )
      .get() as any;
    const ready = this.listReadyWorkItems().map((task) => task.key);
    const own = sessionId
      ? this.sqlite
          .prepare(
            `SELECT local_no FROM work_items WHERE claimed_by_session_id = ?
             AND status NOT IN ('DONE','CANCELLED') ORDER BY updated_at DESC LIMIT 5`,
          )
          .all(sessionId)
      : [];
    const meta = this.projectMeta();
    const session = sessionId
      ? (this.sqlite.prepare("SELECT agent_id FROM agent_sessions WHERE id = ?").get(sessionId) as
          | { agent_id: string }
          | undefined)
      : undefined;
    const currentRow = sessionId
      ? (this.sqlite
          .prepare(
            `SELECT * FROM work_items
             WHERE archived_at IS NULL AND status NOT IN ('DONE','CANCELLED')
               AND (claimed_by_session_id = ? OR assignee_agent_id = ?)
             ORDER BY CASE WHEN claimed_by_session_id = ? THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`,
          )
          .get(sessionId, session?.agent_id ?? "", sessionId) as any)
      : undefined;
    const current = currentRow
      ? this.getWorkItem(`${meta.code}-T-${String(currentRow.local_no).padStart(4, "0")}`)
      : null;
    const handoff =
      currentRow && session
        ? (this.sqlite
            .prepare(
              `SELECT summary, next_action, checkpoint_sequence
               FROM handoffs WHERE work_item_id = ?
                 AND (to_session_id = ? OR (to_session_id IS NULL AND to_agent_id = ?))
               ORDER BY checkpoint_sequence DESC, created_at DESC LIMIT 1`,
            )
            .get(currentRow.id, sessionId ?? null, session.agent_id) as
            | { summary: string; next_action: string; checkpoint_sequence: number }
            | undefined)
        : undefined;
    const records = (
      this.sqlite
        .prepare(
          `SELECT local_no, kind, summary, importance, source_type, source_actor_id,
                  source_session_id, source_ref
           FROM records
           WHERE status = 'ACTIVE'
             -- 排在 kind/importance 之外单独一条：讲 ATM 自己的 Record 不该进 brief，
             -- 无论它用的是哪个 kind。scope 是 NOT NULL DEFAULT 'PROJECT'，不必考虑 NULL。
             AND scope NOT IN (${BRIEF_EXCLUDED_RECORD_SCOPES.map(() => "?").join(",")})
             AND (
               (kind = 'CONSTRAINT' AND source_type = 'USER') OR
               (kind IN ('DECISION','CONSTRAINT','FACT','RISK') AND importance IN ('HIGH','CRITICAL'))
             )
           ORDER BY CASE WHEN source_type = 'USER' AND kind = 'CONSTRAINT' THEN 0 ELSE 1 END,
                    CASE importance WHEN 'CRITICAL' THEN 0 ELSE 1 END,
                    updated_at DESC, local_no DESC LIMIT 8`,
        )
        .all(...BRIEF_EXCLUDED_RECORD_SCOPES) as Array<{
        local_no: number;
        kind: string;
        summary: string;
        importance: string;
        source_type: string;
        source_actor_id: string | null;
        source_session_id: string | null;
        source_ref: string | null;
      }>
    ).map(({ local_no, ...record }) => ({
      key: this.recordKey({ local_no, kind: record.kind }),
      ...record,
    }));
    const progress = currentRow
      ? (this.sqlite
          .prepare(
            "SELECT summary FROM progress_updates WHERE work_item_id = ? ORDER BY created_at DESC LIMIT 1",
          )
          .get(currentRow.id) as { summary: string } | undefined)
      : undefined;
    const artifacts = currentRow
      ? (this.sqlite
          .prepare(
            `SELECT name, COALESCE(local_path, external_ref) AS ref
             FROM artifacts WHERE work_item_id = ? ORDER BY created_at DESC LIMIT 3`,
          )
          .all(currentRow.id) as Array<{ name: string; ref: string | null }>)
      : [];
    const next = [
      ...new Set([...(handoff?.next_action ? [handoff.next_action] : []), ...ready]),
    ].slice(0, 3);
    return {
      truncated: false,
      project: meta.code,
      seq: meta.sequence,
      objective: objective?.title ?? null,
      milestone: milestone?.title ?? null,
      active: Number(counts.active ?? 0),
      blocked: Number(counts.blocked ?? 0),
      waitingUser: Number(counts.waiting_user ?? 0),
      waitingAgent: Number(counts.waiting_agent ?? 0),
      own: (own as Array<{ local_no: number }>).map(
        (row) => `${meta.code}-T-${String(row.local_no).padStart(4, "0")}`,
      ),
      next,
      records,
      currentTask: current
        ? {
            key: current.key,
            title: current.title,
            status: current.status,
            version: current.version,
            acceptance: current.acceptance,
            blockedReason: current.blockedReason,
            waitingFor: current.waitingFor,
            dependencies: current.dependencies,
            claim: current.claimedBySessionId
              ? { session: current.claimedBySessionId, leaseUntil: current.claimLeaseUntil }
              : null,
          }
        : null,
      handoff: handoff
        ? {
            summary: handoff.summary,
            nextAction: handoff.next_action,
            checkpointSequence: handoff.checkpoint_sequence,
          }
        : null,
      recentProgress: progress?.summary ?? null,
      artifacts,
    };
  }

  formatBrief(snapshot: BriefSnapshot, maxChars = 1200): any {
    const result: Record<string, any> = {
      ...snapshot,
      records: snapshot.records.map((record) => {
        const legacyRecord: Partial<BriefSnapshotRecord> = { ...record };
        delete legacyRecord.key;
        return legacyRecord;
      }),
    };
    const meta = this.projectMeta();
    const next = result.next as string[];
    const cap = Math.max(300, Math.min(5000, maxChars));
    if (JSON.stringify(result).length <= cap) return result;
    result.truncated = true;
    result.artifacts = [];
    result.recentProgress = null;
    while (result.records.length > 3 && JSON.stringify(result).length > cap) result.records.pop();
    if (result.currentTask && JSON.stringify(result).length > cap) {
      result.currentTask.acceptance = result.currentTask.acceptance.slice(0, 3);
    }
    if (result.handoff && JSON.stringify(result).length > cap)
      result.handoff.summary = String(result.handoff.summary).slice(0, 120);
    while (result.records.length > 1 && JSON.stringify(result).length > cap) result.records.pop();
    if (JSON.stringify(result).length <= cap) return result;
    return {
      truncated: true,
      project: meta.code,
      seq: meta.sequence,
      currentTask: result.currentTask
        ? {
            key: result.currentTask.key,
            status: result.currentTask.status,
            version: result.currentTask.version,
            acceptance: result.currentTask.acceptance.slice(0, 2),
            blockedReason: result.currentTask.blockedReason,
            waitingFor: result.currentTask.waitingFor,
          }
        : null,
      next: next.slice(0, 2),
      records: result.records.slice(0, 1),
    };
  }
}
