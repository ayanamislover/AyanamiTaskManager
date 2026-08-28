import type Database from "better-sqlite3";
import { nowIso } from "@ayanami-task/protocol";
import { OutboxReadModel } from "./outbox-read-model.js";

export type ProjectOutboxChange = {
  id: string;
  project_sequence: number;
  eventId: string | null;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  actor: string;
  eventPayload: Record<string, unknown>;
  eventSequence: number;
  eventAt: string | null;
};

export class ProjectProjectionSource {
  readonly #sqlite: Database.Database;
  readonly #outboxReads: OutboxReadModel;
  readonly #getActiveObjective: () => any;
  readonly #getActiveMilestone: (objectiveId?: string) => any;

  constructor(input: {
    sqlite: Database.Database;
    outboxReads: OutboxReadModel;
    getActiveObjective: () => any;
    getActiveMilestone: (objectiveId?: string) => any;
  }) {
    this.#sqlite = input.sqlite;
    this.#outboxReads = input.outboxReads;
    this.#getActiveObjective = input.getActiveObjective;
    this.#getActiveMilestone = input.getActiveMilestone;
  }

  summaryProjection(): any {
    const meta = this.#sqlite
      .prepare("SELECT * FROM project_meta WHERE singleton = 1")
      .get() as any;
    const weights = this.#sqlite
      .prepare(
        `SELECT computed_progress, weight FROM work_items
         WHERE parent_id IS NULL AND archived_at IS NULL AND status <> 'CANCELLED'`,
      )
      .all() as Array<{ computed_progress: number; weight: number }>;
    const totalWeight = weights.reduce((sum, item) => sum + item.weight, 0);
    const progress =
      totalWeight === 0
        ? 0
        : Math.round(
            (weights.reduce((sum, item) => sum + item.computed_progress * item.weight, 0) /
              totalWeight) *
              10,
          ) / 10;
    const counts = this.#sqlite
      .prepare(
        `SELECT
           SUM(CASE WHEN status IN ('CLAIMED','IN_PROGRESS','VERIFYING') THEN 1 ELSE 0 END) active_count,
           SUM(CASE WHEN status = 'READY' THEN 1 ELSE 0 END) ready_count,
           SUM(CASE WHEN status = 'BLOCKED' THEN 1 ELSE 0 END) blocked_count,
           SUM(CASE WHEN status = 'WAITING_USER' THEN 1 ELSE 0 END) waiting_user_count,
           SUM(CASE WHEN status = 'WAITING_AGENT' THEN 1 ELSE 0 END) waiting_agent_count,
           SUM(CASE WHEN claimed_by_session_id IS NOT NULL
             AND claim_lease_until IS NOT NULL AND claim_lease_until < ?
             AND status NOT IN ('DONE','CANCELLED') THEN 1 ELSE 0 END) stale_claim_count,
           SUM(CASE WHEN target_date IS NOT NULL AND target_date < date('now')
             AND status NOT IN ('DONE','CANCELLED') THEN 1 ELSE 0 END) overdue_count,
           MAX(updated_at) last_activity_at,
           MIN(CASE WHEN status NOT IN ('DONE','CANCELLED') THEN target_date END) next_target_date
         FROM work_items WHERE archived_at IS NULL`,
      )
      .get(nowIso()) as any;
    const objective = this.#getActiveObjective();
    const milestone = this.#getActiveMilestone(objective?.id);
    const activeAgents = (
      this.#sqlite
        .prepare("SELECT COUNT(*) AS count FROM agent_sessions WHERE connection_state = 'ONLINE'")
        .get() as { count: number }
    ).count;
    const lastUpdate = this.#sqlite
      .prepare(
        "SELECT published_at FROM project_updates WHERE status = 'PUBLISHED' ORDER BY published_at DESC LIMIT 1",
      )
      .get() as { published_at: string } | undefined;
    return {
      projectId: meta.project_id,
      projectSequence: meta.current_sequence,
      progress,
      progressSource: weights.length ? "CHILDREN" : "NONE",
      health: meta.health,
      lifecycle: meta.lifecycle,
      currentObjective: objective?.title ?? null,
      currentMilestone: milestone?.title ?? null,
      activeCount: Number(counts.active_count ?? 0),
      readyCount: Number(counts.ready_count ?? 0),
      blockedCount: Number(counts.blocked_count ?? 0),
      waitingUserCount: Number(counts.waiting_user_count ?? 0),
      waitingAgentCount: Number(counts.waiting_agent_count ?? 0),
      staleClaimCount: Number(counts.stale_claim_count ?? 0),
      activeAgentCount: activeAgents,
      overdueCount: Number(counts.overdue_count ?? 0),
      lastProjectUpdateAt: lastUpdate?.published_at ?? null,
      lastActivityAt: counts.last_activity_at ?? meta.updated_at,
      nextTargetDate: counts.next_target_date ?? null,
    };
  }

  searchProjection(): any[] {
    return this.#sqlite
      .prepare(
        `SELECT entity_type, entity_key, title, substr(body, 1, 500) AS summary, updated_at
         FROM (
           SELECT *, ROW_NUMBER() OVER (
             PARTITION BY entity_type, entity_key ORDER BY updated_at DESC, rowid DESC
           ) AS recency
           FROM search_documents
         )
         WHERE recency = 1 ORDER BY updated_at DESC`,
      )
      .all() as any[];
  }

  searchProjectionForChanges(
    changes: Array<{ eventType: string; aggregateType: string; aggregateId: string }>,
  ): any[] {
    const documents = new Map<string, any>();
    const byEntity = this.#sqlite.prepare(
      `SELECT entity_type, entity_key, title, substr(body, 1, 500) AS summary, updated_at
       FROM search_documents WHERE entity_type = ? AND entity_id = ?`,
    );
    const workKey = this.#sqlite.prepare(
      "SELECT entity_key AS task_key FROM search_documents WHERE entity_type = 'WORK_ITEM' AND entity_id = ?",
    );
    const latestProgress = this.#sqlite.prepare(
      `SELECT entity_type, entity_key, title, substr(body, 1, 500) AS summary, updated_at
       FROM search_documents WHERE entity_type = 'PROGRESS' AND entity_key = ?
       ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
    );
    for (const change of changes) {
      if (change.aggregateType === "WORK_ITEM" || change.aggregateType === "RECORD") {
        const document = byEntity.get(change.aggregateType, change.aggregateId) as any;
        if (document) documents.set(`${document.entity_type}:${document.entity_key}`, document);
      }
      if (change.eventType === "work.progressed" || change.eventType === "work.blocked") {
        const task = workKey.get(change.aggregateId) as { task_key: string } | undefined;
        const progress = task ? (latestProgress.get(task.task_key) as any) : undefined;
        if (progress) documents.set(`${progress.entity_type}:${progress.entity_key}`, progress);
      }
    }
    return [...documents.values()];
  }

  pendingOutbox(limit = 500): ProjectOutboxChange[] {
    return this.#outboxReads.pendingOutbox(limit);
  }

  markOutboxDelivered(ids: string[]): void {
    if (ids.length === 0) return;
    const statement = this.#sqlite.prepare(
      `UPDATE outbox SET delivered_at = ?, attempts = attempts + 1, last_error = NULL
       WHERE id = ? AND delivered_at IS NULL`,
    );
    const transaction = this.#sqlite.transaction(() => {
      const now = nowIso();
      for (const id of ids) statement.run(now, id);
    });
    transaction();
  }

  markOutboxFailed(ids: string[], error: string): void {
    if (ids.length === 0) return;
    const boundedError = error.slice(0, 2_000);
    const statement = this.#sqlite.prepare(
      "UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ? AND delivered_at IS NULL",
    );
    const transaction = this.#sqlite.transaction(() => {
      for (const id of ids) statement.run(boundedError, id);
    });
    transaction();
  }
}
