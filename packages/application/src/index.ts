import { basename } from "node:path";
import { EventEmitter } from "node:events";
import { classifyTaskScope } from "@ayanami-task/domain";
import {
  asAtmError,
  AtmError,
  rankSuggestions,
  type AtmBaseErrorDetails,
} from "@ayanami-task/errors";
import {
  normalizeReviewCandidateHashes,
  type EvidenceInput,
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
  type RegisteredProject,
} from "@ayanami-task/storage-sqlite";
import { parseAgentTaskMarkdown } from "./agenttask-import.js";
import { reconcileWorkItems } from "./reconcile.js";
import { projectTaskView } from "./queries/task-views.js";

export * from "./agenttask-import.js";
export * from "./reconcile.js";
export * from "./queries/task-views.js";

export type PublicNotFoundDetails = {
  entity: "PROJECT" | "WORK_ITEM" | "SESSION" | "MILESTONE";
  did_you_mean: string | null;
  candidates: Array<Record<string, string>>;
};

function rankPublicCandidates<T extends Record<string, string>>(
  queryValue: string,
  candidates: T[],
  identity: (candidate: T) => string,
): { did_you_mean: string | null; candidates: T[] } {
  const ranked = rankSuggestions(queryValue, candidates, (candidate) => [identity(candidate)]);
  return {
    did_you_mean: ranked.didYouMean,
    candidates: ranked.candidates,
  };
}

function assertKnownMilestones(
  repository: ProjectRepository,
  milestoneIds: Iterable<string | null | undefined>,
): void {
  const requested = new Set(
    Array.from(milestoneIds).filter(
      (milestoneId): milestoneId is string => typeof milestoneId === "string",
    ),
  );
  if (requested.size === 0) return;
  const known = new Set(repository.listMilestones().map((milestone) => String(milestone.id)));
  for (const milestoneId of requested) {
    if (!known.has(milestoneId))
      throw new AtmError("MILESTONE_NOT_FOUND", {
        message: `里程碑不存在：${milestoneId}`,
        details: { entity: "MILESTONE", reference: milestoneId },
      });
  }
}

function mutationAck<T extends Record<string, unknown>>(
  result: T,
  opId: string,
  resolution: MutationActorResolution,
) {
  return {
    ...result,
    opId,
    ...(resolution.disposition === "REBOUND"
      ? {
          sessionRebound: true,
          session: resolution.actor.sessionId,
          newSession: resolution.actor.sessionId,
        }
      : {}),
  };
}

export class AyanamiTaskService {
  readonly databases: AyanamiDatabaseManager;
  readonly #repositories = new Map<string, ProjectRepository>();
  readonly #events = new EventEmitter();

  private constructor(databases: AyanamiDatabaseManager) {
    this.databases = databases;
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
    this.#events.emit("global");
    return project;
  }

  listProjects(): RegisteredProject[] {
    return this.databases.listProjects();
  }

  attachProjectPath(projectCode: string, path: string, primary = true) {
    const project = this.databases.attachProjectPath(projectCode, path, { primary, actor: "USER" });
    this.#events.emit("global");
    return project;
  }

  overview() {
    return this.databases.overview();
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
    return this.databases.listSavedViews(projectCode);
  }

  createSavedView(input: Parameters<AyanamiDatabaseManager["createSavedView"]>[0]) {
    const result = this.databases.createSavedView(input);
    this.#events.emit("global");
    return result;
  }

  updateSavedView(id: string, input: Parameters<AyanamiDatabaseManager["updateSavedView"]>[1]) {
    const result = this.databases.updateSavedView(id, input);
    this.#events.emit("global");
    return result;
  }

  deleteSavedView(id: string, expectedVersion: number) {
    const result = this.databases.deleteSavedView(id, expectedVersion);
    this.#events.emit("global");
    return result;
  }

  listSettings() {
    return this.databases.listSettings();
  }

  getSetting<T = unknown>(key: string, fallback?: T) {
    return this.databases.getSetting<T>(key, fallback);
  }

  setSetting(key: string, value: unknown, expectedVersion?: number) {
    const result = this.databases.setSetting(key, value, expectedVersion);
    this.#events.emit("global");
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
    this.#events.emit("global");
    return result;
  }

  restoreProject(projectCode: string, actor = "USER") {
    const result = this.databases.setProjectLifecycle(projectCode, "ACTIVE", actor);
    this.#events.emit("global");
    return result;
  }

  async trashProject(projectCode: string, actor = "USER") {
    await this.databases.createBackup({
      scope: "PROJECT",
      project: projectCode,
      reason: "PRE_TRASH",
    });
    const result = this.databases.setProjectLifecycle(projectCode, "TRASHED", actor);
    this.#events.emit("global");
    return result;
  }

  listBackups(projectCode?: string) {
    return this.databases.listBackups(projectCode);
  }

  async createBackup(input: Parameters<AyanamiDatabaseManager["createBackup"]>[0]) {
    const result = await this.databases.createBackup(input);
    this.#events.emit("global");
    return result;
  }

  async restoreBackup(backupId: string) {
    const result = await this.databases.restoreBackup(backupId);
    this.#repositories.delete(result.project.id);
    this.#events.emit(`project:${result.project.code}`);
    this.#events.emit("global");
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
    await this.#flush(project.code);
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
    return result;
  }

  async #repository(projectCode: string): Promise<ProjectRepository> {
    const project = this.databases.getProject(projectCode);
    const existing = this.#repositories.get(project.id);
    if (existing && existing.database.sqlite.open) return existing;
    const repository = new ProjectRepository(await this.databases.openProject(project.id));
    this.#repositories.set(project.id, repository);
    return repository;
  }

  async #actor(projectCode: string, sessionId: string): Promise<ProjectActor> {
    const repository = await this.#repository(projectCode);
    const session = repository.getSession(sessionId);
    if (session.connection_state === "CLOSED")
      throw new AtmError("SESSION_CLOSED", {
        message: sessionId,
        details: { entity: "SESSION", session_id: sessionId, reference: sessionId },
      });
    return { type: "AGENT", id: session.agent_id, sessionId };
  }

  async #refreshSessionGitContext(projectCode: string, sessionId: string) {
    const repository = await this.#repository(projectCode);
    const session = repository.getSession(sessionId);
    if (!session.cwd) return { updated: false, sequence: repository.meta.sequence };
    return repository.updateSessionGitContext(sessionId, inspectGitContext(String(session.cwd)));
  }

  #userActor(): ProjectActor {
    return { type: "USER", id: "USER", sessionId: null };
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

  async #flush(projectCode: string): Promise<void> {
    try {
      await this.databases.dispatchProject(projectCode);
    } catch {
      // Registry is a rebuildable projection. The committed project mutation remains successful.
    }
    this.#events.emit(`project:${projectCode.toUpperCase()}`);
    this.#events.emit("global");
  }

  subscribeProject(projectCode: string, listener: () => void): () => void {
    const channel = `project:${projectCode.toUpperCase()}`;
    this.#events.on(channel, listener);
    return () => this.#events.off(channel, listener);
  }

  subscribeGlobal(listener: () => void): () => void {
    this.#events.on("global", listener);
    return () => this.#events.off("global", listener);
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
          maxChars: input.maxChars ?? 1200,
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
    await this.#flush(project.code);
    return {
      scope: "project",
      session: session.id,
      score: classification.score,
      ...(atomicBegin === null ? {} : { atomicBegin }),
      ...repository.brief(session.id, input.maxChars ?? 1200),
    };
  }

  listQuickTasks(status?: string) {
    return this.databases.listQuickTasks(status);
  }

  createQuickTask(input: Parameters<AyanamiDatabaseManager["createQuickTask"]>[0]) {
    const result = this.databases.createQuickTask(input);
    this.#events.emit("global");
    return result;
  }

  updateQuickTask(
    idOrKey: string,
    input: Parameters<AyanamiDatabaseManager["updateQuickTask"]>[1],
  ) {
    const result = this.databases.updateQuickTask(idOrKey, input);
    this.#events.emit("global");
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
    await this.#flush(project.code);
    return result;
  }

  async brief(projectCode: string, sessionId?: string | null, maxChars = 1200): Promise<any> {
    return (await this.#repository(projectCode)).brief(sessionId, maxChars);
  }

  async briefSnapshot(projectCode: string, sessionId?: string | null) {
    return (await this.#repository(projectCode)).briefSnapshot(sessionId);
  }

  async planningContext(
    projectCode: string,
  ): Promise<{ objectiveId: string | null; milestoneId: string | null }> {
    const repository = await this.#repository(projectCode);
    const objective = repository.getActiveObjective();
    const milestone = repository.getActiveMilestone(objective?.id);
    return { objectiveId: objective?.id ?? null, milestoneId: milestone?.id ?? null };
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
  ): Promise<{ objectiveId: string; milestoneId: string; objectiveProvisioned: boolean }> {
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
    await this.#flush(projectCode);
    return {
      objectiveId: objective.id,
      milestoneId: milestone.id,
      objectiveProvisioned: !activeObjective,
    };
  }

  async listObjectives(projectCode: string) {
    return (await this.#repository(projectCode)).listObjectives();
  }

  async listMilestones(projectCode: string, objectiveId?: string) {
    return (await this.#repository(projectCode)).listMilestones(objectiveId);
  }

  async listAgentSessions(projectCode: string, limit = 100) {
    return (await this.#repository(projectCode)).listAgentSessions(limit);
  }

  async getSession(projectCode: string, id: string) {
    return (await this.#repository(projectCode)).getSessionView(id);
  }

  async notFoundSuggestionDetails(
    projectCode: string,
    code: string,
    reference: string,
  ): Promise<PublicNotFoundDetails | null> {
    const repository = await this.#repository(projectCode);
    if (code === "WORK_ITEM_NOT_FOUND") {
      const ranked = rankPublicCandidates(
        reference,
        repository.listWorkItems({ limit: 500 }).map((item) => ({
          key: item.key,
          status: item.status,
        })),
        (candidate) => candidate.key,
      );
      return { entity: "WORK_ITEM", ...ranked };
    }
    if (code === "SESSION_NOT_FOUND") {
      const ranked = rankPublicCandidates(
        reference,
        repository.listAgentSessions(200).map((session) => ({
          id: String(session.id),
          connection_state: String(session.connection_state),
          work_state: String(session.work_state),
        })),
        (candidate) => candidate.id,
      );
      return { entity: "SESSION", ...ranked };
    }
    if (code === "MILESTONE_NOT_FOUND") {
      const ranked = rankPublicCandidates(
        reference,
        repository.listMilestones().map((milestone) => ({
          id: String(milestone.id),
          status: String(milestone.status),
        })),
        (candidate) => candidate.id,
      );
      return { entity: "MILESTONE", ...ranked };
    }
    return null;
  }

  projectSuggestionDetails(reference: string): PublicNotFoundDetails {
    const candidates = this.databases
      .listProjects()
      .filter((project) => project.lifecycle !== "TRASHED")
      .map((project) => ({ code: project.code, name: project.name }));
    const ranked = rankSuggestions(reference, candidates, (candidate) => [
      candidate.code,
      candidate.name,
    ]);
    return {
      entity: "PROJECT",
      did_you_mean: ranked.didYouMean,
      candidates: ranked.candidates,
    };
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
    const typed = asAtmError(error);
    const source = (typed.details ?? {}) as AtmBaseErrorDetails;
    const reference = typeof source.reference === "string" ? source.reference : null;
    if (typed.code === "PROJECT_NOT_FOUND" && reference) {
      try {
        const suggestion = this.projectSuggestionDetails(reference);
        return typed.withDetails({
          ...source,
          entity: "PROJECT",
          reference,
          did_you_mean: suggestion.did_you_mean,
          candidates: suggestion.candidates,
        });
      } catch {
        return typed;
      }
    }
    if (
      reference &&
      context.projectCode &&
      ["WORK_ITEM_NOT_FOUND", "SESSION_NOT_FOUND", "MILESTONE_NOT_FOUND"].includes(typed.code)
    ) {
      try {
        const suggestion = await this.notFoundSuggestionDetails(
          context.projectCode,
          typed.code,
          reference,
        );
        if (suggestion) return typed.withDetails({ ...source, ...suggestion, reference });
      } catch {
        return typed;
      }
    }
    if (typed.code !== "VERSION_CONFLICT") return typed;
    const expected =
      typeof source.expected === "number"
        ? source.expected
        : context.taskKey
          ? (context.expectedVersions?.[context.taskKey] ?? context.expectedVersion ?? null)
          : (context.expectedVersion ?? null);
    const actual = typeof source.actual === "number" ? source.actual : null;
    if (actual === null) return typed;
    const entity = typeof source.entity === "string" ? source.entity : null;
    const key = typeof source.key === "string" ? source.key : null;
    const base: Record<string, unknown> = {
      ...source,
      ...(expected === null ? {} : { expected, expected_version: expected }),
      actual,
      current_version: actual,
      ...(expected === null ? {} : { version_gap: actual - expected }),
    };
    if (!context.projectCode) return typed.withDetails(base as AtmBaseErrorDetails);
    try {
      if ((entity === "CHECKLIST" || context.checklistId) && (key || context.checklistId)) {
        const checklistId = String(key ?? context.checklistId);
        const [current, recentChanges] = await Promise.all([
          this.checklistConflictSnapshot(context.projectCode, checklistId),
          this.recentChecklistChanges(context.projectCode, checklistId, 6),
        ]);
        return typed.withDetails({
          ...base,
          entity: "CHECKLIST",
          key: checklistId,
          checklist_id: checklistId,
          task_key: current.taskKey,
          current: {
            id: current.id,
            task_key: current.taskKey,
            task_version: current.taskVersion,
            title: current.title,
            status: current.status,
            evidence_required: current.evidenceRequired,
            evidence_count: current.evidenceCount,
            version: current.version,
            updated_at: current.updatedAt,
          },
          recent_changes: recentChanges.slice(0, 6).map((change) => ({
            seq: change.seq,
            type: change.type,
            key: change.key,
            summary: change.summary,
            op_id: change.opId,
            at: change.at,
          })),
          changes_complete: false,
        });
      }
      const taskKey = String(key ?? context.taskKey ?? "");
      if ((entity === "WORK_ITEM" || context.taskKey) && taskKey) {
        const [current, recentChanges] = await Promise.all([
          this.getWorkItemForUi(context.projectCode, taskKey),
          this.recentWorkItemChanges(context.projectCode, taskKey, 6),
        ]);
        return typed.withDetails({
          ...base,
          entity: "WORK_ITEM",
          key: taskKey,
          task_key: taskKey,
          current: {
            key: current.key,
            version: current.version,
            status: current.status,
            phase: current.phase,
            title: current.title,
            description: current.description,
            assignee_agent_id: current.assigneeAgentId,
            claimed_by_session_id: current.claimedBySessionId,
            target_date: current.targetDate,
            parent_key: current.parentKey,
            cancel_reason: current.cancelReason,
            duplicate_of: current.duplicateOf,
            superseded_by: current.supersededBy,
            updated_at: current.updatedAt,
          },
          recent_changes: recentChanges.slice(0, 6).map((change) => ({
            seq: change.seq,
            type: change.type,
            key: change.key,
            summary: change.summary,
            op_id: change.opId,
            at: change.at,
          })),
          changes_complete: false,
        });
      }
    } catch {
      return typed.withDetails(base as AtmBaseErrorDetails);
    }
    return typed.withDetails(base as AtmBaseErrorDetails);
  }

  async listRecords(projectCode: string, limit = 100) {
    return (await this.#repository(projectCode)).listRecords(limit);
  }

  async getRecord(projectCode: string, reference: string) {
    return (await this.#repository(projectCode)).getRecord(reference);
  }

  async getProgressUpdate(projectCode: string, id: string) {
    return (await this.#repository(projectCode)).getProgressUpdate(id);
  }

  async listProjectUpdates(projectCode: string, limit = 50) {
    return (await this.#repository(projectCode)).listProjectUpdates(limit);
  }

  async getProjectUpdate(projectCode: string, id: string) {
    return (await this.#repository(projectCode)).getProjectUpdate(id);
  }

  async draftProjectUpdateAsUser(projectCode: string, opId: string) {
    const repository = await this.#repository(projectCode);
    const result = repository.draftProjectUpdate(this.#userActor(), opId);
    await this.#flush(projectCode);
    return result;
  }

  async publishProjectUpdateAsUser(
    projectCode: string,
    opId: string,
    input: Parameters<ProjectRepository["publishProjectUpdate"]>[2],
  ) {
    const repository = await this.#repository(projectCode);
    const result = repository.publishProjectUpdate(this.#userActor(), opId, input);
    await this.#flush(projectCode);
    return result;
  }

  async createObjective(
    projectCode: string,
    sessionId: string,
    input: { title: string; description: string; definitionOfDone: string[] },
  ): Promise<any> {
    const repository = await this.#repository(projectCode);
    const result = repository.createObjective(await this.#actor(projectCode, sessionId), input);
    await this.#flush(projectCode);
    return result;
  }

  async createObjectiveAsUser(
    projectCode: string,
    opId: string,
    input: { title: string; description: string; definitionOfDone: string[] },
  ): Promise<any> {
    const repository = await this.#repository(projectCode);
    const result = repository.createObjective(this.#userActor(), input, opId);
    await this.#flush(projectCode);
    return result;
  }

  async createMilestone(
    projectCode: string,
    sessionId: string,
    input: { objectiveId: string; title: string; description?: string; targetDate?: string | null },
  ): Promise<any> {
    const repository = await this.#repository(projectCode);
    const result = repository.createMilestone(await this.#actor(projectCode, sessionId), input);
    await this.#flush(projectCode);
    return result;
  }

  async createMilestoneAsUser(
    projectCode: string,
    opId: string,
    input: { objectiveId: string; title: string; description?: string; targetDate?: string | null },
  ): Promise<any> {
    const repository = await this.#repository(projectCode);
    const result = repository.createMilestone(this.#userActor(), input, opId);
    await this.#flush(projectCode);
    return result;
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
    await this.#flush(projectCode);
    return mutationAck(execution.result, opId, execution.resolution);
  }

  async createWorkItemsAsUser(
    projectCode: string,
    opId: string,
    items: Parameters<ProjectRepository["createWorkItems"]>[2],
  ): Promise<ReturnType<ProjectRepository["createWorkItems"]>> {
    const repository = await this.#repository(projectCode);
    const result = repository.createWorkItems(this.#userActor(), opId, items);
    await this.#flush(projectCode);
    return result;
  }

  async patchWorkItems(
    projectCode: string,
    sessionId: string,
    opId: string,
    patches: Parameters<ProjectRepository["patchWorkItems"]>[2],
  ) {
    const repository = await this.#repository(projectCode);
    const execution = repository.executeSessionMutation(
      sessionId,
      opId,
      "work.patch.batch",
      patches,
      (actor) => repository.patchWorkItems(actor, opId, patches),
    );
    if (patches.some((patch) => ["verify", "complete"].includes(String(patch.operation)))) {
      await this.#refreshSessionGitContext(
        projectCode,
        String(execution.resolution.actor.sessionId),
      );
    }
    await this.#flush(projectCode);
    const starts = patches
      .filter((patch) => ["start", "claim"].includes(String(patch.operation)))
      .map((patch) => patch.taskKey);
    const finishes = patches
      .filter((patch) => ["complete", "cancel"].includes(String(patch.operation)))
      .map((patch) => patch.taskKey);
    await this.#captureWorkItemEngineeringMetrics(projectCode, starts, true);
    await this.#captureWorkItemEngineeringMetrics(projectCode, finishes, false);
    return mutationAck(execution.result, opId, execution.resolution);
  }

  async patchWorkItemsAsUser(
    projectCode: string,
    opId: string,
    patches: Parameters<ProjectRepository["patchWorkItems"]>[2],
  ): Promise<ReturnType<ProjectRepository["patchWorkItems"]>> {
    const repository = await this.#repository(projectCode);
    const result = repository.patchWorkItems(this.#userActor(), opId, patches);
    await this.#flush(projectCode);
    const starts = patches
      .filter((patch) => ["start", "claim"].includes(String(patch.operation)))
      .map((patch) => patch.taskKey);
    const finishes = patches
      .filter((patch) => ["complete", "cancel"].includes(String(patch.operation)))
      .map((patch) => patch.taskKey);
    await this.#captureWorkItemEngineeringMetrics(projectCode, starts, true);
    await this.#captureWorkItemEngineeringMetrics(projectCode, finishes, false);
    return result;
  }

  async verifyAndComplete(
    projectCode: string,
    sessionId: string,
    opId: string,
    input: Parameters<ProjectRepository["verifyAndComplete"]>[2],
  ) {
    const repository = await this.#repository(projectCode);
    const execution = repository.executeSessionMutation(
      sessionId,
      opId,
      "work.verify-and-complete",
      input,
      (actor) => repository.verifyAndComplete(actor, opId, input),
    );
    await this.#refreshSessionGitContext(projectCode, String(execution.resolution.actor.sessionId));
    await this.#flush(projectCode);
    await this.#captureWorkItemEngineeringMetrics(projectCode, [input.taskKey], false);
    return mutationAck(execution.result, opId, execution.resolution);
  }

  async verifyAndCompleteAsUser(
    projectCode: string,
    opId: string,
    input: Parameters<ProjectRepository["verifyAndComplete"]>[2],
  ): Promise<ReturnType<ProjectRepository["verifyAndComplete"]>> {
    const repository = await this.#repository(projectCode);
    const result = repository.verifyAndComplete(this.#userActor(), opId, input);
    await this.#flush(projectCode);
    await this.#captureWorkItemEngineeringMetrics(projectCode, [input.taskKey], false);
    return result;
  }

  async listWorkItems(
    projectCode: string,
    filters?: Parameters<ProjectRepository["listWorkItems"]>[0],
    view: TaskViewName = "core",
  ): Promise<TaskView[]> {
    const repository = await this.#repository(projectCode);
    if (
      filters?.milestoneId &&
      !repository.listMilestones().some((milestone) => milestone.id === filters.milestoneId)
    ) {
      throw new AtmError("MILESTONE_NOT_FOUND", {
        message: `里程碑不存在：${filters.milestoneId}`,
        details: { entity: "MILESTONE", reference: filters.milestoneId },
      });
    }
    return repository
      .listTaskViewRows(filters, view)
      .map((row) => projectTaskView(projectCode, row, view));
  }

  /** Desktop-only operational metadata kept outside the bounded Agent read views. */
  async listWorkItemsForUi(
    projectCode: string,
    filters?: Parameters<ProjectRepository["listWorkItems"]>[0],
  ): Promise<ReturnType<ProjectRepository["listWorkItems"]>> {
    return (await this.#repository(projectCode)).listWorkItems(filters);
  }

  async assertMilestonesExist(
    projectCode: string,
    milestoneIds: Array<string | null | undefined>,
  ): Promise<void> {
    assertKnownMilestones(await this.#repository(projectCode), milestoneIds);
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
    const project = this.databases.getProject(projectCode);
    const repository = await this.#repository(project.code);
    const tasks: ReturnType<ProjectRepository["listWorkItems"]> = [];
    for (let offset = 0; ; offset += 100) {
      const page = repository.listWorkItems({ limit: 100, offset });
      tasks.push(...page);
      if (page.length < 100) break;
    }

    const previouslyClaimedKeys = new Set<string>();
    let sinceSequence = 0;
    for (;;) {
      const page = repository.delta(sinceSequence, 100, ["work.claimed", "work.started"]);
      for (const event of page.events) {
        if (event.key) previouslyClaimedKeys.add(event.key);
      }
      if (!page.hasMore) break;
      const nextSequence = page.events.at(-1)?.seq ?? sinceSequence;
      if (nextSequence <= sinceSequence) break;
      sinceSequence = nextSequence;
    }

    const sessions = repository.listAgentSessions(200);
    const knownSessionIds = new Set(sessions.map((session) => String(session.id)));
    for (const task of tasks) {
      const sessionId = task.claimedBySessionId;
      if (!sessionId || knownSessionIds.has(sessionId)) continue;
      try {
        const session = repository.getSession(sessionId);
        sessions.push({
          ...session,
          last_seen_at: session.heartbeat_at ?? session.updated_at ?? null,
          ended_at: session.closed_at ?? null,
        });
        knownSessionIds.add(sessionId);
      } catch {
        // Missing claim owners remain visible as stalled rather than making reconciliation fail.
      }
    }

    const result = reconcileWorkItems({
      sourceRoot: project.sourcePaths[0] ?? null,
      tasks,
      sessions,
      previouslyClaimedKeys,
      includeActive: input.includeActive ?? false,
    });
    return {
      project: {
        code: project.code,
        name: project.name,
        sourceRoot: project.sourcePaths[0] ?? null,
      },
      ...result,
    };
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
    const repository = await this.#repository(projectCode);
    // Internal mutation/test callers predating the bounded read contract can omit
    // a view and retain the repository aggregate. Every REST/MCP/UI query passes
    // an explicit canonical view and therefore cannot leak this legacy shape.
    if (view === undefined) return repository.getWorkItem(taskKey);
    return projectTaskView(projectCode, repository.getTaskViewRow(taskKey, view), view);
  }

  /** Desktop-only aggregate for operational controls such as lease release and tree layout. */
  async getWorkItemForUi(
    projectCode: string,
    taskKey: string,
  ): Promise<ReturnType<ProjectRepository["getWorkItem"]>> {
    return (await this.#repository(projectCode)).getWorkItem(taskKey);
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
    const execution = repository.executeSessionMutation(
      sessionId,
      opId,
      "review.request.create",
      normalizedInput,
      (actor) => repository.createReviewRequest(actor, opId, normalizedInput),
    );
    await this.#flush(projectCode);
    return mutationAck(execution.result, opId, execution.resolution);
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
    const execution = repository.executeSessionMutation(
      sessionId,
      opId,
      "review.submit",
      normalizedInput,
      (actor) => repository.submitReview(actor, opId, normalizedInput),
    );
    await this.#flush(projectCode);
    return mutationAck(execution.result, opId, execution.resolution);
  }

  async updateChecklist(
    projectCode: string,
    sessionId: string,
    opId: string,
    input: Parameters<ProjectRepository["updateChecklist"]>[2],
  ) {
    const repository = await this.#repository(projectCode);
    const execution = repository.executeSessionMutation(
      sessionId,
      opId,
      "checklist.update",
      input,
      (actor) => repository.updateChecklist(actor, opId, input),
    );
    await this.#flush(projectCode);
    return mutationAck(execution.result, opId, execution.resolution);
  }

  async updateChecklistAsUser(
    projectCode: string,
    opId: string,
    input: Parameters<ProjectRepository["updateChecklist"]>[2],
  ): Promise<ReturnType<ProjectRepository["updateChecklist"]>> {
    const repository = await this.#repository(projectCode);
    const result = repository.updateChecklist(this.#userActor(), opId, input);
    await this.#flush(projectCode);
    return result;
  }

  async updateChecklistBatch(
    projectCode: string,
    sessionId: string,
    opId: string,
    input: Parameters<ProjectRepository["updateChecklistBatch"]>[2],
  ) {
    const repository = await this.#repository(projectCode);
    const execution = repository.executeSessionMutation(
      sessionId,
      opId,
      "checklist.update.batch",
      input,
      (actor) => repository.updateChecklistBatch(actor, opId, input),
    );
    await this.#flush(projectCode);
    return mutationAck(execution.result, opId, execution.resolution);
  }

  async updateChecklistBatchAsUser(
    projectCode: string,
    opId: string,
    input: Parameters<ProjectRepository["updateChecklistBatch"]>[2],
  ): Promise<ReturnType<ProjectRepository["updateChecklistBatch"]>> {
    const repository = await this.#repository(projectCode);
    const result = repository.updateChecklistBatch(this.#userActor(), opId, input);
    await this.#flush(projectCode);
    return result;
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
    await this.#flush(projectCode);
    return mutationAck(execution.result, opId, execution.resolution);
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
    await this.#flush(projectCode);
    const openWorkItems = repository
      .listWorkItems({ limit: 500 })
      .filter((item) => !["DONE", "CANCELLED"].includes(item.status) && !linkedKeys.has(item.key))
      .slice(0, 20)
      .map((item) => item.key);
    return {
      ...mutationAck(execution.result, opId, execution.resolution),
      unlinked:
        completed.length > 0 &&
        completed.some((entry) => typeof entry === "string" || !entry.workItemKey),
      openWorkItems,
    };
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
    await this.#flush(projectCode);
    return mutationAck(execution.result, opId, execution.resolution);
  }

  async createRecordAsUser(
    projectCode: string,
    opId: string,
    input: Parameters<ProjectRepository["createRecord"]>[2],
  ): Promise<ReturnType<ProjectRepository["createRecord"]>> {
    const repository = await this.#repository(projectCode);
    const result = repository.createRecord(this.#userActor(), opId, {
      ...input,
      sourceType: "USER",
      sourceActorId: "USER",
      sourceSessionId: null,
    });
    await this.#flush(projectCode);
    return result;
  }

  async search(projectCode: string, query: string, limit = 20, cursor?: string) {
    return (await this.#repository(projectCode)).search(query, limit, cursor);
  }

  globalSearch(query: string, limit = 20, cursor?: string) {
    return this.databases.globalSearch(query, limit, cursor);
  }

  globalDelta(sinceSequence: number, limit = 50) {
    return this.databases.globalDelta(sinceSequence, limit);
  }

  async delta(projectCode: string, sinceSequence: number, limit = 50, types: string[] = []) {
    return (await this.#repository(projectCode)).delta(sinceSequence, limit, types);
  }

  async recentWorkItemChanges(projectCode: string, taskKey: string, limit = 6) {
    return (await this.#repository(projectCode)).recentWorkItemChanges(taskKey, limit);
  }

  async checklistConflictSnapshot(projectCode: string, checklistId: string) {
    return (await this.#repository(projectCode)).checklistConflictSnapshot(checklistId);
  }

  async recentChecklistChanges(projectCode: string, checklistId: string, limit = 6) {
    return (await this.#repository(projectCode)).recentChecklistChanges(checklistId, limit);
  }

  async getOperationTrace(projectCode: string, opId: string, sessionId?: string | null) {
    return (await this.#repository(projectCode)).getOperationTrace(opId, sessionId);
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
    const claimedTaskKeys = repository
      .listWorkItems({ limit: 500 })
      .filter((task) => task.claimedBySessionId === effectiveSessionId)
      .map((task) => task.key);
    if (resolution.disposition !== "REPLAY") {
      await this.#refreshSessionGitContext(projectCode, effectiveSessionId);
    }
    const result = repository.endSession(resolution.actor, opId, input);
    await this.#flush(projectCode);
    await this.#captureWorkItemEngineeringMetrics(projectCode, claimedTaskKeys, false);
    return mutationAck(result, opId, resolution);
  }

  async forceCloseSessionAsUser(projectCode: string, sessionId: string, releaseClaims = true) {
    const repository = await this.#repository(projectCode);
    const result = repository.forceCloseSession(sessionId, releaseClaims);
    await this.#flush(projectCode);
    return result;
  }

  async refreshSessionGitContextAsUser(projectCode: string, sessionId: string) {
    const result = await this.#refreshSessionGitContext(projectCode, sessionId);
    await this.#flush(projectCode);
    return { ...result, session: (await this.#repository(projectCode)).getSession(sessionId) };
  }

  async doctor(): Promise<Awaited<ReturnType<AyanamiDatabaseManager["doctor"]>>> {
    return this.databases.doctor();
  }

  close(): void {
    this.#repositories.clear();
    this.databases.close();
  }
}
