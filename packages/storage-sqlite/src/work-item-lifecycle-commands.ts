import type Database from "better-sqlite3";
import { assertAcyclicDependency, assertParentMove } from "@ayanami-task/domain";
import { AtmError } from "@ayanami-task/errors";
import {
  nowIso,
  workItemOperationHasEffect,
  type WorkItemOperation,
  type WorkItemPhase,
  type WorkItemStatus,
} from "@ayanami-task/protocol";
import { assertCompletionGates } from "./completion-gates.js";
import { readJson } from "./read-model-mappers.js";
import type { WorkItemView } from "./read-model-types.js";
import { ProjectMutationKernel, type MutationActor } from "./project-mutation-kernel.js";
import { TaskReadModel } from "./task-read-model.js";
import { WorkItemMaintenance } from "./work-item-maintenance.js";
import { resolveStoredWorkItemOperation, storedWorkItemPhase } from "./work-item-operation.js";

type RelationChange = {
  dependencyIds?: string[];
  discoveredFromId?: string | null;
  receipt: { dependsOn?: string[]; discoveredFrom?: string | null };
};

export class WorkItemLifecycleCommands {
  readonly #sqlite: Database.Database;
  readonly #mutation: ProjectMutationKernel;
  readonly #taskReads: TaskReadModel;
  readonly #maintenance: WorkItemMaintenance;

  constructor(
    sqlite: Database.Database,
    mutation: ProjectMutationKernel,
    taskReads: TaskReadModel,
    maintenance: WorkItemMaintenance,
  ) {
    this.#sqlite = sqlite;
    this.#mutation = mutation;
    this.#taskReads = taskReads;
    this.#maintenance = maintenance;
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

  /**
   * 校验并规划 edit 里的关系替换，不落任何写入。dependsOn 整组替换本任务的 BLOCKS 前置，
   * discoveredFrom 替换来源任务；规则与创建时一致：不能指向自身、不能重复、依赖不能成环。
   */
  #planRelationChange(
    taskId: string,
    patch: { taskKey: string; dependsOn?: string[]; discoveredFrom?: string | null },
  ): RelationChange | null {
    if (patch.dependsOn === undefined && patch.discoveredFrom === undefined) return null;
    const change: RelationChange = { receipt: {} };
    if (patch.dependsOn !== undefined) {
      const keys = patch.dependsOn.map((key) => key.trim().toUpperCase());
      const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
      if (duplicate)
        throw new AtmError("VALIDATION_ERROR", {
          message: `dependsOn 重复引用：${duplicate}`,
          details: { task_key: patch.taskKey, field: "dependsOn", value: duplicate },
        });
      const ids = keys.map((key) => this.#taskReads.rowForTaskKey(key).id as string);
      const dependencies = new Map<string, string[]>();
      for (const edge of this.#sqlite
        .prepare(
          "SELECT source_id, target_id FROM work_item_relations WHERE relation_type = 'BLOCKS'",
        )
        .all() as Array<{ source_id: string; target_id: string }>) {
        dependencies.set(edge.target_id, [
          ...(dependencies.get(edge.target_id) ?? []),
          edge.source_id,
        ]);
      }
      dependencies.set(taskId, ids);
      for (const id of ids) assertAcyclicDependency(taskId, id, dependencies);
      change.dependencyIds = ids;
      change.receipt.dependsOn = keys;
    }
    if (patch.discoveredFrom !== undefined) {
      const originId =
        patch.discoveredFrom === null
          ? null
          : (this.#taskReads.rowForTaskKey(patch.discoveredFrom).id as string);
      if (originId === taskId)
        throw new AtmError("VALIDATION_ERROR", {
          message: "discoveredFrom 不能引用自身",
          details: { task_key: patch.taskKey, field: "discoveredFrom", issue: "self_reference" },
        });
      change.discoveredFromId = originId;
      change.receipt.discoveredFrom = patch.discoveredFrom?.trim().toUpperCase() ?? null;
    }
    return change;
  }

  #applyRelationChange(taskId: string, change: RelationChange, now: string): void {
    const insert = this.#sqlite.prepare(
      `INSERT INTO work_item_relations(source_id, target_id, relation_type, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    if (change.dependencyIds !== undefined) {
      this.#sqlite
        .prepare("DELETE FROM work_item_relations WHERE target_id = ? AND relation_type = 'BLOCKS'")
        .run(taskId);
      for (const dependencyId of change.dependencyIds)
        insert.run(dependencyId, taskId, "BLOCKS", now);
    }
    if (change.discoveredFromId !== undefined) {
      this.#sqlite
        .prepare(
          "DELETE FROM work_item_relations WHERE source_id = ? AND relation_type = 'DISCOVERED_FROM'",
        )
        .run(taskId);
      if (change.discoveredFromId !== null)
        insert.run(taskId, change.discoveredFromId, "DISCOVERED_FROM", now);
    }
  }

  patchWorkItems(
    actor: MutationActor,
    opId: string,
    patches: Array<{
      taskKey: string;
      expectedVersion: number;
      expectedFields?: {
        title?: string;
        description?: string;
        acceptance?: string[];
        targetDate?: string | null;
        parentKey?: string | null;
      };
      operation: WorkItemOperation;
      title?: string;
      description?: string;
      acceptance?: string[];
      blockedReason?: string;
      waitingFor?: string;
      cancelReason?: string;
      duplicateOf?: string | null;
      supersededBy?: string | null;
      assigneeAgentId?: string | null;
      targetDate?: string | null;
      parentKey?: string | null;
      dependsOn?: string[];
      discoveredFrom?: string | null;
      takeoverStale?: boolean;
    }>,
  ): {
    items: WorkItemView[];
    sequence: number;
    merges?: Array<{
      taskKey: string;
      expectedVersion: number;
      actualVersion: number;
      fields: string[];
    }>;
  } {
    if (patches.length === 0 || patches.length > 50)
      throw new AtmError("VALIDATION_ERROR", {
        message: "WorkItem patch 批次数量必须为 1 至 50",
        details: { field: "patches", min: 1, max: 50, actual: patches.length },
      });
    return this.#mutation.mutate({
      actor,
      opId,
      operation: "work.patch.batch",
      request: patches,
      action: () => {
        const result: WorkItemView[] = [];
        const merges: Array<{
          taskKey: string;
          expectedVersion: number;
          actualVersion: number;
          fields: string[];
        }> = [];
        let sequence = this.#projectSequence();
        for (const patch of patches) {
          const row = this.#taskReads.rowForTaskKey(patch.taskKey);
          let mergeReceipt:
            | {
                taskKey: string;
                expectedVersion: number;
                actualVersion: number;
                fields: string[];
              }
            | undefined;
          if (row.version !== patch.expectedVersion) {
            const changedFields = (
              ["title", "description", "acceptance", "targetDate", "parentKey"] as const
            ).filter((field) => patch[field] !== undefined);
            const currentFields = {
              title: row.title as string,
              description: row.description as string,
              acceptance: readJson<string[]>(row.acceptance_json, []),
              targetDate: (row.target_date ?? null) as string | null,
              parentKey: row.parent_id ? this.#taskReads.taskKeyForId(row.parent_id) : null,
            };
            const expectedFields = patch.expectedFields;
            const safeMerge =
              patch.operation === "edit" &&
              patch.assigneeAgentId === undefined &&
              patch.dependsOn === undefined &&
              patch.discoveredFrom === undefined &&
              patch.cancelReason === undefined &&
              patch.duplicateOf === undefined &&
              patch.supersededBy === undefined &&
              changedFields.length > 0 &&
              expectedFields !== undefined &&
              changedFields.every((field) =>
                Object.prototype.hasOwnProperty.call(expectedFields, field),
              ) &&
              Object.entries(expectedFields).every(([field, expected]) =>
                field === "acceptance"
                  ? JSON.stringify(currentFields.acceptance) === JSON.stringify(expected)
                  : currentFields[field as keyof typeof currentFields] === expected,
              );
            if (!safeMerge) {
              throw new AtmError("VERSION_CONFLICT", {
                message: "WorkItem 版本已变化",
                details: {
                  entity: "WORK_ITEM",
                  key: patch.taskKey,
                  expected: patch.expectedVersion,
                  actual: row.version,
                },
              });
            }
            mergeReceipt = {
              taskKey: patch.taskKey,
              expectedVersion: patch.expectedVersion,
              actualVersion: row.version,
              fields: changedFields,
            };
            merges.push(mergeReceipt);
          }
          const updates: string[] = [];
          const values: unknown[] = [];
          let eventType = "work.updated";
          let relationChange: RelationChange | null = null;
          let movedToParentId: string | null | undefined;
          const acceptanceChange =
            patch.operation === "edit" && patch.acceptance !== undefined
              ? {
                  acceptance: {
                    before: readJson<string[]>(row.acceptance_json, []),
                    after: patch.acceptance,
                  },
                }
              : undefined;
          const currentPhase = storedWorkItemPhase(row);
          const successorReclaim =
            patch.operation === "claim" &&
            row.status === "IN_PROGRESS" &&
            row.assignee_agent_id === actor.id;
          const resolvedOperation = resolveStoredWorkItemOperation(patch.operation, row, {
            successorReclaim,
          });
          const targetStatus = resolvedOperation.target;
          let targetPhase = currentPhase;
          const now = nowIso();
          if (patch.operation === "claim" || patch.operation === "start") {
            const dependency = this.#sqlite
              .prepare(
                `SELECT dependency.local_no FROM work_item_relations relation
                 JOIN work_items dependency ON dependency.id = relation.source_id
                 WHERE relation.target_id = ? AND relation.relation_type = 'BLOCKS'
                   AND dependency.status <> 'DONE' LIMIT 1`,
              )
              .get(row.id) as { local_no: number } | undefined;
            if (dependency)
              throw new AtmError("DEPENDENCY_NOT_READY", {
                message: `依赖 WorkItem 尚未完成：${dependency.local_no}`,
                details: { dependency_local_no: dependency.local_no },
              });
            if (row.claimed_by_session_id && row.claimed_by_session_id !== actor.sessionId) {
              const stale =
                row.claim_lease_until && Date.parse(row.claim_lease_until) <= Date.now();
              if (!stale || !patch.takeoverStale)
                throw new AtmError("TASK_ALREADY_CLAIMED", {
                  message: `WorkItem 已被其他 Session 领取：${patch.taskKey}`,
                  details: {
                    task_key: patch.taskKey,
                    claimed_by_session_id: row.claimed_by_session_id,
                    claim_lease_until: row.claim_lease_until,
                  },
                });
            }
            targetPhase = targetStatus as WorkItemPhase;
            updates.push(
              "status = ?",
              "phase = ?",
              "phase_inferred = 0",
              "assignee_agent_id = ?",
              "claimed_by_session_id = ?",
              "claim_lease_until = ?",
            );
            values.push(
              targetStatus,
              targetPhase,
              actor.id,
              actor.sessionId,
              actor.sessionId ? new Date(Date.now() + 10 * 60_000).toISOString() : null,
            );
            if (targetStatus === "IN_PROGRESS" && !row.started_at) {
              updates.push("started_at = ?");
              values.push(now);
            }
            if (targetStatus === "IN_PROGRESS") {
              // 「接着做」意味着阻塞与等待都已不成立。只清任务行上的列而不关
              // blockers 记录，任务会看起来一切正常、却永远完成不了。
              updates.push("blocked_reason = NULL", "waiting_on = NULL", "waiting_for = NULL");
              this.#maintenance.resolveActiveBlockers(row.id, now);
            }
            eventType = targetStatus === "IN_PROGRESS" ? "work.started" : "work.claimed";
          } else if (patch.operation === "release") {
            const stale = row.claim_lease_until && Date.parse(row.claim_lease_until) <= Date.now();
            if (
              row.claimed_by_session_id !== actor.sessionId &&
              !(actor.type === "USER" && stale)
            ) {
              throw new AtmError("CLAIM_OWNER_REQUIRED", {
                message: `只有当前领取者可以释放 WorkItem：${patch.taskKey}`,
                details: {
                  task_key: patch.taskKey,
                  claimed_by_session_id: row.claimed_by_session_id,
                  actor_session_id: actor.sessionId ?? null,
                },
              });
            }
            targetPhase = "READY";
            updates.push(
              "status = 'READY'",
              "phase = 'READY'",
              "phase_inferred = 0",
              "waiting_on = NULL",
              "waiting_for = NULL",
              "assignee_agent_id = NULL",
              "claimed_by_session_id = NULL",
              "claim_lease_until = NULL",
            );
            eventType = "work.released";
          } else if (patch.operation === "ready") {
            targetPhase = "READY";
            updates.push("status = 'READY'", "phase = 'READY'", "phase_inferred = 0");
            eventType = "work.readied";
          } else if (patch.operation === "block") {
            if (!patch.blockedReason?.trim())
              throw new AtmError("BLOCKED_REASON_REQUIRED", {
                message: "阻塞 WorkItem 时必须提供 blockedReason",
                details: { task_key: patch.taskKey, field: "blockedReason" },
              });
            targetPhase = "BLOCKED";
            updates.push(
              "status = 'BLOCKED'",
              "phase = 'BLOCKED'",
              "phase_inferred = 0",
              "waiting_on = NULL",
              "waiting_for = NULL",
              "blocked_reason = ?",
            );
            values.push(patch.blockedReason.trim());
            eventType = "work.blocked";
          } else if (patch.operation === "wait_user" || patch.operation === "wait_agent") {
            if (!patch.waitingFor?.trim())
              throw new AtmError("WAITING_FOR_REQUIRED", {
                message: "等待时必须提供 waitingFor",
                details: { task_key: patch.taskKey, field: "waitingFor" },
              });
            if (row.status === "BLOCKED") {
              // Explicit reclassification, not a synthetic start: keep ownership and
              // started_at, resolve the old blocker, and emit only work.waiting.
              targetPhase = "IN_PROGRESS";
              updates.push("phase = 'IN_PROGRESS'", "phase_inferred = 0", "blocked_reason = NULL");
              this.#maintenance.resolveActiveBlockers(row.id, now);
            }
            updates.push("status = ?", "waiting_on = ?", "waiting_for = ?");
            values.push(
              targetStatus,
              patch.operation === "wait_user" ? "USER" : "AGENT",
              patch.waitingFor.trim(),
            );
            eventType = "work.waiting";
          } else if (patch.operation === "verify") {
            targetPhase = "VERIFYING";
            updates.push(
              "status = 'VERIFYING'",
              "phase = 'VERIFYING'",
              "phase_inferred = 0",
              "waiting_on = NULL",
              "waiting_for = NULL",
            );
            eventType = "work.verification_requested";
          } else if (patch.operation === "complete") {
            assertCompletionGates(this.#sqlite, row);
            targetPhase = "DONE";
            updates.push(
              "status = 'DONE'",
              "phase = 'DONE'",
              "phase_inferred = 0",
              "waiting_on = NULL",
              "waiting_for = NULL",
              "completed_at = ?",
              "computed_progress = 100",
              "reported_progress = 100",
            );
            values.push(now);
            eventType = "work.completed";
          } else if (patch.operation === "cancel") {
            const duplicateOf = patch.duplicateOf
              ? this.#taskReads.rowForTaskKey(patch.duplicateOf)
              : null;
            const supersededBy = patch.supersededBy
              ? this.#taskReads.rowForTaskKey(patch.supersededBy)
              : null;
            if (duplicateOf?.id === row.id || supersededBy?.id === row.id) {
              throw new AtmError("VALIDATION_ERROR", {
                message: "取消 WorkItem 时不能引用自身",
                details: { task_key: patch.taskKey, issue: "self_reference" },
              });
            }
            targetPhase = "CANCELLED";
            updates.push(
              "status = 'CANCELLED'",
              "phase = 'CANCELLED'",
              "phase_inferred = 0",
              "waiting_on = NULL",
              "waiting_for = NULL",
              "cancel_reason = ?",
              "duplicate_of_id = ?",
              "superseded_by_id = ?",
            );
            values.push(
              patch.cancelReason?.trim() ?? null,
              duplicateOf?.id ?? null,
              supersededBy?.id ?? null,
            );
            eventType = "work.cancelled";
          } else if (patch.operation === "reopen") {
            targetPhase = targetStatus as WorkItemPhase;
            // 拉回来之后，阻塞原因和等待条件已经不成立，留着会让界面继续显示旧理由。
            this.#maintenance.resolveActiveBlockers(row.id, now);
            updates.push(
              "status = ?",
              "phase = ?",
              "phase_inferred = 0",
              "completed_at = NULL",
              "blocked_reason = NULL",
              "waiting_on = NULL",
              "waiting_for = NULL",
            );
            values.push(targetStatus, targetPhase);
            eventType = "work.reopened";
          } else if (patch.operation === "edit") {
            for (const [value, column] of [
              [patch.title, "title"],
              [patch.description, "description"],
              [patch.assigneeAgentId, "assignee_agent_id"],
              [patch.targetDate, "target_date"],
            ] as const) {
              if (value !== undefined) {
                updates.push(`${column} = ?`);
                values.push(value);
              }
            }
            if (patch.acceptance !== undefined) {
              updates.push("acceptance_json = ?");
              values.push(JSON.stringify(patch.acceptance));
            }
            if (patch.parentKey !== undefined) {
              const parentId = patch.parentKey
                ? this.#taskReads.rowForTaskKey(patch.parentKey).id
                : null;
              const parents = new Map(
                (this.#sqlite.prepare("SELECT id, parent_id FROM work_items").all() as any[]).map(
                  (candidate) => [candidate.id, candidate.parent_id],
                ),
              );
              assertParentMove(row.id, parentId, parents);
              updates.push("parent_id = ?");
              values.push(parentId);
              movedToParentId = parentId;
              eventType = "work.moved";
            }
            relationChange = this.#planRelationChange(row.id, patch);
            if (relationChange) {
              // 关系不在 work_items 行上，但仍要走版本号：并发改关系的两方必须有一方撞 VERSION_CONFLICT。
              if (eventType === "work.updated") eventType = "work.relations_changed";
            }
          } else {
            throw new AtmError("VALIDATION_ERROR", {
              message: `未知 WorkItem 操作：${patch.operation}`,
              details: { field: "operation", value: patch.operation, issue: "unknown" },
            });
          }
          if (updates.length === 0 && !relationChange)
            throw new AtmError("VALIDATION_ERROR", {
              message: "WorkItem patch 未产生任何变更",
              details: { task_key: patch.taskKey, issue: "empty_patch" },
            });
          updates.push("version = version + 1", "updated_at = ?");
          values.push(now, row.id);
          this.#sqlite
            .prepare(`UPDATE work_items SET ${updates.join(", ")} WHERE id = ?`)
            .run(...values);
          if (relationChange) this.#applyRelationChange(row.id, relationChange, now);
          if (patch.operation === "claim" || patch.operation === "start") {
            this.#maintenance.recordWorkItemLifecycleAt(
              row.id,
              now,
              targetStatus === "IN_PROGRESS",
            );
          }
          if (actor.sessionId) {
            if (workItemOperationHasEffect(patch.operation, "SESSION_WORKING")) {
              this.#sqlite
                .prepare(
                  `UPDATE agent_sessions SET current_work_item_id = ?, work_state = 'WORKING',
                   heartbeat_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
                )
                .run(row.id, now, now, actor.sessionId);
            } else if (workItemOperationHasEffect(patch.operation, "SESSION_WAITING")) {
              this.#sqlite
                .prepare(
                  `UPDATE agent_sessions SET current_work_item_id = ?, work_state = 'WAITING',
                   heartbeat_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
                )
                .run(row.id, now, now, actor.sessionId);
            } else if (workItemOperationHasEffect(patch.operation, "SESSION_IDLE")) {
              this.#sqlite
                .prepare(
                  `UPDATE agent_sessions SET current_work_item_id = NULL, work_state = 'IDLE',
                   heartbeat_at = ?, updated_at = ?, version = version + 1
                   WHERE id = ? AND current_work_item_id = ?`,
                )
                .run(now, now, actor.sessionId, row.id);
            }
          }
          if (patch.operation === "edit") {
            const searchRow = this.#sqlite
              .prepare("SELECT title, description FROM work_items WHERE id = ?")
              .get(row.id) as { title: string; description: string };
            this.#maintenance.upsertSearchDocument(
              "WORK_ITEM",
              row.id,
              patch.taskKey,
              searchRow.title,
              searchRow.description,
            );
          }
          sequence = this.#mutation.appendEvent(eventType, actor, "WORK_ITEM", row.id, {
            key: patch.taskKey,
            title: row.title,
            operation: patch.operation,
            status: targetStatus,
            phase: targetPhase,
            ...(mergeReceipt === undefined ? {} : { mergedAcrossVersion: mergeReceipt }),
            ...(acceptanceChange === undefined ? {} : { changes: acceptanceChange }),
            ...(relationChange === null ? {} : { relations: relationChange.receipt }),
            ...(patch.operation === "cancel"
              ? {
                  cancelReason: patch.cancelReason?.trim() ?? null,
                  duplicateOf: patch.duplicateOf ?? null,
                  supersededBy: patch.supersededBy ?? null,
                }
              : {}),
            waitingOn:
              patch.operation === "wait_agent"
                ? "AGENT"
                : patch.operation === "wait_user"
                  ? "USER"
                  : null,
          });
          if (row.parent_id) this.#maintenance.recomputeWorkItem(row.parent_id);
          // 挪到新父任务下之后，新父任务的聚合进度同样要重算，否则要等下一次无关写入才对上。
          if (movedToParentId && movedToParentId !== row.parent_id)
            this.#maintenance.recomputeWorkItem(movedToParentId);
          const updated = this.#sqlite.prepare("SELECT * FROM work_items WHERE id = ?").get(row.id);
          result.push(this.#taskReads.workItemViewFromRow(updated));
        }
        return { items: result, sequence, ...(merges.length === 0 ? {} : { merges }) };
      },
    });
  }

  verifyAndComplete(
    actor: MutationActor,
    opId: string,
    input: { taskKey: string; expectedVersion: number },
  ): {
    taskKey: string;
    fromStatus: WorkItemStatus;
    status: "DONE";
    fromVersion: number;
    taskVersion: number;
    transitions: Array<"VERIFYING" | "DONE">;
    item: WorkItemView;
    sequence: number;
  } {
    return this.#mutation.mutate({
      actor,
      opId,
      operation: "work.verify-and-complete",
      request: input,
      immediate: true,
      action: () => {
        const initial = this.#taskReads.rowForTaskKey(input.taskKey);
        if (initial.version !== input.expectedVersion) {
          throw new AtmError("VERSION_CONFLICT", {
            message: "WorkItem 版本已变化",
            details: {
              entity: "WORK_ITEM",
              key: input.taskKey,
              expected: input.expectedVersion,
              actual: initial.version,
            },
          });
        }
        const fromStatus = initial.status as WorkItemStatus;
        const fromVersion = Number(initial.version);
        const transitions: Array<"VERIFYING" | "DONE"> = [];
        const now = nowIso();
        let sequence = this.#projectSequence();
        let verificationSequence: number | null = null;
        let verifying = initial;

        if (fromStatus !== "VERIFYING") {
          resolveStoredWorkItemOperation("verify", initial);
          this.#sqlite
            .prepare(
              `UPDATE work_items SET status = 'VERIFYING', phase = 'VERIFYING', phase_inferred = 0,
               waiting_on = NULL, waiting_for = NULL, version = version + 1, updated_at = ?
               WHERE id = ?`,
            )
            .run(now, initial.id);
          if (actor.sessionId) {
            this.#sqlite
              .prepare(
                `UPDATE agent_sessions SET current_work_item_id = ?, work_state = 'WORKING',
                 heartbeat_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
              )
              .run(initial.id, now, now, actor.sessionId);
          }
          sequence = this.#mutation.appendEvent(
            "work.verification_requested",
            actor,
            "WORK_ITEM",
            initial.id,
            {
              key: input.taskKey,
              title: initial.title,
              operation: "verify_and_complete",
              status: "VERIFYING",
              phase: "VERIFYING",
              composite: true,
            },
          );
          verificationSequence = sequence;
          transitions.push("VERIFYING");
          verifying = this.#sqlite
            .prepare("SELECT * FROM work_items WHERE id = ?")
            .get(initial.id) as any;
        }

        resolveStoredWorkItemOperation("complete", verifying);
        assertCompletionGates(this.#sqlite, verifying);
        this.#sqlite
          .prepare(
            `UPDATE work_items SET status = 'DONE', phase = 'DONE', phase_inferred = 0,
             waiting_on = NULL, waiting_for = NULL, completed_at = ?, computed_progress = 100,
             reported_progress = 100, version = version + 1, updated_at = ? WHERE id = ?`,
          )
          .run(now, now, initial.id);
        if (actor.sessionId) {
          this.#sqlite
            .prepare(
              `UPDATE agent_sessions SET current_work_item_id = NULL, work_state = 'IDLE',
               heartbeat_at = ?, updated_at = ?, version = version + 1
               WHERE id = ? AND current_work_item_id = ?`,
            )
            .run(now, now, actor.sessionId, initial.id);
        }
        sequence = this.#mutation.appendEvent("work.completed", actor, "WORK_ITEM", initial.id, {
          key: input.taskKey,
          title: initial.title,
          operation: "verify_and_complete",
          status: "DONE",
          phase: "DONE",
          composite: true,
          ...(verificationSequence === null ? {} : { verificationSequence }),
        });
        transitions.push("DONE");
        if (initial.parent_id) this.#maintenance.recomputeWorkItem(initial.parent_id);
        const updated = this.#sqlite
          .prepare("SELECT * FROM work_items WHERE id = ?")
          .get(initial.id);
        const item = this.#taskReads.workItemViewFromRow(updated);
        return {
          taskKey: input.taskKey,
          fromStatus,
          status: "DONE",
          fromVersion,
          taskVersion: item.version,
          transitions,
          item,
          sequence,
        };
      },
    });
  }
}
