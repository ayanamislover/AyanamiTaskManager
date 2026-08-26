import { basename } from "node:path";
import { EventEmitter } from "node:events";
import { classifyTaskScope } from "@ayanami-task/domain";
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
  type ProjectActor,
  type RegisteredProject,
} from "@ayanami-task/storage-sqlite";
import { parseAgentTaskMarkdown } from "./agenttask-import.js";

export * from "./agenttask-import.js";

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
      return {
        available: false,
        reason: error instanceof Error ? error.message.split(":", 1)[0] : "METRICS_FAILED",
        message: error instanceof Error ? error.message : String(error),
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
      throw new Error("IMPORT_SOURCE_CHANGED: 源文件已在预览后发生变化");
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
      if (!objectiveId) throw new Error(`IMPORT_OBJECTIVE_MISSING: ${milestone.objectiveRef}`);
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
          if (!objectiveId) throw new Error(`IMPORT_OBJECTIVE_MISSING: ${task.objectiveRef}`);
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
    if (session.connection_state === "CLOSED") throw new Error(`SESSION_CLOSED: ${sessionId}`);
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
      throw new Error("OPERATION_ID_INVALID");
    }
    let project = input.projectCode ? this.databases.getProject(input.projectCode) : null;
    if (!project && input.cwd) project = this.databases.identifyProject(input.cwd);
    if (operationId && !project) {
      throw new Error("ATOMIC_BEGIN_REQUIRES_EXISTING_PROJECT");
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
      if (!input.allowProjectCreate) throw new Error("PROJECT_REQUIRED");
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

  async listRecords(projectCode: string, limit = 100) {
    return (await this.#repository(projectCode)).listRecords(limit);
  }

  async listProjectUpdates(projectCode: string, limit = 50) {
    return (await this.#repository(projectCode)).listProjectUpdates(limit);
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
  ): Promise<ReturnType<ProjectRepository["createWorkItems"]>> {
    const repository = await this.#repository(projectCode);
    const result = repository.createWorkItems(
      await this.#actor(projectCode, sessionId),
      opId,
      items,
    );
    await this.#flush(projectCode);
    return result;
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
  ): Promise<ReturnType<ProjectRepository["patchWorkItems"]>> {
    const repository = await this.#repository(projectCode);
    const result = repository.patchWorkItems(
      await this.#actor(projectCode, sessionId),
      opId,
      patches,
    );
    if (patches.some((patch) => ["verify", "complete"].includes(String(patch.operation)))) {
      await this.#refreshSessionGitContext(projectCode, sessionId);
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
    return result;
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

  async listWorkItems(
    projectCode: string,
    filters?: Parameters<ProjectRepository["listWorkItems"]>[0],
  ): Promise<ReturnType<ProjectRepository["listWorkItems"]>> {
    return (await this.#repository(projectCode)).listWorkItems(filters);
  }

  async getWorkItem(
    projectCode: string,
    taskKey: string,
    _view: "core" | "context" | "full" = "core",
  ): Promise<ReturnType<ProjectRepository["getWorkItem"]>> {
    return (await this.#repository(projectCode)).getWorkItem(taskKey);
  }

  async updateChecklist(
    projectCode: string,
    sessionId: string,
    opId: string,
    input: Parameters<ProjectRepository["updateChecklist"]>[2],
  ): Promise<ReturnType<ProjectRepository["updateChecklist"]>> {
    const repository = await this.#repository(projectCode);
    const result = repository.updateChecklist(
      await this.#actor(projectCode, sessionId),
      opId,
      input,
    );
    await this.#flush(projectCode);
    return result;
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

  async addProgress(
    projectCode: string,
    sessionId: string,
    opId: string,
    input: Parameters<ProjectRepository["addProgress"]>[2],
  ): Promise<ReturnType<ProjectRepository["addProgress"]>> {
    const repository = await this.#repository(projectCode);
    const result = repository.addProgress(await this.#actor(projectCode, sessionId), opId, input);
    await this.#refreshSessionGitContext(projectCode, sessionId);
    await this.#flush(projectCode);
    return result;
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
    const result = repository.publishProjectUpdate(
      await this.#actor(projectCode, sessionId),
      opId,
      {
        health: input.health ?? (input.blocker ? "AT_RISK" : "UNKNOWN"),
        summary: input.summary,
        completed: completed.map((entry) => (typeof entry === "string" ? entry : entry.text)),
        risks: input.blocker ? [input.blocker] : [],
        next: input.next ?? [],
      },
    );
    await this.#refreshSessionGitContext(projectCode, sessionId);
    await this.#flush(projectCode);
    const openWorkItems = repository
      .listWorkItems({ limit: 500 })
      .filter((item) => !["DONE", "CANCELLED"].includes(item.status) && !linkedKeys.has(item.key))
      .slice(0, 20)
      .map((item) => item.key);
    return {
      ...result,
      opId,
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
  ): Promise<ReturnType<ProjectRepository["createRecord"]>> {
    const repository = await this.#repository(projectCode);
    const result = repository.createRecord(await this.#actor(projectCode, sessionId), opId, input);
    await this.#flush(projectCode);
    return result;
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

  async search(projectCode: string, query: string, limit = 20) {
    return (await this.#repository(projectCode)).search(query, limit);
  }

  globalSearch(query: string, limit = 20) {
    return this.databases.globalSearch(query, limit);
  }

  globalDelta(sinceSequence: number, limit = 50) {
    return this.databases.globalDelta(sinceSequence, limit);
  }

  async delta(projectCode: string, sinceSequence: number, limit = 50, types: string[] = []) {
    return (await this.#repository(projectCode)).delta(sinceSequence, limit, types);
  }

  async end(
    projectCode: string,
    sessionId: string,
    opId: string,
    input: Parameters<ProjectRepository["endSession"]>[2],
  ): Promise<ReturnType<ProjectRepository["endSession"]>> {
    const repository = await this.#repository(projectCode);
    const claimedTaskKeys = repository
      .listWorkItems({ limit: 500 })
      .filter((task) => task.claimedBySessionId === sessionId)
      .map((task) => task.key);
    await this.#refreshSessionGitContext(projectCode, sessionId);
    const result = repository.endSession(await this.#actor(projectCode, sessionId), opId, input);
    await this.#flush(projectCode);
    await this.#captureWorkItemEngineeringMetrics(projectCode, claimedTaskKeys, false);
    return result;
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
