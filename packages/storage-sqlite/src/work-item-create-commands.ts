import type Database from "better-sqlite3";
import { assertAcyclicDependency, assertParentMove } from "@ayanami-task/domain";
import { AtmError } from "@ayanami-task/errors";
import { createUlid, nowIso, type WorkItemStatus } from "@ayanami-task/protocol";
import type { WorkItemView } from "./read-model-types.js";
import { PlanningCommands } from "./planning-commands.js";
import { ProjectMutationKernel, type MutationActor } from "./project-mutation-kernel.js";
import { TaskReadModel } from "./task-read-model.js";
import { WorkItemMaintenance } from "./work-item-maintenance.js";

export type WorkItemCreateCommandInput = {
  clientRef: string;
  objectiveId?: string;
  milestoneId?: string | null;
  parentKey?: string | null;
  parentRef?: string | null;
  dependsOn?: string[];
  dependsOnRefs?: string[];
  discoveredFrom?: string;
  discoveredFromRef?: string;
  title: string;
  description?: string;
  type: string;
  priority: string;
  status?: WorkItemStatus;
  acceptance?: string[];
  checklist?: Array<{ title: string; evidenceRequired?: boolean; weight?: number }>;
  weight?: number;
  targetDate?: string | null;
  verificationRequired?: boolean;
  sourceQuickId?: string | null;
  assigneeAgentId?: string | null;
};

export type WorkItemPlanningRootCommand = {
  provisionIfMissing: boolean;
  objectiveTitle: string;
  objectiveDescription: string;
  milestoneTitle: string;
};

export class WorkItemCreateCommands {
  readonly #sqlite: Database.Database;
  readonly #mutation: ProjectMutationKernel;
  readonly #planning: PlanningCommands;
  readonly #taskReads: TaskReadModel;
  readonly #maintenance: WorkItemMaintenance;
  readonly #projectCode: string;

  constructor(
    sqlite: Database.Database,
    mutation: ProjectMutationKernel,
    planning: PlanningCommands,
    taskReads: TaskReadModel,
    maintenance: WorkItemMaintenance,
  ) {
    this.#sqlite = sqlite;
    this.#mutation = mutation;
    this.#planning = planning;
    this.#taskReads = taskReads;
    this.#maintenance = maintenance;
    this.#projectCode = String(
      (
        sqlite.prepare("SELECT project_code FROM project_meta WHERE singleton = 1").get() as {
          project_code: string;
        }
      ).project_code,
    );
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

  createWorkItems(
    actor: MutationActor,
    opId: string,
    items: WorkItemCreateCommandInput[],
    planningRoot?: WorkItemPlanningRootCommand,
  ): { items: WorkItemView[]; sequence: number; planningRootProvisioned: boolean } {
    return this.#mutation.mutate({
      actor,
      opId,
      operation: "work.create.batch",
      // Planning-root policy is server-derived; idempotency is bound to the caller's task batch.
      request: items,
      immediate: true,
      action: () => {
        if (items.length === 0 || items.length > 50) {
          throw new AtmError("VALIDATION_ERROR", {
            message: "WorkItem 批次数量必须为 1 至 50",
            details: { field: "items", min: 1, max: 50, actual: items.length },
          });
        }
        if (new Set(items.map((item) => item.clientRef)).size !== items.length) {
          throw new AtmError("VALIDATION_ERROR", {
            message: "WorkItem 批次包含重复 clientRef",
            details: { field: "clientRef", issue: "duplicate" },
          });
        }

        /*
         * Build and validate the complete prospective graph before incrementing a counter or
         * inserting the optional planning root. This deliberately supports forward refs: the
         * validation result must not depend on the order in which a caller serialized the batch.
         */
        const code = this.#projectCode;
        const activeObjective = planningRoot ? this.#planning.getActiveObjective() : null;
        const needsDefaultObjective = items.some((item) => item.objectiveId === undefined);
        const plannedObjective =
          planningRoot?.provisionIfMissing && needsDefaultObjective && !activeObjective
            ? { id: createUlid() }
            : null;
        const defaultObjectiveId = String(activeObjective?.id ?? plannedObjective?.id ?? "");
        if (needsDefaultObjective && !defaultObjectiveId) {
          throw new AtmError("OBJECTIVE_REQUIRED", { message: "项目尚无活动目标" });
        }

        const activeDefaultMilestone = defaultObjectiveId
          ? this.#planning.getActiveMilestone(defaultObjectiveId)
          : null;
        const plannedMilestone =
          planningRoot?.provisionIfMissing &&
          needsDefaultObjective &&
          defaultObjectiveId &&
          !activeDefaultMilestone
            ? { id: createUlid(), objectiveId: defaultObjectiveId }
            : null;
        const defaultMilestoneId = activeDefaultMilestone?.id ?? plannedMilestone?.id ?? null;

        const objectiveRows = new Map<string, { id: string }>();
        if (plannedObjective) objectiveRows.set(plannedObjective.id, plannedObjective);
        const objective = (objectiveId: string): { id: string } => {
          const cached = objectiveRows.get(objectiveId);
          if (cached) return cached;
          const row = this.#sqlite
            .prepare("SELECT id FROM objectives WHERE id = ?")
            .get(objectiveId) as { id: string } | undefined;
          if (!row)
            throw new AtmError("OBJECTIVE_NOT_FOUND", {
              message: `目标不存在：${objectiveId}`,
              details: { entity: "OBJECTIVE", reference: objectiveId },
            });
          objectiveRows.set(objectiveId, row);
          return row;
        };

        const milestoneRows = new Map<string, { id: string; objectiveId: string }>();
        if (plannedMilestone) milestoneRows.set(plannedMilestone.id, plannedMilestone);
        const milestone = (milestoneId: string): { id: string; objectiveId: string } => {
          const cached = milestoneRows.get(milestoneId);
          if (cached) return cached;
          const row = this.#sqlite
            .prepare("SELECT id, objective_id FROM milestones WHERE id = ?")
            .get(milestoneId) as { id: string; objective_id: string } | undefined;
          if (!row)
            throw new AtmError("MILESTONE_NOT_FOUND", {
              message: `里程碑不存在：${milestoneId}`,
              details: { entity: "MILESTONE", reference: milestoneId },
            });
          const normalized = { id: row.id, objectiveId: row.objective_id };
          milestoneRows.set(milestoneId, normalized);
          return normalized;
        };

        type PlannedItem = {
          input: WorkItemCreateCommandInput;
          id: string;
          key: string;
          objectiveId: string;
          milestoneId: string | null;
          parentId: string | null;
          dependencyIds: string[];
          discoveredFromId: string | null;
          discoveredFromKey: string | null;
          status: WorkItemStatus;
          createdAt: string;
        };

        const plannedByRef = new Map<string, PlannedItem>();
        const planned = items.map((item) => {
          const itemObjectiveId = item.objectiveId ?? defaultObjectiveId;
          objective(itemObjectiveId);
          let itemMilestoneId: string | null;
          if (item.milestoneId !== undefined) {
            itemMilestoneId = item.milestoneId;
          } else if (!planningRoot) {
            itemMilestoneId = null;
          } else if (item.objectiveId === undefined) {
            itemMilestoneId = defaultMilestoneId;
          } else {
            itemMilestoneId = this.#planning.getActiveMilestone(itemObjectiveId)?.id ?? null;
          }
          if (itemMilestoneId) {
            const selectedMilestone = milestone(itemMilestoneId);
            if (selectedMilestone.objectiveId !== itemObjectiveId) {
              throw new AtmError("MILESTONE_OBJECTIVE_MISMATCH", {
                message: `里程碑 ${itemMilestoneId} 不属于目标 ${itemObjectiveId}`,
                details: {
                  milestone_id: itemMilestoneId,
                  objective_id: itemObjectiveId,
                  actual_objective_id: selectedMilestone.objectiveId,
                },
              });
            }
          }
          const entry: PlannedItem = {
            input: item,
            id: createUlid(),
            key: "",
            objectiveId: itemObjectiveId,
            milestoneId: itemMilestoneId,
            parentId: null,
            dependencyIds: [],
            discoveredFromId: null,
            discoveredFromKey: null,
            status: item.status ?? "BACKLOG",
            createdAt: nowIso(),
          };
          plannedByRef.set(item.clientRef, entry);
          return entry;
        });

        const existingByKey = new Map<string, any>();
        const taskForKey = (taskKey: string): any => {
          const cached = existingByKey.get(taskKey);
          if (cached) return cached;
          const row = this.#taskReads.rowForTaskKey(taskKey);
          existingByKey.set(taskKey, row);
          return row;
        };

        for (const entry of planned) {
          const item = entry.input;
          const hasParentRef = item.parentRef !== undefined && item.parentRef !== null;
          const hasParentKey = item.parentKey !== undefined && item.parentKey !== null;
          if (hasParentRef && hasParentKey) {
            throw new AtmError("VALIDATION_ERROR", {
              message: "parentKey 与 parentRef 不能同时提供",
              details: { fields: ["parentKey", "parentRef"], issue: "mutually_exclusive" },
            });
          }
          if (hasParentRef) {
            const parent = plannedByRef.get(String(item.parentRef));
            if (!parent)
              throw new AtmError("PARENT_REF_NOT_FOUND", {
                message: `父 WorkItem 引用不存在：${item.parentRef}`,
                details: { reference: item.parentRef },
              });
            entry.parentId = parent.id;
          } else if (hasParentKey) {
            entry.parentId = String(taskForKey(String(item.parentKey)).id);
          }

          const dependencyIds = [
            ...(item.dependsOn ?? []).map((taskKey) => String(taskForKey(taskKey).id)),
            ...(item.dependsOnRefs ?? []).map((reference) => {
              const dependency = plannedByRef.get(reference);
              if (!dependency)
                throw new AtmError("DEPENDENCY_REF_NOT_FOUND", {
                  message: `依赖 WorkItem 引用不存在：${reference}`,
                  details: { reference },
                });
              return dependency.id;
            }),
          ];
          if (new Set(dependencyIds).size !== dependencyIds.length) {
            throw new AtmError("VALIDATION_ERROR", {
              message: `WorkItem ${item.clientRef} 包含重复依赖`,
              details: { client_ref: item.clientRef, field: "dependencies", issue: "duplicate" },
            });
          }
          entry.dependencyIds = dependencyIds;

          const hasDiscoveredRef = item.discoveredFromRef !== undefined;
          const hasDiscoveredKey = item.discoveredFrom !== undefined;
          if (hasDiscoveredRef && hasDiscoveredKey) {
            throw new AtmError("VALIDATION_ERROR", {
              message: "discoveredFrom 与 discoveredFromRef 不能同时提供",
              details: {
                fields: ["discoveredFrom", "discoveredFromRef"],
                issue: "mutually_exclusive",
              },
            });
          }
          if (hasDiscoveredRef) {
            const source = plannedByRef.get(String(item.discoveredFromRef));
            if (!source) {
              throw new AtmError("DISCOVERED_FROM_REF_NOT_FOUND", {
                message: `发现来源引用不存在：${item.discoveredFromRef}`,
                details: { reference: item.discoveredFromRef },
              });
            }
            entry.discoveredFromId = source.id;
            entry.discoveredFromKey = source.key;
          } else if (hasDiscoveredKey) {
            const source = taskForKey(String(item.discoveredFrom));
            entry.discoveredFromId = String(source.id);
            entry.discoveredFromKey = String(item.discoveredFrom);
          }
          if (entry.discoveredFromId === entry.id) {
            throw new AtmError("VALIDATION_ERROR", {
              message: "WorkItem 不能将自身设为发现来源",
              details: { client_ref: item.clientRef, issue: "self_reference" },
            });
          }
        }

        const parents = new Map<string, string | null>(
          (
            this.#sqlite.prepare("SELECT id, parent_id FROM work_items").all() as Array<{
              id: string;
              parent_id: string | null;
            }>
          ).map((row) => [row.id, row.parent_id]),
        );
        for (const entry of planned) parents.set(entry.id, entry.parentId);
        for (const entry of planned) assertParentMove(entry.id, entry.parentId, parents);

        const dependencies = new Map<string, string[]>();
        for (const row of this.#sqlite
          .prepare(
            "SELECT source_id, target_id FROM work_item_relations WHERE relation_type = 'BLOCKS'",
          )
          .all() as Array<{ source_id: string; target_id: string }>) {
          dependencies.set(row.target_id, [
            ...(dependencies.get(row.target_id) ?? []),
            row.source_id,
          ]);
        }
        for (const entry of planned) dependencies.set(entry.id, entry.dependencyIds);
        for (const entry of planned) {
          for (const dependencyId of entry.dependencyIds) {
            assertAcyclicDependency(entry.id, dependencyId, dependencies);
          }
        }

        // No persistent mutation occurs above this line.
        let planningRootProvisioned = false;
        if (plannedObjective) {
          const now = nowIso();
          const localNo = this.#mutation.nextNumber("objective");
          this.#sqlite
            .prepare(
              `INSERT INTO objectives(
                 id, local_no, title, description, definition_of_done_json, status, weight,
                 version, created_at, updated_at
               ) VALUES (?, ?, ?, ?, '[]', 'ACTIVE', 1, 0, ?, ?)`,
            )
            .run(
              plannedObjective.id,
              localNo,
              planningRoot!.objectiveTitle,
              planningRoot!.objectiveDescription,
              now,
              now,
            );
          this.#mutation.appendEvent("objective.created", actor, "OBJECTIVE", plannedObjective.id, {
            localNo,
            title: planningRoot!.objectiveTitle,
          });
          planningRootProvisioned = true;
        }
        if (plannedMilestone) {
          const now = nowIso();
          const localNo = this.#mutation.nextNumber("milestone");
          const sortKey = (
            this.#sqlite
              .prepare("SELECT COALESCE(MAX(sort_key), 0) + 1000 AS value FROM milestones")
              .get() as { value: number }
          ).value;
          this.#sqlite
            .prepare(
              `INSERT INTO milestones(
                 id, local_no, objective_id, title, description, target_date, status, weight,
                 sort_key, version, created_at, updated_at
               ) VALUES (?, ?, ?, ?, '', NULL, 'ACTIVE', 1, ?, 0, ?, ?)`,
            )
            .run(
              plannedMilestone.id,
              localNo,
              plannedMilestone.objectiveId,
              planningRoot!.milestoneTitle,
              sortKey,
              now,
              now,
            );
          this.#mutation.appendEvent("milestone.created", actor, "MILESTONE", plannedMilestone.id, {
            localNo,
            title: planningRoot!.milestoneTitle,
          });
        }

        const references = new Map<string, { id: string; key: string }>();
        for (const item of items) {
          const entry = plannedByRef.get(item.clientRef)!;
          const localNo = this.#mutation.nextNumber("work_item");
          const key = `${code}-T-${String(localNo).padStart(4, "0")}`;
          entry.key = key;
          const status = entry.status;
          const phase =
            status === "WAITING_AGENT" || status === "WAITING_USER" ? "IN_PROGRESS" : status;
          const waitingOn =
            status === "WAITING_AGENT" ? "AGENT" : status === "WAITING_USER" ? "USER" : null;
          const sortKey = localNo * 1000;
          this.#sqlite
            .prepare(
              `INSERT INTO work_items(
                 id, local_no, parent_id, objective_id, milestone_id, type, title, description,
                 acceptance_json, status, phase, waiting_on, phase_inferred,
                 priority, sort_key, target_date, reported_progress,
                 computed_progress, progress_source, weight, verification_required, version,
                 created_by_agent_id, created_by_session_id, created_at, updated_at, source_quick_id,
                 assignee_agent_id
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, 0, 'NONE', ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              entry.id,
              localNo,
              null,
              entry.objectiveId,
              entry.milestoneId,
              item.type,
              item.title,
              item.description ?? "",
              JSON.stringify(item.acceptance ?? []),
              status,
              phase,
              waitingOn,
              item.priority,
              sortKey,
              item.targetDate ?? null,
              item.weight ?? 1,
              item.verificationRequired ? 1 : 0,
              actor.id,
              actor.sessionId,
              entry.createdAt,
              entry.createdAt,
              item.sourceQuickId ?? null,
              item.assigneeAgentId ?? null,
            );
          for (const checklist of item.checklist ?? []) {
            this.#sqlite
              .prepare(
                `INSERT INTO checklist_items(
                   id, work_item_id, title, kind, status, weight, evidence_required,
                   evidence_json, version, created_at, updated_at
                 ) VALUES (?, ?, ?, 'ACCEPTANCE', 'TODO', ?, ?, '[]', 0, ?, ?)`,
              )
              .run(
                createUlid(),
                entry.id,
                checklist.title,
                checklist.weight ?? 1,
                checklist.evidenceRequired ? 1 : 0,
                entry.createdAt,
                entry.createdAt,
              );
          }
          references.set(item.clientRef, { id: entry.id, key });
        }

        for (const entry of planned) {
          if (entry.parentId) {
            this.#sqlite
              .prepare("UPDATE work_items SET parent_id = ? WHERE id = ?")
              .run(entry.parentId, entry.id);
          }
          for (const dependencyId of entry.dependencyIds) {
            this.#sqlite
              .prepare(
                `INSERT INTO work_item_relations(source_id, target_id, relation_type, created_at)
                 VALUES (?, ?, 'BLOCKS', ?)`,
              )
              .run(dependencyId, entry.id, entry.createdAt);
          }
          if (entry.discoveredFromId) {
            this.#sqlite
              .prepare(
                `INSERT INTO work_item_relations(source_id, target_id, relation_type, created_at)
                 VALUES (?, ?, 'DISCOVERED_FROM', ?)`,
              )
              .run(entry.id, entry.discoveredFromId, entry.createdAt);
          }
        }

        for (const entry of planned) {
          const reference = references.get(entry.input.clientRef)!;
          this.#maintenance.upsertSearchDocument(
            "WORK_ITEM",
            entry.id,
            reference.key,
            entry.input.title,
            entry.input.description ?? "",
          );
          this.#maintenance.recomputeWorkItem(entry.id);
          if (entry.discoveredFromId)
            this.#maintenance.refreshWorkItemSearchDocument(entry.discoveredFromId);
        }

        let sequence = this.#projectSequence();
        for (const entry of planned) {
          const reference = references.get(entry.input.clientRef)!;
          const discoveredFromKey = entry.input.discoveredFromRef
            ? references.get(entry.input.discoveredFromRef)?.key
            : entry.discoveredFromKey;
          sequence = this.#mutation.appendEvent("work.created", actor, "WORK_ITEM", entry.id, {
            key: reference.key,
            title: entry.input.title,
            status: entry.status,
            ...(discoveredFromKey ? { discoveredFrom: discoveredFromKey } : {}),
          });
        }

        return {
          items: planned.map((entry) =>
            this.#taskReads.workItemViewFromRow(
              this.#sqlite.prepare("SELECT * FROM work_items WHERE id = ?").get(entry.id),
            ),
          ),
          sequence,
          planningRootProvisioned,
        };
      },
    });
  }
}
