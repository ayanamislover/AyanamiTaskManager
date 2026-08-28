import type Database from "better-sqlite3";
import { AtmError } from "@ayanami-task/errors";
import {
  ChecklistBatchFailureError,
  nowIso,
  type ChecklistBatchFailureReason,
} from "@ayanami-task/protocol";
import { EvidenceNormalizer } from "./evidence-normalizer.js";
import { readJson } from "./read-model-mappers.js";
import type { ChecklistView } from "./read-model-types.js";
import { ProjectMutationKernel, type MutationActor } from "./project-mutation-kernel.js";
import { TaskReadModel } from "./task-read-model.js";
import { WorkItemMaintenance } from "./work-item-maintenance.js";

export class ChecklistCommands {
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

  updateChecklist(
    actor: MutationActor,
    opId: string,
    input: {
      checklistId: string;
      expectedVersion: number;
      status: "TODO" | "DOING" | "DONE" | "SKIPPED";
      evidence?: unknown[];
    },
  ): { checklist: ChecklistView; taskProgress: number; taskVersion: number; sequence: number } {
    const normalizedInput = {
      ...input,
      ...(input.evidence === undefined
        ? {}
        : { evidence: this.#evidence.normalize(input.evidence) }),
    };
    return this.#mutation.mutate({
      actor,
      opId,
      operation: "checklist.update",
      request: normalizedInput,
      action: () => {
        const row = this.#sqlite
          .prepare("SELECT * FROM checklist_items WHERE id = ?")
          .get(input.checklistId) as any;
        if (!row)
          throw new AtmError("CHECKLIST_NOT_FOUND", {
            message: `检查项不存在：${input.checklistId}`,
            details: { entity: "CHECKLIST", reference: input.checklistId },
          });
        if (row.version !== input.expectedVersion)
          throw new AtmError("VERSION_CONFLICT", {
            message: "检查项版本已变化",
            details: {
              entity: "CHECKLIST",
              key: input.checklistId,
              expected: input.expectedVersion,
              actual: row.version,
            },
          });
        const evidence = normalizedInput.evidence ?? readJson(row.evidence_json, []);
        if (
          input.status === "DONE" &&
          Number(row.evidence_required) === 1 &&
          evidence.length === 0
        ) {
          throw new AtmError("COMPLETION_GATE_FAILED", {
            message: "检查项要求提供证据",
            details: {
              reasons: [{ checklist_id: input.checklistId, code: "EVIDENCE_REQUIRED" }],
            },
          });
        }
        const now = nowIso();
        this.#sqlite
          .prepare(
            `UPDATE checklist_items SET status = ?, evidence_json = ?, version = version + 1,
             updated_at = ? WHERE id = ?`,
          )
          .run(input.status, JSON.stringify(evidence), now, row.id);
        if (normalizedInput.evidence && normalizedInput.evidence.length > 0) {
          this.#maintenance.advanceWorkItemEvidenceAt(row.work_item_id, now);
        }
        const taskProgress = this.#maintenance.recomputeWorkItem(row.work_item_id);
        const task = this.#sqlite
          .prepare("SELECT version FROM work_items WHERE id = ?")
          .get(row.work_item_id) as {
          version: number;
        };
        const sequence = this.#mutation.appendEvent(
          "checklist.updated",
          actor,
          "CHECKLIST",
          row.id,
          {
            workItemId: row.work_item_id,
            taskKey: this.#taskReads.taskKeyForId(row.work_item_id),
            status: input.status,
          },
        );
        const updated = this.#sqlite
          .prepare("SELECT * FROM checklist_items WHERE id = ?")
          .get(row.id) as any;
        return {
          checklist: {
            id: updated.id,
            title: updated.title,
            kind: updated.kind,
            status: updated.status,
            weight: updated.weight,
            evidenceRequired: Number(updated.evidence_required) === 1,
            evidence: readJson(updated.evidence_json, []),
            version: updated.version,
          },
          taskProgress,
          taskVersion: task.version,
          sequence,
        };
      },
    });
  }

  updateChecklistBatch(
    actor: MutationActor,
    opId: string,
    input: {
      taskKey: string;
      expectedVersion: number;
      items: Array<{
        checklistId: string;
        status: "TODO" | "DOING" | "DONE" | "SKIPPED";
        evidence?: unknown[];
      }>;
    },
  ): {
    taskKey: string;
    checklist: ChecklistView[];
    taskProgress: number;
    taskVersion: number;
    updatedCount: number;
    sequence: number;
  } {
    if (input.items.length === 0 || input.items.length > 100) {
      throw new AtmError("VALIDATION_ERROR", {
        message: "检查项批次数量必须为 1 至 100",
        details: { field: "items", min: 1, max: 100, actual: input.items.length },
      });
    }
    if (new Set(input.items.map((item) => item.checklistId)).size !== input.items.length) {
      throw new AtmError("VALIDATION_ERROR", {
        message: "检查项批次包含重复 checklistId",
        details: { field: "checklistId", issue: "duplicate" },
      });
    }
    const normalizedInput = {
      ...input,
      items: input.items.map((item) => ({
        ...item,
        ...(item.evidence === undefined
          ? {}
          : { evidence: this.#evidence.normalize(item.evidence) }),
      })),
    };
    return this.#mutation.mutate({
      actor,
      opId,
      operation: "checklist.update.batch",
      request: normalizedInput,
      immediate: true,
      action: () => {
        const task = this.#taskReads.rowForTaskKey(input.taskKey);
        const reasons: ChecklistBatchFailureReason[] = [];
        if (task.version !== input.expectedVersion) {
          reasons.push({
            task_key: input.taskKey,
            code: "VERSION_CONFLICT",
            expected: input.expectedVersion,
            actual: task.version,
          });
        }
        const rows: Array<{
          row: any;
          item: (typeof normalizedInput.items)[number];
          evidence: unknown[];
        }> = [];
        for (const item of normalizedInput.items) {
          const row = this.#sqlite
            .prepare("SELECT * FROM checklist_items WHERE id = ?")
            .get(item.checklistId) as any;
          if (!row) {
            reasons.push({ checklist_id: item.checklistId, code: "NOT_FOUND" });
            continue;
          }
          if (row.work_item_id !== task.id) {
            reasons.push({ checklist_id: item.checklistId, code: "TASK_MISMATCH" });
            continue;
          }
          const evidence = item.evidence ?? readJson(row.evidence_json, []);
          if (
            item.status === "DONE" &&
            Number(row.evidence_required) === 1 &&
            evidence.length === 0
          ) {
            reasons.push({ checklist_id: item.checklistId, code: "EVIDENCE_REQUIRED" });
            continue;
          }
          rows.push({ row, item, evidence });
        }
        if (reasons.length > 0) throw new ChecklistBatchFailureError(reasons);

        const now = nowIso();
        for (const { row, item, evidence } of rows) {
          this.#sqlite
            .prepare(
              `UPDATE checklist_items SET status = ?, evidence_json = ?, version = version + 1,
               updated_at = ? WHERE id = ?`,
            )
            .run(item.status, JSON.stringify(evidence), now, row.id);
        }
        if (rows.some(({ item }) => item.evidence !== undefined && item.evidence.length > 0)) {
          this.#maintenance.advanceWorkItemEvidenceAt(task.id, now);
        }
        const taskProgress = this.#maintenance.recomputeWorkItem(task.id);
        const updatedTask = this.#sqlite
          .prepare("SELECT version FROM work_items WHERE id = ?")
          .get(task.id) as { version: number };
        const sequence = this.#mutation.appendEvent(
          "checklist.batch_updated",
          actor,
          "WORK_ITEM",
          task.id,
          {
            key: input.taskKey,
            taskKey: input.taskKey,
            expectedVersion: input.expectedVersion,
            taskVersion: updatedTask.version,
            items: rows.map(({ row, item }) => ({ checklistId: row.id, status: item.status })),
          },
        );
        const checklist = rows.map(({ row }) => {
          const updated = this.#sqlite
            .prepare("SELECT * FROM checklist_items WHERE id = ?")
            .get(row.id) as any;
          return {
            id: updated.id,
            title: updated.title,
            kind: updated.kind,
            status: updated.status,
            weight: updated.weight,
            evidenceRequired: Number(updated.evidence_required) === 1,
            evidence: readJson(updated.evidence_json, []),
            version: updated.version,
          };
        });
        return {
          taskKey: input.taskKey,
          checklist,
          taskProgress,
          taskVersion: updatedTask.version,
          updatedCount: checklist.length,
          sequence,
        };
      },
    });
  }
}
