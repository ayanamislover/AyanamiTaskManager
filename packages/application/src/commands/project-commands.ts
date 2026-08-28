import { AtmError } from "@ayanami-task/errors";
import {
  type AyanamiDatabaseManager,
  type ProjectActor,
  type ProjectionReceipt,
  type RegisteredProject,
} from "@ayanami-task/storage-sqlite";
import { parseAgentTaskMarkdown } from "../agenttask-import.js";
import type { ProjectionCoordinator } from "../coordinators/projection-coordinator.js";
import type { ApplicationServiceRuntime } from "../runtime/service-runtime.js";
import { projectMutationReceipt } from "./command-results.js";

type CreateProjectInput = {
  name: string;
  sourcePath: string | null;
  code?: string;
  description?: string;
  coordinationMode?: "SOLO" | "AUTO" | "MULTI";
  creationReason?: string;
  creationSignals?: Record<string, unknown>;
};

export class ProjectCommands {
  readonly #runtime: ApplicationServiceRuntime;
  readonly #projection: ProjectionCoordinator;

  constructor(runtime: ApplicationServiceRuntime, projection: ProjectionCoordinator) {
    this.#runtime = runtime;
    this.#projection = projection;
  }

  async createProject(input: CreateProjectInput): Promise<RegisteredProject> {
    const project = await this.#runtime.databases.createProject(input);
    this.#runtime.emitGlobal();
    return project;
  }

  attachProjectPath(projectCode: string, path: string, primary = true) {
    const project = this.#runtime.databases.attachProjectPath(projectCode, path, {
      primary,
      actor: "USER",
    });
    this.#runtime.emitGlobal();
    return project;
  }

  createSavedView(input: Parameters<AyanamiDatabaseManager["createSavedView"]>[0]) {
    const result = this.#runtime.databases.createSavedView(input);
    this.#runtime.emitGlobal();
    return result;
  }

  updateSavedView(id: string, input: Parameters<AyanamiDatabaseManager["updateSavedView"]>[1]) {
    const result = this.#runtime.databases.updateSavedView(id, input);
    this.#runtime.emitGlobal();
    return result;
  }

  deleteSavedView(id: string, expectedVersion: number) {
    const result = this.#runtime.databases.deleteSavedView(id, expectedVersion);
    this.#runtime.emitGlobal();
    return result;
  }

  setSetting(key: string, value: unknown, expectedVersion?: number) {
    const result = this.#runtime.databases.setSetting(key, value, expectedVersion);
    this.#runtime.emitGlobal();
    return result;
  }

  runMaintenance(at?: Date) {
    return this.#runtime.databases.runMaintenance(at);
  }

  async archiveProject(projectCode: string, actor = "USER") {
    await this.#runtime.databases.createBackup({
      scope: "PROJECT",
      project: projectCode,
      reason: "PRE_ARCHIVE",
    });
    const result = this.#runtime.databases.setProjectLifecycle(projectCode, "ARCHIVED", actor);
    this.#runtime.emitGlobal();
    return result;
  }

  restoreProject(projectCode: string, actor = "USER") {
    const result = this.#runtime.databases.setProjectLifecycle(projectCode, "ACTIVE", actor);
    this.#runtime.emitGlobal();
    return result;
  }

  async trashProject(projectCode: string, actor = "USER") {
    await this.#runtime.databases.createBackup({
      scope: "PROJECT",
      project: projectCode,
      reason: "PRE_TRASH",
    });
    const result = this.#runtime.databases.setProjectLifecycle(projectCode, "TRASHED", actor);
    this.#runtime.emitGlobal();
    return result;
  }

  async createBackup(input: Parameters<AyanamiDatabaseManager["createBackup"]>[0]) {
    const result = await this.#runtime.databases.createBackup(input);
    this.#runtime.emitGlobal();
    return result;
  }

  async restoreBackup(backupId: string) {
    const result = await this.#runtime.databases.restoreBackup(backupId);
    this.#runtime.dropRepository(result.project.id);
    this.#runtime.emitProject(result.project.code);
    this.#runtime.emitGlobal();
    return result;
  }

  exportProject(projectCode: string, format: "aytproj" | "json" | "csv" = "aytproj") {
    return this.#runtime.databases.exportProject(projectCode, format);
  }

  previewAgentTaskImport(projectCode: string, content: string, sourceName = "agenttask.md") {
    const project = this.#runtime.databases.getProject(projectCode);
    const plan = parseAgentTaskMarkdown(content, sourceName);
    return {
      ...plan,
      project: { id: project.id, code: project.code, name: project.name },
      alreadyImported: Boolean(this.#runtime.databases.getImportHistory(project.id, plan.sha256)),
      objectiveCount: plan.objectives.length,
      milestoneCount: plan.milestones.length,
      taskCount: plan.tasks.length,
      recordCount: plan.records.length,
    };
  }

  async applyAgentTaskImport(
    projectCode: string,
    content: string,
    sourceName = "agenttask.md",
    expectedSha256?: string,
  ): Promise<Record<string, unknown>> {
    const project = this.#runtime.databases.getProject(projectCode);
    const plan = parseAgentTaskMarkdown(content, sourceName);
    if (expectedSha256 && expectedSha256 !== plan.sha256) {
      throw new AtmError("IMPORT_SOURCE_CHANGED", {
        message: "源文件已在预览后发生变化",
        httpStatus: 409,
      });
    }
    const existing = this.#runtime.databases.getImportHistory(project.id, plan.sha256);
    if (existing) return { ...existing, alreadyImported: true };

    const repository = await this.#runtime.repository(project.code);
    const actor: ProjectActor = { type: "USER", id: "USER", sessionId: null };
    const objectiveIds = new Map<string, string>();
    for (const objective of plan.objectives) {
      const created = repository.createObjective(
        actor,
        {
          title: objective.title,
          description: `从 ${sourceName} 第 ${objective.line} 行导入`,
          definitionOfDone: [],
        },
        `import-${plan.sha256}-objective-${objective.ref}`,
      );
      objectiveIds.set(objective.ref, created.id);
    }
    const milestoneIds = new Map<string, string>();
    for (const milestone of plan.milestones) {
      const objectiveId = objectiveIds.get(milestone.objectiveRef);
      if (!objectiveId) {
        throw new AtmError("IMPORT_OBJECTIVE_MISSING", {
          message: `导入目标不存在：${milestone.objectiveRef}`,
          details: { reference: milestone.objectiveRef },
          httpStatus: 422,
        });
      }
      const created = repository.createMilestone(
        actor,
        {
          objectiveId,
          title: milestone.title,
          description: `从 ${sourceName} 第 ${milestone.line} 行导入`,
        },
        `import-${plan.sha256}-milestone-${milestone.ref}`,
      );
      milestoneIds.set(milestone.ref, created.id);
    }
    if (plan.tasks.length > 0) {
      repository.createWorkItems(
        actor,
        `import-${plan.sha256}-tasks`,
        plan.tasks.map((task) => {
          const objectiveId = objectiveIds.get(task.objectiveRef);
          if (!objectiveId) {
            throw new AtmError("IMPORT_OBJECTIVE_MISSING", {
              message: `导入目标不存在：${task.objectiveRef}`,
              details: { reference: task.objectiveRef },
              httpStatus: 422,
            });
          }
          return {
            clientRef: task.ref,
            objectiveId,
            milestoneId: task.milestoneRef ? (milestoneIds.get(task.milestoneRef) ?? null) : null,
            title: task.title,
            description: `从 ${sourceName} 第 ${task.line} 行导入`,
            type: "TASK",
            priority: "NORMAL",
            status: task.completed ? ("DONE" as const) : ("READY" as const),
            acceptance: [],
            checklist: [],
            verificationRequired: false,
          };
        }),
      );
    }
    for (const [index, record] of plan.records.entries()) {
      repository.createRecord(actor, `import-${plan.sha256}-record-${index}`, {
        kind: "REFERENCE",
        title: record.title,
        summary: record.title,
        detail: `${record.detail}\n来源：${sourceName}`,
        importance: "NORMAL",
        scope: "PROJECT",
        sourceType: "IMPORT",
        sourceActorId: "USER",
        sourceSessionId: null,
        sourceRef: sourceName,
      });
    }
    const projection = await this.#projection.flush(project.code);
    const result = {
      sourceName,
      sha256: plan.sha256,
      importedObjectives: plan.objectives.length,
      importedMilestones: plan.milestones.length,
      importedTasks: plan.tasks.length,
      importedRecords: plan.records.length,
      warnings: plan.warnings,
      alreadyImported: false,
    };
    this.#runtime.databases.recordImport(project.id, plan.sha256, result);
    return projectMutationReceipt(result, projection);
  }

  createQuickTask(input: Parameters<AyanamiDatabaseManager["createQuickTask"]>[0]) {
    const result = this.#runtime.databases.createQuickTask(input);
    this.#runtime.emitGlobal();
    return result;
  }

  updateQuickTask(
    idOrKey: string,
    input: Parameters<AyanamiDatabaseManager["updateQuickTask"]>[1],
  ) {
    const result = this.#runtime.databases.updateQuickTask(idOrKey, input);
    this.#runtime.emitGlobal();
    return result;
  }

  async promoteQuickTask(
    input: {
      quickTask: string;
      expectedVersion: number;
      targetProjectCode?: string;
      actor?: string;
    },
    createProject: (input: CreateProjectInput) => Promise<RegisteredProject>,
  ) {
    const quick = this.#runtime.databases.getQuickTask(input.quickTask);
    if (quick.status === "PROMOTED") return quick;
    const project = input.targetProjectCode
      ? this.#runtime.databases.getProject(input.targetProjectCode)
      : await createProject({
          name: quick.title,
          sourcePath: null,
          description: quick.note,
          creationReason: `Quick Task ${quick.key} 晋升`,
          creationSignals: { sourceQuickTask: quick.id },
        });
    const repository = await this.#runtime.repository(project.code);
    const actor: ProjectActor = { type: "SYSTEM", id: input.actor ?? "SYSTEM", sessionId: null };
    const objective =
      repository.getActiveObjective() ??
      repository.createObjective(actor, {
        title: quick.title,
        description: quick.note,
        definitionOfDone: [],
      });
    const milestone =
      repository.getActiveMilestone(objective.id) ??
      repository.createMilestone(actor, { objectiveId: objective.id, title: "执行" });
    const created = repository.createWorkItems(actor, `promote-${quick.id}`, [
      {
        clientRef: "quick-root",
        objectiveId: objective.id,
        milestoneId: milestone.id,
        title: quick.title,
        description: quick.note,
        type: "TASK",
        priority: "NORMAL",
        status: quick.status === "IN_PROGRESS" ? "IN_PROGRESS" : "READY",
        acceptance: [],
        checklist: [],
        sourceQuickId: quick.id,
      },
    ]);
    const result = this.#runtime.databases.markQuickPromoted(
      quick.id,
      input.expectedVersion,
      project.id,
      created.items[0]!.key,
      input.actor,
    );
    const projection = await this.#projection.flush(project.code);
    return projectMutationReceipt(result, projection);
  }

  async ensurePlanningRoot(
    projectCode: string,
    sessionId?: string,
  ): Promise<{
    objectiveId: string;
    milestoneId: string;
    objectiveProvisioned: boolean;
    projection?: ProjectionReceipt;
  }> {
    const repository = await this.#runtime.repository(projectCode);
    const activeObjective = repository.getActiveObjective();
    const activeMilestone = repository.getActiveMilestone(activeObjective?.id);
    if (activeObjective && activeMilestone) {
      return {
        objectiveId: activeObjective.id,
        milestoneId: activeMilestone.id,
        objectiveProvisioned: false,
      };
    }
    const actor: ProjectActor = sessionId
      ? await this.#runtime.actor(projectCode, sessionId)
      : { type: "SYSTEM", id: "planning-root", sessionId: null };
    const project = this.#runtime.databases.getProject(projectCode);
    const objective =
      activeObjective ??
      repository.createObjective(actor, {
        title: `${project?.name ?? projectCode.toUpperCase()}（自动补建）`,
        description:
          "项目尚无目标时自动补建，用于承载任务。请按实际规划改写标题与验收，或另建目标后归档它。",
        definitionOfDone: [],
      });
    const milestone =
      repository.getActiveMilestone(objective.id) ??
      repository.createMilestone(actor, { objectiveId: objective.id, title: "执行" });
    const projection = await this.#projection.flush(projectCode);
    return {
      objectiveId: objective.id,
      milestoneId: milestone.id,
      objectiveProvisioned: !activeObjective,
      projection,
    };
  }
}
