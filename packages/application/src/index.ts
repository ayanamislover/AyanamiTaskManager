import { basename } from "node:path";
import { classifyTaskScope } from "@ayanami-task/domain";
import { asAtmError, AtmError } from "@ayanami-task/errors";
import {
  normalizeReviewCandidateHashes,
  workItemOperationHasEffect,
  type EvidenceInput,
  type ProjectionBatchReceipt,
  type ProjectionReconcileReceipt,
  type ProjectionStateView,
  type ProjectionSummary,
  type TaskContextView,
  type TaskCoreView,
  type TaskFullView,
  type TaskView,
  type TaskViewName,
} from "@ayanami-task/protocol";
import {
  gitHead,
  inspectGitContext,
  scanProjectMetrics,
  scanWorkItemChanges,
} from "@ayanami-task/engineering-metrics";
import {
  AyanamiDatabaseManager,
  ProjectRepository,
  type CreateSessionInput,
  type MutationActorResolution,
  type ProjectActor,
  type ProjectionReceipt,
  type RecordPageFilters,
  type RegisteredProject,
  type SessionPageFilters,
  type WorkItemListFilters,
  type WorkItemPageFilters,
} from "@ayanami-task/storage-sqlite";
import { parseAgentTaskMarkdown } from "./agenttask-import.js";
import * as errorEnrichment from "./errors/error-enrichment.js";
import type { PublicNotFoundDetails } from "./errors/error-enrichment.js";
import * as projectQueries from "./queries/project-queries.js";
import * as readQueries from "./queries/read-queries.js";
import * as reconciliationQueries from "./queries/reconciliation-queries.js";
import * as taskQueries from "./queries/task-queries.js";
import { ApplicationServiceRuntime } from "./runtime/service-runtime.js";

export * from "./agenttask-import.js";
export * from "./reconcile.js";
export * from "./queries/task-views.js";
export type { PublicNotFoundDetails } from "./errors/error-enrichment.js";

function mutationAck<T extends Record<string, unknown>>(
  result: T,
  opId: string,
  resolution: MutationActorResolution,
  projection: ProjectionReceipt,
) {
  return {
    ...result,
    opId,
    projection,
    ...(resolution.disposition === "REBOUND"
      ? {
          sessionRebound: true,
          session: resolution.actor.sessionId,
          newSession: resolution.actor.sessionId,
        }
      : {}),
  };
}

function projectMutationReceipt<T extends Record<string, unknown>>(
  result: T,
  projection: ProjectionReceipt,
): T & { projection: ProjectionReceipt } {
  return { ...result, projection };
}

export class AyanamiTaskService {
  readonly databases: AyanamiDatabaseManager;
  readonly #runtime: ApplicationServiceRuntime;

  private constructor(databases: AyanamiDatabaseManager) {
    this.databases = databases;
    this.#runtime = new ApplicationServiceRuntime(databases);
  }

  static async open(input: {
    dataDir: string;
    migrationsRoot: string;
  }): Promise<AyanamiTaskService> {
    return new AyanamiTaskService(await AyanamiDatabaseManager.open(input));
  }

  async createProject(input: {
    name: string;
    sourcePath: string | null;
    code?: string;
    description?: string;
    coordinationMode?: "SOLO" | "AUTO" | "MULTI";
    creationReason?: string;
    creationSignals?: Record<string, unknown>;
  }): Promise<RegisteredProject> {
    const project = await this.databases.createProject(input);
    this.#runtime.emitGlobal();
    return project;
  }

  listProjects(): RegisteredProject[] {
    return projectQueries.listProjects(this.#runtime);
  }

  attachProjectPath(projectCode: string, path: string, primary = true) {
    const project = this.databases.attachProjectPath(projectCode, path, { primary, actor: "USER" });
    this.#runtime.emitGlobal();
    return project;
  }

  overview() {
    return projectQueries.overview(this.#runtime);
  }

  projectionState(projectCode: string): ProjectionStateView {
    return projectQueries.projectionState(this.#runtime, projectCode);
  }

  projectionStates(): ProjectionStateView[] {
    return projectQueries.projectionStates(this.#runtime);
  }

  projectionSummary(): ProjectionSummary {
    return projectQueries.projectionSummary(this.#runtime);
  }

  async reconcileProjection(projectCode: string): Promise<ProjectionReconcileReceipt> {
    const project = this.databases.getProject(projectCode);
    const attemptedAt = new Date().toISOString();
    const result = await this.databases.dispatchProject(project.id);
    this.#runtime.emitProject(project.code);
    this.#runtime.emitGlobal();
    return {
      ok: true,
      project: {
        id: project.id,
        code: project.code,
        name: project.name,
        lifecycle: project.lifecycle,
      },
      delivered: result.delivered,
      sequence: result.sequence,
      attemptedAt,
      projection: result.projection,
    };
  }

  async reconcileProjections(): Promise<ProjectionBatchReceipt> {
    const attemptedAt = new Date().toISOString();
    const projects = this.databases
      .listProjects()
      .filter((project) => ["ACTIVE", "ARCHIVED"].includes(project.lifecycle))
      .sort((left, right) => left.code.localeCompare(right.code));
    const results: ProjectionReconcileReceipt[] = [];
    const failures: ProjectionBatchReceipt["failures"] = [];
    for (const project of projects) {
      try {
        results.push(await this.reconcileProjection(project.code));
      } catch (error) {
        const typed = asAtmError(error);
        failures.push({
          project: {
            id: project.id,
            code: project.code,
            name: project.name,
            lifecycle: project.lifecycle,
          },
          code: typed.code,
          message: typed.message.slice(0, 2_000),
        });
      }
    }
    return {
      ok: true,
      attempted: projects.length,
      applied: results.filter((result) => result.projection.status === "APPLIED").length,
      deferred: results.filter((result) => result.projection.status === "DEFERRED").length,
      failed: failures.length,
      attemptedAt,
      finishedAt: new Date().toISOString(),
      results,
      failures,
    };
  }

  async engineeringMetrics(
    projectCode: string,
    input: { taskKey?: string; refresh?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const project = this.databases.getProject(projectCode);
    const sourcePath = project.sourcePaths[0];
    if (!sourcePath)
      return { available: false, reason: "NO_SOURCE_PATH", project: null, workItem: null };
    try {
      const latest = await this.databases.latestProjectEngineeringMetrics(projectCode);
      const latestAt = typeof latest?.capturedAt === "string" ? Date.parse(latest.capturedAt) : 0;
      const projectMetrics =
        !input.refresh && latest && Date.now() - latestAt < 5 * 60_000
          ? latest
          : await this.databases.saveProjectEngineeringMetrics(
              projectCode,
              scanProjectMetrics(sourcePath),
            );
      let workItem: Record<string, unknown> | null = null;
      if (input.taskKey) {
        const baseline = await this.databases.ensureWorkItemEngineeringBaseline(
          projectCode,
          input.taskKey,
          gitHead(sourcePath),
        );
        const metrics = scanWorkItemChanges(sourcePath, baseline.baseline);
        workItem = await this.databases.saveWorkItemEngineeringMetrics(
          projectCode,
          input.taskKey,
          baseline.baseline,
          metrics,
        );
      }
      return { available: true, root: sourcePath, project: projectMetrics, workItem };
    } catch (error) {
      const typed = asAtmError(error);
      return {
        available: false,
        reason: typed.code === "INTERNAL_ERROR" ? "METRICS_FAILED" : typed.code,
        message: typed.message,
        project: null,
        workItem: null,
      };
    }
  }

  listSavedViews(projectCode?: string) {
    return projectQueries.listSavedViews(this.#runtime, projectCode);
  }

  createSavedView(input: Parameters<AyanamiDatabaseManager["createSavedView"]>[0]) {
    const result = this.databases.createSavedView(input);
    this.#runtime.emitGlobal();
    return result;
  }

  updateSavedView(id: string, input: Parameters<AyanamiDatabaseManager["updateSavedView"]>[1]) {
    const result = this.databases.updateSavedView(id, input);
    this.#runtime.emitGlobal();
    return result;
  }

  deleteSavedView(id: string, expectedVersion: number) {
    const result = this.databases.deleteSavedView(id, expectedVersion);
    this.#runtime.emitGlobal();
    return result;
  }

  listSettings() {
    return projectQueries.listSettings(this.#runtime);
  }

  getSetting<T = unknown>(key: string, fallback?: T) {
    return projectQueries.getSetting(this.#runtime, key, fallback);
  }

  setSetting(key: string, value: unknown, expectedVersion?: number) {
    const result = this.databases.setSetting(key, value, expectedVersion);
    this.#runtime.emitGlobal();
    return result;
  }

  runMaintenance(at?: Date) {
    return this.databases.runMaintenance(at);
  }

  async archiveProject(projectCode: string, actor = "USER") {
    await this.databases.createBackup({
      scope: "PROJECT",
      project: projectCode,
      reason: "PRE_ARCHIVE",
    });
    const result = this.databases.setProjectLifecycle(projectCode, "ARCHIVED", actor);
    this.#runtime.emitGlobal();
    return result;
  }

  restoreProject(projectCode: string, actor = "USER") {
    const result = this.databases.setProjectLifecycle(projectCode, "ACTIVE", actor);
    this.#runtime.emitGlobal();
    return result;
  }

  async trashProject(projectCode: string, actor = "USER") {
    await this.databases.createBackup({
      scope: "PROJECT",
      project: projectCode,
      reason: "PRE_TRASH",
    });
    const result = this.databases.setProjectLifecycle(projectCode, "TRASHED", actor);
    this.#runtime.emitGlobal();
    return result;
  }

  listBackups(projectCode?: string) {
    return projectQueries.listBackups(this.#runtime, projectCode);
  }

  async createBackup(input: Parameters<AyanamiDatabaseManager["createBackup"]>[0]) {
    const result = await this.databases.createBackup(input);
    this.#runtime.emitGlobal();
    return result;
  }

  async restoreBackup(backupId: string) {
    const result = await this.databases.restoreBackup(backupId);
    this.#runtime.dropRepository(result.project.id);
    this.#runtime.emitProject(result.project.code);
    this.#runtime.emitGlobal();
    return result;
  }

  exportProject(projectCode: string, format: "aytproj" | "json" | "csv" = "aytproj") {
    return this.databases.exportProject(projectCode, format);
  }

  previewAgentTaskImport(projectCode: string, content: string, sourceName = "agenttask.md") {
    const project = this.databases.getProject(projectCode);
    const plan = parseAgentTaskMarkdown(content, sourceName);
    return {
      ...plan,
      project: { id: project.id, code: project.code, name: project.name },
      alreadyImported: Boolean(this.databases.getImportHistory(project.id, plan.sha256)),
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
    const project = this.databases.getProject(projectCode);
    const plan = parseAgentTaskMarkdown(content, sourceName);
    if (expectedSha256 && expectedSha256 !== plan.sha256) {
      throw new AtmError("IMPORT_SOURCE_CHANGED", {
        message: "源文件已在预览后发生变化",
        httpStatus: 409,
      });
    }
    const existing = this.databases.getImportHistory(project.id, plan.sha256);
    if (existing) return { ...existing, alreadyImported: true };

    const repository = await this.#repository(project.code);
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
      if (!objectiveId)
        throw new AtmError("IMPORT_OBJECTIVE_MISSING", {
          message: `导入目标不存在：${milestone.objectiveRef}`,
          details: { reference: milestone.objectiveRef },
          httpStatus: 422,
        });
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
          if (!objectiveId)
            throw new AtmError("IMPORT_OBJECTIVE_MISSING", {
              message: `导入目标不存在：${task.objectiveRef}`,
              details: { reference: task.objectiveRef },
              httpStatus: 422,
            });
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
    const projection = await this.#flush(project.code);
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
    this.databases.recordImport(project.id, plan.sha256, result);
    return projectMutationReceipt(result, projection);
  }

  async #repository(projectCode: string): Promise<ProjectRepository> {
    return this.#runtime.repository(projectCode);
  }

  async #actor(projectCode: string, sessionId: string): Promise<ProjectActor> {
    return this.#runtime.actor(projectCode, sessionId);
  }

  async #refreshSessionGitContext(projectCode: string, sessionId: string) {
    return this.#runtime.refreshSessionGitContext(projectCode, sessionId);
  }

  #userActor(): ProjectActor {
    return this.#runtime.userActor();
  }

  async #captureWorkItemEngineeringMetrics(
    projectCode: string,
    taskKeys: string[],
    establishBaseline: boolean,
  ): Promise<void> {
    const sourcePath = this.databases.getProject(projectCode).sourcePaths[0];
    if (!sourcePath) return;
    try {
      const head = gitHead(sourcePath);
      for (const taskKey of [...new Set(taskKeys)]) {
        let stored = await this.databases.workItemEngineeringMetrics(projectCode, taskKey);
        if (!stored && establishBaseline) {
          stored = await this.databases.ensureWorkItemEngineeringBaseline(
            projectCode,
            taskKey,
            head,
          );
        }
        if (!stored) continue;
        const metrics = scanWorkItemChanges(sourcePath, stored.baseline);
        await this.databases.saveWorkItemEngineeringMetrics(
          projectCode,
          taskKey,
          stored.baseline,
          metrics,
        );
      }
    } catch {
      // Engineering metrics are observational and never roll back a committed task transition.
    }
  }

  async #flush(projectCode: string): Promise<ProjectionReceipt> {
    const result = await this.databases.dispatchProject(projectCode);
    this.#runtime.emitProject(projectCode);
    this.#runtime.emitGlobal();
    return result.projection;
  }

  subscribeProject(projectCode: string, listener: () => void): () => void {
    return this.#runtime.subscribeProject(projectCode, listener);
  }

  subscribeGlobal(listener: () => void): () => void {
    return this.#runtime.subscribeGlobal(listener);
  }

  async begin(input: {
    operationId?: string;
    projectCode?: string;
    cwd?: string | null;
    title?: string;
    mode?: "auto" | "quick" | "project";
    agentId: string;
    displayName?: string;
    clientKind?: string;
    parentSessionId?: string | null;
    threadId?: string | null;
    role?: "PRIMARY" | "SUBAGENT" | "REVIEWER" | "OBSERVER";
    gitBranch?: string | null;
    gitHead?: string | null;
    resume?: boolean;
    predecessorSessionId?: string | null;
    maxChars?: number;
    signals?: {
      expectedMinutes?: number;
      subtaskCount?: number;
      multiSession?: boolean;
      multiAgent?: boolean;
      hasDependencies?: boolean;
      needsEvidence?: boolean;
      hasTargetDate?: boolean;
    };
    allowProjectCreate?: boolean;
    creationReason?: string;
  }): Promise<any> {
    const operationId = input.operationId?.trim();
    if (input.operationId !== undefined && (!operationId || operationId.length > 128)) {
      throw new AtmError("OPERATION_ID_INVALID", { message: "operationId 无效" });
    }
    let project = input.projectCode ? this.databases.getProject(input.projectCode) : null;
    if (!project && input.cwd) project = this.databases.identifyProject(input.cwd);
    if (operationId && !project) {
      throw new AtmError("ATOMIC_BEGIN_REQUIRES_EXISTING_PROJECT", {
        message: "原子恢复要求项目已存在",
      });
    }
    const classification = classifyTaskScope({
      matchedProject: Boolean(project),
      explicitMode: input.mode ?? "auto",
      signals: input.signals ?? {},
    });
    if (!project && classification.scope === "quick") {
      const quick = this.databases.createQuickTask({
        title: input.title ?? "未命名临时任务",
        sourceCwd: input.cwd ?? null,
        actor: input.agentId,
      });
      return { scope: "quick", quick, session: null, score: classification.score };
    }
    if (!project) {
      if (!input.allowProjectCreate)
        throw new AtmError("PROJECT_REQUIRED", { message: "需要明确的受管项目" });
      project = await this.createProject({
        name: input.title ?? (input.cwd ? basename(input.cwd) : "未命名项目"),
        sourcePath: input.cwd ?? null,
        ...(input.creationReason === undefined ? {} : { creationReason: input.creationReason }),
        ...(input.signals === undefined ? {} : { creationSignals: input.signals }),
      });
    }
    const repository = await this.#repository(project.code);
    const gitContext = input.cwd ? inspectGitContext(input.cwd) : null;
    const sessionInput: CreateSessionInput = {
      agentId: input.agentId,
      displayName: input.displayName ?? input.agentId,
      clientKind: input.clientKind ?? "generic",
      role: input.role ?? "PRIMARY",
      ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.gitBranch === undefined ? {} : { gitBranch: input.gitBranch }),
      ...(input.gitHead === undefined ? {} : { gitHead: input.gitHead }),
      gitContext,
      ...(input.resume === undefined ? {} : { resume: input.resume }),
      ...(input.predecessorSessionId === undefined
        ? {}
        : { predecessorSessionId: input.predecessorSessionId }),
    };
    let session: { id: string; sequence: number };
    let atomicBegin: {
      operationId: string;
      disposition: "CREATED" | "RECOVERED";
    } | null = null;
    if (operationId) {
      const recovered = repository.recoverOrCreateSession(
        operationId,
        {
          projectCode: project.code,
          cwd: input.cwd ?? null,
          title: input.title ?? null,
          mode: input.mode ?? "auto",
          agentId: input.agentId,
          displayName: input.displayName ?? input.agentId,
          clientKind: input.clientKind ?? "generic",
          parentSessionId: input.parentSessionId ?? null,
          threadId: input.threadId ?? null,
          role: input.role ?? "PRIMARY",
          gitBranch: input.gitBranch ?? null,
          gitHead: input.gitHead ?? null,
          resume: input.resume ?? false,
          predecessorSessionId: input.predecessorSessionId ?? null,
          signals: input.signals ?? {},
          allowProjectCreate: input.allowProjectCreate ?? false,
          creationReason: input.creationReason ?? null,
        },
        sessionInput,
      );
      session = recovered;
      atomicBegin = { operationId, disposition: recovered.disposition };
    } else {
      session = repository.createSession(sessionInput);
    }
    const projection = await this.#flush(project.code);
    return {
      scope: "project",
      project: project.code,
      session: session.id,
      score: classification.score,
      projection,
      ...(atomicBegin === null ? {} : { atomicBegin }),
    };
  }

  listQuickTasks(status?: string) {
    return projectQueries.listQuickTasks(this.#runtime, status);
  }

  createQuickTask(input: Parameters<AyanamiDatabaseManager["createQuickTask"]>[0]) {
    const result = this.databases.createQuickTask(input);
    this.#runtime.emitGlobal();
    return result;
  }

  updateQuickTask(
    idOrKey: string,
    input: Parameters<AyanamiDatabaseManager["updateQuickTask"]>[1],
  ) {
    const result = this.databases.updateQuickTask(idOrKey, input);
    this.#runtime.emitGlobal();
    return result;
  }

  async promoteQuickTask(input: {
    quickTask: string;
    expectedVersion: number;
    targetProjectCode?: string;
    actor?: string;
  }): Promise<any> {
    const quick = this.databases.getQuickTask(input.quickTask);
    if (quick.status === "PROMOTED") return quick;
    const project = input.targetProjectCode
      ? this.databases.getProject(input.targetProjectCode)
      : await this.createProject({
          name: quick.title,
          sourcePath: null,
          description: quick.note,
          creationReason: `Quick Task ${quick.key} 晋升`,
          creationSignals: { sourceQuickTask: quick.id },
        });
    const repository = await this.#repository(project.code);
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
    const result = this.databases.markQuickPromoted(
      quick.id,
      input.expectedVersion,
      project.id,
      created.items[0]!.key,
      input.actor,
    );
    const projection = await this.#flush(project.code);
    return projectMutationReceipt(result, projection);
  }

  async brief(
    projectCode: string,
    sessionId?: string | null,
    maxChars = 1200,
  ): Promise<Awaited<ReturnType<ProjectRepository["brief"]>>> {
    return readQueries.brief(this.#runtime, projectCode, sessionId, maxChars);
  }

  async briefSnapshot(projectCode: string, sessionId?: string | null) {
    return readQueries.briefSnapshot(this.#runtime, projectCode, sessionId);
  }

  async planningContext(
    projectCode: string,
  ): Promise<{ objectiveId: string | null; milestoneId: string | null }> {
    return readQueries.planningContext(this.#runtime, projectCode);
  }

  // 项目还没有目标时任务无处落位。这不是「必须先规划」的领域约束——promote 路径
  // 早就在做同一件事（getActiveObjective() ?? createObjective(...)），只有 MCP 适配层
  // 比领域更严，把它抛成 OBJECTIVE_REQUIRED，于是纯 MCP 会话在一个新项目里一个任务
  // 也建不出来。这里把 promote 的既有做法提上来共用，不再各写一份。
  //
  // 自动补建目标是一次静默的规划决策：标题必须一眼看出是机器补的，调用方也必须
  // 拿到回执，否则事后没人分得清这个目标是谁定的。
  //
  // objectiveProvisioned 只说目标，不说里程碑。在人定的目标下补一个「执行」里程碑
  // 是无关紧要的落位动作（promote 一直这么做），把它也算进回执，回执就会在几乎每个
  // 项目的第一次建任务时亮起，反而失去指示作用。
  async ensurePlanningRoot(
    projectCode: string,
    sessionId?: string,
  ): Promise<{
    objectiveId: string;
    milestoneId: string;
    objectiveProvisioned: boolean;
    projection?: ProjectionReceipt;
  }> {
    const repository = await this.#repository(projectCode);
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
      ? await this.#actor(projectCode, sessionId)
      : { type: "SYSTEM", id: "planning-root", sessionId: null };
    const project = this.databases.getProject(projectCode);
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
    const projection = await this.#flush(projectCode);
    return {
      objectiveId: objective.id,
      milestoneId: milestone.id,
      objectiveProvisioned: !activeObjective,
      projection,
    };
  }

  async listObjectives(projectCode: string) {
    return readQueries.listObjectives(this.#runtime, projectCode);
  }

  async listMilestones(projectCode: string, objectiveId?: string) {
    return readQueries.listMilestones(this.#runtime, projectCode, objectiveId);
  }

  async listAgentSessions(projectCode: string, limit = 100) {
    return readQueries.listAgentSessions(this.#runtime, projectCode, limit);
  }

  async agentPage(projectCode: string, filters: SessionPageFilters = {}) {
    return readQueries.agentPage(this.#runtime, projectCode, filters);
  }

  async listAgentSessionPage(projectCode: string, filters: SessionPageFilters = {}) {
    return this.agentPage(projectCode, filters);
  }

  async getSession(projectCode: string, id: string) {
    return readQueries.getSession(this.#runtime, projectCode, id);
  }

  async notFoundSuggestionDetails(
    projectCode: string,
    code: string,
    reference: string,
  ): Promise<PublicNotFoundDetails | null> {
    return errorEnrichment.notFoundSuggestionDetails(this.#runtime, projectCode, code, reference);
  }

  projectSuggestionDetails(reference: string): PublicNotFoundDetails {
    return errorEnrichment.projectSuggestionDetails(this.#runtime, reference);
  }

  async enrichError(
    error: unknown,
    context: {
      projectCode?: string;
      taskKey?: string;
      checklistId?: string;
      expectedVersion?: number;
      expectedVersions?: Record<string, number>;
    } = {},
  ): Promise<AtmError> {
    return errorEnrichment.enrichApplicationError(
      {
        notFoundSuggestionDetails: (projectCode, code, reference) =>
          this.notFoundSuggestionDetails(projectCode, code, reference),
        projectSuggestionDetails: (reference) => this.projectSuggestionDetails(reference),
        checklistConflictSnapshot: (projectCode, checklistId) =>
          this.checklistConflictSnapshot(projectCode, checklistId),
        recentChecklistChanges: (projectCode, checklistId, limit) =>
          this.recentChecklistChanges(projectCode, checklistId, limit),
        getWorkItemForUi: (projectCode, taskKey) => this.getWorkItemForUi(projectCode, taskKey),
        recentWorkItemChanges: (projectCode, taskKey, limit) =>
          this.recentWorkItemChanges(projectCode, taskKey, limit),
      },
      error,
      context,
    );
  }

  async #withMutationErrorDetails<T>(
    projectCode: string,
    context: {
      taskKey?: string;
      checklistId?: string;
      expectedVersion?: number;
      expectedVersions?: Record<string, number>;
    },
    action: () => T | Promise<T>,
  ): Promise<T> {
    try {
      return await action();
    } catch (error) {
      const base = asAtmError(error);
      let enriched = base;
      try {
        enriched = await this.enrichError(base, { projectCode, ...context });
      } catch {
        // Error reporting must never hide the authoritative mutation failure.
      }
      throw enriched;
    }
  }

  async listRecords(projectCode: string, limit = 100) {
    return readQueries.listRecords(this.#runtime, projectCode, limit);
  }

  async recordPage(projectCode: string, filters: RecordPageFilters = {}) {
    return readQueries.recordPage(this.#runtime, projectCode, filters);
  }

  async getRecord(projectCode: string, reference: string) {
    return readQueries.getRecord(this.#runtime, projectCode, reference);
  }

  async getProgressUpdate(projectCode: string, id: string) {
    return readQueries.getProgressUpdate(this.#runtime, projectCode, id);
  }

  async listProjectUpdates(projectCode: string, limit = 50) {
    return readQueries.listProjectUpdates(this.#runtime, projectCode, limit);
  }

  async getProjectUpdate(projectCode: string, id: string) {
    return readQueries.getProjectUpdate(this.#runtime, projectCode, id);
  }

  async draftProjectUpdateAsUser(projectCode: string, opId: string) {
    const repository = await this.#repository(projectCode);
    const result = repository.draftProjectUpdate(this.#userActor(), opId);
    const projection = await this.#flush(projectCode);
    return projectMutationReceipt(result, projection);
  }

  async publishProjectUpdateAsUser(
    projectCode: string,
    opId: string,
    input: Parameters<ProjectRepository["publishProjectUpdate"]>[2],
  ) {
    const repository = await this.#repository(projectCode);
    const result = repository.publishProjectUpdate(this.#userActor(), opId, input);
    const projection = await this.#flush(projectCode);
    return projectMutationReceipt(result, projection);
  }

  async createObjective(
    projectCode: string,
    sessionId: string,
    input: { title: string; description: string; definitionOfDone: string[] },
  ): Promise<any> {
    const repository = await this.#repository(projectCode);
    const result = repository.createObjective(await this.#actor(projectCode, sessionId), input);
    const projection = await this.#flush(projectCode);
    return projectMutationReceipt(result, projection);
  }

  async createObjectiveAsUser(
    projectCode: string,
    opId: string,
    input: { title: string; description: string; definitionOfDone: string[] },
  ): Promise<any> {
    const repository = await this.#repository(projectCode);
    const result = repository.createObjective(this.#userActor(), input, opId);
    const projection = await this.#flush(projectCode);
    return projectMutationReceipt(result, projection);
  }

  async createMilestone(
    projectCode: string,
    sessionId: string,
    input: { objectiveId: string; title: string; description?: string; targetDate?: string | null },
  ): Promise<any> {
    const repository = await this.#repository(projectCode);
    const result = repository.createMilestone(await this.#actor(projectCode, sessionId), input);
    const projection = await this.#flush(projectCode);
    return projectMutationReceipt(result, projection);
  }

  async createMilestoneAsUser(
    projectCode: string,
    opId: string,
    input: { objectiveId: string; title: string; description?: string; targetDate?: string | null },
  ): Promise<any> {
    const repository = await this.#repository(projectCode);
    const result = repository.createMilestone(this.#userActor(), input, opId);
    const projection = await this.#flush(projectCode);
    return projectMutationReceipt(result, projection);
  }

  async createWorkItems(
    projectCode: string,
    sessionId: string,
    opId: string,
    items: Parameters<ProjectRepository["createWorkItems"]>[2],
    options: { resolvePlanningRoot?: boolean } = {},
  ) {
    const repository = await this.#repository(projectCode);
    const planningRoot = options.resolvePlanningRoot
      ? {
          provisionIfMissing: items.some((item) => item.objectiveId === undefined),
          objectiveTitle: `${this.databases.getProject(projectCode).name}（自动补建）`,
          objectiveDescription:
            "项目尚无目标时自动补建，用于承载任务。请按实际规划改写标题与验收，或另建目标后归档它。",
          milestoneTitle: "执行",
        }
      : undefined;
    const execution = repository.executeSessionMutation(
      sessionId,
      opId,
      "work.create.batch",
      items,
      (actor) => repository.createWorkItems(actor, opId, items, planningRoot),
    );
    const projection = await this.#flush(projectCode);
    return mutationAck(execution.result, opId, execution.resolution, projection);
  }

  async createWorkItemsAsUser(
    projectCode: string,
    opId: string,
    items: Parameters<ProjectRepository["createWorkItems"]>[2],
  ): Promise<ReturnType<ProjectRepository["createWorkItems"]> & { projection: ProjectionReceipt }> {
    const repository = await this.#repository(projectCode);
    const result = repository.createWorkItems(this.#userActor(), opId, items);
    const projection = await this.#flush(projectCode);
    return projectMutationReceipt(result, projection);
  }

  async patchWorkItems(
    projectCode: string,
    sessionId: string,
    opId: string,
    patches: Parameters<ProjectRepository["patchWorkItems"]>[2],
  ) {
    const repository = await this.#repository(projectCode);
    const firstPatch = patches[0];
    const execution = await this.#withMutationErrorDetails(
      projectCode,
      firstPatch === undefined
        ? {}
        : {
            taskKey: firstPatch.taskKey,
            expectedVersion: firstPatch.expectedVersion,
            expectedVersions: Object.fromEntries(
              patches.map((patch) => [patch.taskKey, patch.expectedVersion]),
            ),
          },
      () =>
        repository.executeSessionMutation(sessionId, opId, "work.patch.batch", patches, (actor) =>
          repository.patchWorkItems(actor, opId, patches),
        ),
    );
    if (
      patches.some((patch) => workItemOperationHasEffect(patch.operation, "REFRESH_GIT_CONTEXT"))
    ) {
      await this.#refreshSessionGitContext(
        projectCode,
        String(execution.resolution.actor.sessionId),
      );
    }
    const projection = await this.#flush(projectCode);
    const starts = patches
      .filter((patch) =>
        workItemOperationHasEffect(patch.operation, "ESTABLISH_ENGINEERING_BASELINE"),
      )
      .map((patch) => patch.taskKey);
    const finishes = patches
      .filter((patch) => workItemOperationHasEffect(patch.operation, "CAPTURE_ENGINEERING_METRICS"))
      .map((patch) => patch.taskKey);
    await this.#captureWorkItemEngineeringMetrics(projectCode, starts, true);
    await this.#captureWorkItemEngineeringMetrics(projectCode, finishes, false);
    return mutationAck(execution.result, opId, execution.resolution, projection);
  }

  async patchWorkItemsAsUser(
    projectCode: string,
    opId: string,
    patches: Parameters<ProjectRepository["patchWorkItems"]>[2],
  ): Promise<ReturnType<ProjectRepository["patchWorkItems"]> & { projection: ProjectionReceipt }> {
    const repository = await this.#repository(projectCode);
    const result = repository.patchWorkItems(this.#userActor(), opId, patches);
    const projection = await this.#flush(projectCode);
    const starts = patches
      .filter((patch) =>
        workItemOperationHasEffect(patch.operation, "ESTABLISH_ENGINEERING_BASELINE"),
      )
      .map((patch) => patch.taskKey);
    const finishes = patches
      .filter((patch) => workItemOperationHasEffect(patch.operation, "CAPTURE_ENGINEERING_METRICS"))
      .map((patch) => patch.taskKey);
    await this.#captureWorkItemEngineeringMetrics(projectCode, starts, true);
    await this.#captureWorkItemEngineeringMetrics(projectCode, finishes, false);
    return projectMutationReceipt(result, projection);
  }

  async verifyAndComplete(
    projectCode: string,
    sessionId: string,
    opId: string,
    input: Parameters<ProjectRepository["verifyAndComplete"]>[2],
  ) {
    const repository = await this.#repository(projectCode);
    const execution = await this.#withMutationErrorDetails(
      projectCode,
      { taskKey: input.taskKey, expectedVersion: input.expectedVersion },
      () =>
        repository.executeSessionMutation(
          sessionId,
          opId,
          "work.verify-and-complete",
          input,
          (actor) => repository.verifyAndComplete(actor, opId, input),
        ),
    );
    await this.#refreshSessionGitContext(projectCode, String(execution.resolution.actor.sessionId));
    const projection = await this.#flush(projectCode);
    await this.#captureWorkItemEngineeringMetrics(projectCode, [input.taskKey], false);
    return mutationAck(execution.result, opId, execution.resolution, projection);
  }

  async verifyAndCompleteAsUser(
    projectCode: string,
    opId: string,
    input: Parameters<ProjectRepository["verifyAndComplete"]>[2],
  ): Promise<
    ReturnType<ProjectRepository["verifyAndComplete"]> & { projection: ProjectionReceipt }
  > {
    const repository = await this.#repository(projectCode);
    const result = repository.verifyAndComplete(this.#userActor(), opId, input);
    const projection = await this.#flush(projectCode);
    await this.#captureWorkItemEngineeringMetrics(projectCode, [input.taskKey], false);
    return projectMutationReceipt(result, projection);
  }

  async listWorkItems(
    projectCode: string,
    filters?: Parameters<ProjectRepository["listWorkItems"]>[0],
    view: TaskViewName = "core",
  ): Promise<TaskView[]> {
    return taskQueries.listWorkItems(this.#runtime, projectCode, filters, view);
  }

  async listWorkItemPage(
    projectCode: string,
    filters: WorkItemPageFilters = {},
    view: TaskViewName = "core",
  ): Promise<{
    items: TaskView[];
    itemCursors: string[];
    nextCursor: string | null;
    retryCursor: string;
    hasMore: boolean;
  }> {
    return taskQueries.listWorkItemPage(this.#runtime, projectCode, filters, view);
  }

  async listWorkItemPageForUi(
    projectCode: string,
    filters: WorkItemPageFilters = {},
  ): Promise<ReturnType<ProjectRepository["listWorkItemPage"]>> {
    return taskQueries.listWorkItemPageForUi(this.#runtime, projectCode, filters);
  }

  /** Desktop-only operational metadata kept outside the bounded Agent read views. */
  async listWorkItemsForUi(
    projectCode: string,
    filters: WorkItemListFilters = {},
  ): Promise<ReturnType<ProjectRepository["listWorkItems"]>> {
    return taskQueries.listWorkItemsForUi(projectCode, filters, (code, pageFilters) =>
      this.listWorkItemPageForUi(code, pageFilters),
    );
  }

  async assertMilestonesExist(
    projectCode: string,
    milestoneIds: Array<string | null | undefined>,
  ): Promise<void> {
    return taskQueries.assertMilestonesExist(this.#runtime, projectCode, milestoneIds);
  }

  async assertSessionCanProvisionPlanningRoot(
    projectCode: string,
    sessionId: string,
  ): Promise<void> {
    const session = await this.getSession(projectCode, sessionId);
    if (session.connectionState !== "ONLINE" && session.closeReason !== "HEARTBEAT_TIMEOUT") {
      throw new AtmError("SESSION_CLOSED", {
        message: sessionId,
        details: { entity: "SESSION", session_id: sessionId, reference: sessionId },
      });
    }
  }

  async reconcileProject(projectCode: string, input: { includeActive?: boolean } = {}) {
    return reconciliationQueries.reconcileProject(this.#runtime, projectCode, input);
  }

  async reconcileProjectPage(
    projectCode: string,
    input: { includeActive?: boolean; limit?: number; cursor?: string } = {},
  ) {
    return reconciliationQueries.reconcileProjectPage(projectCode, input, (code, options) =>
      this.reconcileProject(code, options),
    );
  }

  async getWorkItem(
    projectCode: string,
    taskKey: string,
  ): Promise<ReturnType<ProjectRepository["getWorkItem"]>>;
  async getWorkItem(projectCode: string, taskKey: string, view: "core"): Promise<TaskCoreView>;
  async getWorkItem(
    projectCode: string,
    taskKey: string,
    view: "context",
  ): Promise<TaskContextView>;
  async getWorkItem(projectCode: string, taskKey: string, view: "full"): Promise<TaskFullView>;
  async getWorkItem(projectCode: string, taskKey: string, view: TaskViewName): Promise<TaskView>;
  async getWorkItem(
    projectCode: string,
    taskKey: string,
    view?: TaskViewName,
  ): Promise<TaskView | ReturnType<ProjectRepository["getWorkItem"]>> {
    return taskQueries.getWorkItem(this.#runtime, projectCode, taskKey, view);
  }

  /** Desktop-only aggregate for operational controls such as lease release and tree layout. */
  async getWorkItemForUi(
    projectCode: string,
    taskKey: string,
  ): Promise<ReturnType<ProjectRepository["getWorkItem"]>> {
    return taskQueries.getWorkItemForUi(this.#runtime, projectCode, taskKey);
  }

  async createReviewRequest(
    projectCode: string,
    sessionId: string,
    opId: string,
    input: Parameters<ProjectRepository["createReviewRequest"]>[2],
  ) {
    const repository = await this.#repository(projectCode);
    const normalizedInput = {
      ...input,
      expectedCandidateHashes: normalizeReviewCandidateHashes(input.expectedCandidateHashes),
    };
    const execution = await this.#withMutationErrorDetails(
      projectCode,
      {
        taskKey: normalizedInput.reviewTaskKey,
        checklistId: normalizedInput.parentChecklistId,
        expectedVersion: normalizedInput.expectedParentChecklistVersion,
        expectedVersions: {
          [normalizedInput.reviewTaskKey]: normalizedInput.expectedReviewTaskVersion,
        },
      },
      () =>
        repository.executeSessionMutation(
          sessionId,
          opId,
          "review.request.create",
          normalizedInput,
          (actor) => repository.createReviewRequest(actor, opId, normalizedInput),
        ),
    );
    const projection = await this.#flush(projectCode);
    return mutationAck(execution.result, opId, execution.resolution, projection);
  }

  async getReviewRequest(projectCode: string, requestKey: string) {
    return (await this.#repository(projectCode)).getReviewRequest(requestKey);
  }

  async submitReview(
    projectCode: string,
    sessionId: string,
    opId: string,
    input: Parameters<ProjectRepository["submitReview"]>[2],
  ) {
    const repository = await this.#repository(projectCode);
    const normalizedInput = {
      ...input,
      reviewedHashes: normalizeReviewCandidateHashes(input.reviewedHashes),
    };
    const execution = await this.#withMutationErrorDetails(
      projectCode,
      {
        ...(normalizedInput.reviewTaskKey === undefined
          ? {}
          : { taskKey: normalizedInput.reviewTaskKey }),
        expectedVersion: normalizedInput.expectedReviewTaskVersion,
      },
      () =>
        repository.executeSessionMutation(
          sessionId,
          opId,
          "review.submit",
          normalizedInput,
          (actor) => repository.submitReview(actor, opId, normalizedInput),
        ),
    );
    const projection = await this.#flush(projectCode);
    return mutationAck(execution.result, opId, execution.resolution, projection);
  }

  async updateChecklist(
    projectCode: string,
    sessionId: string,
    opId: string,
    input: Parameters<ProjectRepository["updateChecklist"]>[2],
  ) {
    const repository = await this.#repository(projectCode);
    const execution = await this.#withMutationErrorDetails(
      projectCode,
      { checklistId: input.checklistId, expectedVersion: input.expectedVersion },
      () =>
        repository.executeSessionMutation(sessionId, opId, "checklist.update", input, (actor) =>
          repository.updateChecklist(actor, opId, input),
        ),
    );
    const projection = await this.#flush(projectCode);
    return mutationAck(execution.result, opId, execution.resolution, projection);
  }

  async updateChecklistAsUser(
    projectCode: string,
    opId: string,
    input: Parameters<ProjectRepository["updateChecklist"]>[2],
  ): Promise<ReturnType<ProjectRepository["updateChecklist"]> & { projection: ProjectionReceipt }> {
    const repository = await this.#repository(projectCode);
    const result = repository.updateChecklist(this.#userActor(), opId, input);
    const projection = await this.#flush(projectCode);
    return projectMutationReceipt(result, projection);
  }

  async updateChecklistBatch(
    projectCode: string,
    sessionId: string,
    opId: string,
    input: Parameters<ProjectRepository["updateChecklistBatch"]>[2],
  ) {
    const repository = await this.#repository(projectCode);
    const execution = await this.#withMutationErrorDetails(
      projectCode,
      { taskKey: input.taskKey, expectedVersion: input.expectedVersion },
      () =>
        repository.executeSessionMutation(
          sessionId,
          opId,
          "checklist.update.batch",
          input,
          (actor) => repository.updateChecklistBatch(actor, opId, input),
        ),
    );
    const projection = await this.#flush(projectCode);
    return mutationAck(execution.result, opId, execution.resolution, projection);
  }

  async updateChecklistBatchAsUser(
    projectCode: string,
    opId: string,
    input: Parameters<ProjectRepository["updateChecklistBatch"]>[2],
  ): Promise<
    ReturnType<ProjectRepository["updateChecklistBatch"]> & { projection: ProjectionReceipt }
  > {
    const repository = await this.#repository(projectCode);
    const result = repository.updateChecklistBatch(this.#userActor(), opId, input);
    const projection = await this.#flush(projectCode);
    return projectMutationReceipt(result, projection);
  }

  async addProgress(
    projectCode: string,
    sessionId: string,
    opId: string,
    input: Parameters<ProjectRepository["addProgress"]>[2],
  ) {
    const repository = await this.#repository(projectCode);
    const execution = repository.executeSessionMutation(
      sessionId,
      opId,
      "work.progress",
      input,
      (actor) => repository.addProgress(actor, opId, input),
    );
    await this.#refreshSessionGitContext(projectCode, String(execution.resolution.actor.sessionId));
    const projection = await this.#flush(projectCode);
    return mutationAck(execution.result, opId, execution.resolution, projection);
  }

  async addProjectProgress(
    projectCode: string,
    sessionId: string,
    opId: string,
    input: {
      health?: "ON_TRACK" | "AT_RISK" | "OFF_TRACK" | "UNKNOWN" | null;
      summary: string;
      completed?: Array<string | { text: string; workItemKey?: string }>;
      next?: string[];
      blocker?: string | null;
      evidence?: EvidenceInput[];
    },
  ) {
    const repository = await this.#repository(projectCode);
    const completed = input.completed ?? [];
    const linkedKeys = new Set(
      completed.flatMap((entry) =>
        typeof entry === "string" || !entry.workItemKey ? [] : [entry.workItemKey],
      ),
    );
    for (const taskKey of linkedKeys) repository.getWorkItem(taskKey);
    const update = {
      health: input.health ?? (input.blocker ? "AT_RISK" : "UNKNOWN"),
      summary: input.summary,
      completed,
      risks: input.blocker ? [input.blocker] : [],
      next: input.next ?? [],
      evidence: input.evidence ?? [],
    };
    const execution = repository.executeSessionMutation(
      sessionId,
      opId,
      "project-update.publish",
      update,
      (actor) => repository.publishProjectUpdate(actor, opId, update),
    );
    await this.#refreshSessionGitContext(projectCode, String(execution.resolution.actor.sessionId));
    const projection = await this.#flush(projectCode);
    return mutationAck(execution.result, opId, execution.resolution, projection);
  }

  async createRecord(
    projectCode: string,
    sessionId: string,
    opId: string,
    input: Parameters<ProjectRepository["createRecord"]>[2],
  ) {
    const repository = await this.#repository(projectCode);
    const execution = repository.executeSessionMutation(
      sessionId,
      opId,
      "record.create",
      input,
      (actor) => repository.createRecord(actor, opId, input),
    );
    const projection = await this.#flush(projectCode);
    return mutationAck(execution.result, opId, execution.resolution, projection);
  }

  async createRecordAsUser(
    projectCode: string,
    opId: string,
    input: Parameters<ProjectRepository["createRecord"]>[2],
  ): Promise<ReturnType<ProjectRepository["createRecord"]> & { projection: ProjectionReceipt }> {
    const repository = await this.#repository(projectCode);
    const result = repository.createRecord(this.#userActor(), opId, {
      ...input,
      sourceType: "USER",
      sourceActorId: "USER",
      sourceSessionId: null,
    });
    const projection = await this.#flush(projectCode);
    return projectMutationReceipt(result, projection);
  }

  async search(projectCode: string, query: string, limit = 20, cursor?: string) {
    return readQueries.search(this.#runtime, projectCode, query, limit, cursor);
  }

  globalSearch(query: string, limit = 20, cursor?: string) {
    return readQueries.globalSearch(this.#runtime, query, limit, cursor);
  }

  globalDelta(sinceSequence: number, limit = 50) {
    return readQueries.globalDelta(this.#runtime, sinceSequence, limit);
  }

  async delta(projectCode: string, sinceSequence: number, limit = 50, types: string[] = []) {
    return readQueries.delta(this.#runtime, projectCode, sinceSequence, limit, types);
  }

  async recentWorkItemChanges(projectCode: string, taskKey: string, limit = 6) {
    return readQueries.recentWorkItemChanges(this.#runtime, projectCode, taskKey, limit);
  }

  async checklistConflictSnapshot(projectCode: string, checklistId: string) {
    return readQueries.checklistConflictSnapshot(this.#runtime, projectCode, checklistId);
  }

  async recentChecklistChanges(projectCode: string, checklistId: string, limit = 6) {
    return readQueries.recentChecklistChanges(this.#runtime, projectCode, checklistId, limit);
  }

  async getOperationTrace(projectCode: string, opId: string, sessionId?: string | null) {
    return readQueries.getOperationTrace(this.#runtime, projectCode, opId, sessionId);
  }

  async end(
    projectCode: string,
    sessionId: string,
    opId: string,
    input: Parameters<ProjectRepository["endSession"]>[2],
  ) {
    const repository = await this.#repository(projectCode);
    const resolution = repository.resolveMutationActor(sessionId, opId, "session.end", input);
    const effectiveSessionId = String(resolution.actor.sessionId);
    if (resolution.disposition !== "REPLAY") {
      await this.#refreshSessionGitContext(projectCode, effectiveSessionId);
    }
    const result = repository.endSession(resolution.actor, opId, input);
    const projection = await this.#flush(projectCode);
    await this.#captureWorkItemEngineeringMetrics(
      projectCode,
      result.releasedItems.map((task) => task.key),
      false,
    );
    return mutationAck(result, opId, resolution, projection);
  }

  async forceCloseSessionAsUser(projectCode: string, sessionId: string, releaseClaims = true) {
    const repository = await this.#repository(projectCode);
    const result = repository.forceCloseSession(sessionId, releaseClaims);
    const projection = await this.#flush(projectCode);
    return projectMutationReceipt(result, projection);
  }

  async refreshSessionGitContextAsUser(projectCode: string, sessionId: string) {
    const result = await this.#refreshSessionGitContext(projectCode, sessionId);
    const projection = await this.#flush(projectCode);
    return {
      ...result,
      projection,
      session: (await this.#repository(projectCode)).getSessionView(sessionId),
    };
  }

  async doctor(): Promise<Awaited<ReturnType<AyanamiDatabaseManager["doctor"]>>> {
    return projectQueries.doctor(this.#runtime);
  }

  close(): void {
    this.#runtime.close();
  }
}
