import { nowIso, type ProjectionReceipt } from "@ayanami-task/protocol";
import type { ManagedDatabase } from "./database.js";
import type { ProjectOutboxChange } from "./project-projection-source.js";

export type ProjectionDispatchResult = {
  delivered: number;
  sequence: number;
  projection: ProjectionReceipt;
};

type ProjectionProject = {
  id: string;
  code: string;
  name: string;
};

export type ProjectProjectionPort = {
  summaryProjection(): any;
  searchProjection(): any[];
  searchProjectionForChanges(
    changes: Array<{ eventType: string; aggregateType: string; aggregateId: string }>,
  ): any[];
  pendingOutbox(limit?: number): ProjectOutboxChange[];
  markOutboxDelivered(ids: string[]): void;
  markOutboxFailed(ids: string[], error: string): void;
};

export function projectionErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

export function markProjectionDeferred(
  registry: ManagedDatabase,
  projectId: string,
  error: string,
): void {
  if (registry.schemaVersion < 5) return;
  registry.sqlite
    .prepare(
      `INSERT INTO project_projection_state(
         project_id, source_sequence, projected_sequence, status,
         last_error, retry_count, updated_at
       ) VALUES (?, 0, 0, 'DEFERRED', ?, 1, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         status = 'DEFERRED', last_error = excluded.last_error,
         retry_count = project_projection_state.retry_count + 1,
         updated_at = excluded.updated_at`,
    )
    .run(projectId, error.slice(0, 2_000), nowIso());
}

export class RegistryProjectionDispatcher {
  readonly #registry: ManagedDatabase;
  readonly #getProject: (codeOrId: string) => ProjectionProject;
  readonly #projectProjection: (codeOrId: string) => Promise<ProjectProjectionPort>;
  readonly #appendGlobalEvent: (
    type: string,
    aggregateId: string,
    actor: string,
    payload: unknown,
    dedupeKey?: string | null,
  ) => number;
  readonly #projectionReceipt: (
    projectId: string,
    sourceSequence: number,
    retryScheduled: boolean,
    fallbackError: string | null,
  ) => ProjectionReceipt;

  constructor(input: {
    registry: ManagedDatabase;
    getProject: (codeOrId: string) => ProjectionProject;
    projectProjection: (codeOrId: string) => Promise<ProjectProjectionPort>;
    appendGlobalEvent: (
      type: string,
      aggregateId: string,
      actor: string,
      payload: unknown,
      dedupeKey?: string | null,
    ) => number;
    projectionReceipt: (
      projectId: string,
      sourceSequence: number,
      retryScheduled: boolean,
      fallbackError: string | null,
    ) => ProjectionReceipt;
  }) {
    this.#registry = input.registry;
    this.#getProject = input.getProject;
    this.#projectProjection = input.projectProjection;
    this.#appendGlobalEvent = input.appendGlobalEvent;
    this.#projectionReceipt = input.projectionReceipt;
  }

  async dispatchProject(projectCodeOrId: string): Promise<ProjectionDispatchResult> {
    const project = this.#getProject(projectCodeOrId);
    const repository = await this.#projectProjection(project.id);
    const projection = repository.summaryProjection();
    const sourceSequence = projection.projectSequence;
    const supportsReliabilityState = this.#registry.schemaVersion >= 5;

    if (supportsReliabilityState) {
      const now = nowIso();
      this.#registry.sqlite
        .prepare(
          `INSERT INTO project_projection_state(
             project_id, source_sequence, projected_sequence, status,
             last_error, retry_count, updated_at
           ) VALUES (?, ?, 0, 'DEFERRED', NULL, 0, ?)
           ON CONFLICT(project_id) DO UPDATE SET
             source_sequence = excluded.source_sequence,
             projected_sequence = MIN(project_projection_state.projected_sequence, excluded.source_sequence),
             status = 'DEFERRED',
             updated_at = excluded.updated_at`,
        )
        .run(project.id, sourceSequence, now);
    }

    let delivered = 0;
    let cached = this.#registry.sqlite
      .prepare("SELECT project_sequence FROM project_summary_cache WHERE project_id = ?")
      .get(project.id) as { project_sequence: number } | undefined;

    while (true) {
      const pending = repository.pendingOutbox(500);
      const rebuildSearch = !cached || pending.length === 0;
      if (pending.length === 0 && cached?.project_sequence === sourceSequence) break;

      try {
        const documents = rebuildSearch
          ? repository.searchProjection()
          : repository.searchProjectionForChanges(pending);
        const projectedThrough =
          pending.length === 0
            ? sourceSequence
            : Math.max(...pending.map((change) => change.project_sequence));
        this.#registry.sqlite.transaction(() => {
          this.#registry.sqlite
            .prepare(
              `INSERT INTO project_summary_cache(
                 project_id, project_sequence, progress, progress_source, health, lifecycle,
                 current_objective, current_milestone, active_count, ready_count, blocked_count,
                 waiting_user_count, waiting_agent_count, stale_claim_count, active_agent_count,
                 overdue_count, last_project_update_at, last_activity_at, next_target_date, updated_at
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
              sourceSequence,
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
            this.#registry.sqlite
              .prepare("DELETE FROM global_search_documents WHERE project_id = ?")
              .run(project.id);
            this.#registry.sqlite
              .prepare("DELETE FROM global_search_documents_fts WHERE project_id = ?")
              .run(project.id);
          }
          const documentInsert = this.#registry.sqlite.prepare(
            `INSERT INTO global_search_documents(
               project_id, entity_type, entity_key, title, summary, project_sequence, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(project_id, entity_type, entity_key) DO UPDATE SET
               title = excluded.title, summary = excluded.summary,
               project_sequence = excluded.project_sequence, updated_at = excluded.updated_at`,
          );
          const ftsDelete = this.#registry.sqlite.prepare(
            `DELETE FROM global_search_documents_fts
             WHERE project_id = ? AND entity_type = ? AND entity_key = ?`,
          );
          const ftsInsert = this.#registry.sqlite.prepare(
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
              sourceSequence,
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
            const dedupeKey = change.eventId
              ? `project:${project.id}:event:${change.eventId}`
              : `project:${project.id}:outbox:${change.id}`;
            this.#appendGlobalEvent(
              change.eventType,
              change.aggregateId || project.id,
              change.actor,
              {
                ...change.eventPayload,
                projectId: project.id,
                projectCode: project.code,
                projectName: project.name,
                projectSequence: change.project_sequence,
                sourceEventId: change.eventId,
                sourceProjectSequence: change.project_sequence,
                sourceAggregateType: change.aggregateType,
                sourceAggregateId: change.aggregateId,
              },
              dedupeKey,
            );
          }
          if (supportsReliabilityState) {
            this.#registry.sqlite
              .prepare(
                `UPDATE project_projection_state SET
                   projected_sequence = MIN(?, source_sequence),
                   status = 'DEFERRED', updated_at = ?
                 WHERE project_id = ?`,
              )
              .run(projectedThrough, nowIso(), project.id);
          }
        })();
      } catch (error) {
        const message = projectionErrorMessage(error);
        try {
          repository.markOutboxFailed(
            pending.map((item) => item.id),
            message,
          );
        } catch {
          // The Registry state remains the durable failure signal when the project DB is unavailable.
        }
        if (supportsReliabilityState) {
          this.#registry.sqlite
            .prepare(
              `UPDATE project_projection_state SET status = 'DEFERRED', last_error = ?,
                 retry_count = retry_count + 1, updated_at = ? WHERE project_id = ?`,
            )
            .run(message, nowIso(), project.id);
        }
        return {
          delivered,
          sequence: sourceSequence,
          projection: this.#projectionReceipt(project.id, sourceSequence, true, message),
        };
      }

      if (pending.length > 0) {
        try {
          repository.markOutboxDelivered(pending.map((item) => item.id));
          delivered += pending.length;
        } catch (error) {
          const message = projectionErrorMessage(error);
          try {
            repository.markOutboxFailed(
              pending.map((item) => item.id),
              message,
            );
          } catch {
            // Keep the original acknowledgement failure as the durable Registry error.
          }
          if (supportsReliabilityState) {
            this.#registry.sqlite
              .prepare(
                `UPDATE project_projection_state SET status = 'DEFERRED', last_error = ?,
                   retry_count = retry_count + 1, updated_at = ? WHERE project_id = ?`,
              )
              .run(message, nowIso(), project.id);
          }
          return {
            delivered,
            sequence: sourceSequence,
            projection: this.#projectionReceipt(project.id, sourceSequence, true, message),
          };
        }
      }
      cached = { project_sequence: sourceSequence };
      if (pending.length === 0) break;
    }

    if (supportsReliabilityState) {
      this.#registry.sqlite
        .prepare(
          `UPDATE project_projection_state SET source_sequence = ?, projected_sequence = ?,
             status = 'APPLIED', last_error = NULL, updated_at = ? WHERE project_id = ?`,
        )
        .run(sourceSequence, sourceSequence, nowIso(), project.id);
    }
    return {
      delivered,
      sequence: sourceSequence,
      projection: this.#projectionReceipt(project.id, sourceSequence, false, null),
    };
  }

  projectionReceipt(
    projectId: string,
    sourceSequence: number,
    retryScheduled: boolean,
    fallbackError: string | null,
  ): ProjectionReceipt {
    if (this.#registry.schemaVersion < 5) {
      return {
        status: retryScheduled ? "DEFERRED" : "APPLIED",
        sourceSeq: sourceSequence,
        projectedSeq: retryScheduled ? 0 : sourceSequence,
        lag: retryScheduled ? sourceSequence : 0,
        retryScheduled,
        lastError: fallbackError,
        retryCount: retryScheduled ? 1 : 0,
      };
    }
    const row = this.#registry.sqlite
      .prepare(
        `SELECT source_sequence, projected_sequence, status, last_error, retry_count
         FROM project_projection_state WHERE project_id = ?`,
      )
      .get(projectId) as {
      source_sequence: number;
      projected_sequence: number;
      status: "APPLIED" | "DEFERRED";
      last_error: string | null;
      retry_count: number;
    };
    return {
      status: row.status,
      sourceSeq: row.source_sequence,
      projectedSeq: row.projected_sequence,
      lag: row.source_sequence - row.projected_sequence,
      retryScheduled,
      lastError: row.last_error?.slice(0, 2_000) ?? null,
      retryCount: row.retry_count,
    };
  }
}
