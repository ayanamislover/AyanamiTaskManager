import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { createUlid, nowIso } from "@ayanami-task/protocol";
import { EvidenceNormalizer } from "./evidence-normalizer.js";
import { ProjectMutationKernel, type MutationActor } from "./project-mutation-kernel.js";
import { TaskReadModel } from "./task-read-model.js";
import { WorkItemMaintenance } from "./work-item-maintenance.js";
import { resolveStoredWorkItemOperation } from "./work-item-operation.js";

export class ProgressCommands {
  readonly #sqlite: Database.Database;
  readonly #mutation: ProjectMutationKernel;
  readonly #taskReads: TaskReadModel;
  readonly #maintenance: WorkItemMaintenance;
  readonly #evidence: EvidenceNormalizer;

  constructor(
    sqlite: Database.Database,
    mutation: ProjectMutationKernel,
    taskReads: TaskReadModel,
    maintenance: WorkItemMaintenance,
    evidence: EvidenceNormalizer,
  ) {
    this.#sqlite = sqlite;
    this.#mutation = mutation;
    this.#taskReads = taskReads;
    this.#maintenance = maintenance;
    this.#evidence = evidence;
  }

  #projectSequence(): number {
    return Number(
      (
        this.#sqlite
          .prepare("SELECT current_sequence FROM project_meta WHERE singleton = 1")
          .get() as { current_sequence: number }
      ).current_sequence,
    );
  }

  addProgress(
    actor: MutationActor,
    opId: string,
    input: {
      taskKey: string;
      percent?: number;
      summary: string;
      completed?: Array<string | { text: string; workItemKey?: string }>;
      next?: string[];
      blocker?: string | null;
      evidence?: unknown[];
    },
  ): {
    ok: 1;
    noop?: true;
    seq: number;
    key: string;
    v: number;
    opId: string;
    progressId: string;
  } {
    const normalizedInput = {
      ...input,
      ...(input.evidence === undefined
        ? {}
        : { evidence: this.#evidence.normalize(input.evidence) }),
    };
    return this.#mutation.mutate({
      actor,
      opId,
      operation: "work.progress",
      request: normalizedInput,
      action: () => {
        const row = this.#taskReads.rowForTaskKey(normalizedInput.taskKey);
        if (normalizedInput.blocker?.trim()) resolveStoredWorkItemOperation("block", row);
        const bucket =
          normalizedInput.percent === undefined
            ? null
            : Math.round(Math.max(0, Math.min(100, normalizedInput.percent)) / 10) * 10;
        const hash = createHash("sha256").update(normalizedInput.summary.trim()).digest("hex");
        const last = this.#sqlite
          .prepare(
            `SELECT id, progress_bucket, summary_hash FROM progress_updates
             WHERE work_item_id = ? ORDER BY created_at DESC LIMIT 1`,
          )
          .get(row.id) as
          | { id: string; progress_bucket: number | null; summary_hash: string }
          | undefined;
        if (
          last &&
          last.progress_bucket === bucket &&
          last.summary_hash === hash &&
          !normalizedInput.evidence?.length &&
          !normalizedInput.blocker
        ) {
          return {
            ok: 1,
            noop: true,
            seq: this.#projectSequence(),
            key: normalizedInput.taskKey,
            v: row.version,
            opId,
            progressId: last.id,
          };
        }
        const now = nowIso();
        const progressId = createUlid();
        this.#sqlite
          .prepare(
            `INSERT INTO progress_updates(
               id, work_item_id, percent, progress_bucket, summary, summary_hash,
               completed_json, next_json, blocker_text, actor, session_id, created_at,
               evidence_json, op_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            progressId,
            row.id,
            normalizedInput.percent ?? null,
            bucket,
            normalizedInput.summary.trim(),
            hash,
            JSON.stringify(normalizedInput.completed ?? []),
            JSON.stringify(normalizedInput.next ?? []),
            normalizedInput.blocker ?? null,
            actor.id,
            actor.sessionId,
            now,
            JSON.stringify(normalizedInput.evidence ?? []),
            opId,
          );
        const updates = ["reported_progress = ?", "version = version + 1", "updated_at = ?"];
        const values: unknown[] = [bucket, now];
        if (normalizedInput.blocker?.trim()) {
          updates.push(
            "status = 'BLOCKED'",
            "phase = 'BLOCKED'",
            "phase_inferred = 0",
            "waiting_on = NULL",
            "waiting_for = NULL",
            "blocked_reason = ?",
          );
          values.push(normalizedInput.blocker.trim());
          const blockerId = createUlid();
          this.#sqlite
            .prepare(
              `INSERT INTO blockers(
                 id, local_no, work_item_id, severity, title, detail, status, actor,
                 version, created_at, updated_at
               ) VALUES (?, ?, ?, 'HIGH', ?, ?, 'ACTIVE', ?, 0, ?, ?)`,
            )
            .run(
              blockerId,
              this.#mutation.nextNumber("blocker"),
              row.id,
              normalizedInput.blocker.trim(),
              normalizedInput.blocker.trim(),
              actor.id,
              now,
              now,
            );
        }
        values.push(row.id);
        this.#sqlite
          .prepare(`UPDATE work_items SET ${updates.join(", ")} WHERE id = ?`)
          .run(...values);
        if (normalizedInput.evidence && normalizedInput.evidence.length > 0) {
          this.#maintenance.advanceWorkItemEvidenceAt(row.id, now);
        }
        this.#maintenance.recomputeWorkItem(row.id);
        const updated = this.#sqlite
          .prepare("SELECT version FROM work_items WHERE id = ?")
          .get(row.id) as {
          version: number;
        };
        const seq = this.#mutation.appendEvent(
          normalizedInput.blocker ? "work.blocked" : "work.progressed",
          actor,
          "WORK_ITEM",
          row.id,
          {
            key: normalizedInput.taskKey,
            title: row.title,
            from: row.computed_progress,
            to: bucket,
            summary: normalizedInput.summary.trim(),
            evidence: normalizedInput.evidence ?? [],
          },
        );
        this.#maintenance.upsertSearchDocument(
          "PROGRESS",
          progressId,
          normalizedInput.taskKey,
          normalizedInput.summary.trim(),
          normalizedInput.summary.trim(),
        );
        return {
          ok: 1,
          seq,
          key: normalizedInput.taskKey,
          v: updated.version,
          opId,
          progressId,
        };
      },
    });
  }
}
