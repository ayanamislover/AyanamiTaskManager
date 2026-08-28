import type { AtmError } from "@ayanami-task/errors";
import {
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
  AyanamiDatabaseManager,
  ProjectRepository,
  type ProjectionReceipt,
  type RecordPageFilters,
  type RegisteredProject,
  type SessionPageFilters,
  type WorkItemListFilters,
  type WorkItemPageFilters,
} from "@ayanami-task/storage-sqlite";
import { ProjectCommands } from "./commands/project-commands.js";
import { RecordCommands } from "./commands/record-commands.js";
import { ReviewCommands } from "./commands/review-commands.js";
import { SessionCommands } from "./commands/session-commands.js";
import { WorkItemCommands } from "./commands/work-item-commands.js";
import { ProjectionCoordinator } from "./coordinators/projection-coordinator.js";
import * as errorEnrichment from "./errors/error-enrichment.js";
import type { PublicNotFoundDetails } from "./errors/error-enrichment.js";
import { EngineeringMetricsObserver } from "./observers/engineering-metrics-observer.js";
import * as projectQueries from "./queries/project-queries.js";
import * as readQueries from "./queries/read-queries.js";
import * as reconciliationQueries from "./queries/reconciliation-queries.js";
import * as taskQueries from "./queries/task-queries.js";
import { ApplicationServiceRuntime } from "./runtime/service-runtime.js";

export * from "./agenttask-import.js";
export * from "./reconcile.js";
export * from "./queries/task-views.js";
export type { PublicNotFoundDetails } from "./errors/error-enrichment.js";

export class AyanamiTaskService {
  readonly databases: AyanamiDatabaseManager;
  readonly #runtime: ApplicationServiceRuntime;
  readonly #projectionCoordinator: ProjectionCoordinator;
  readonly #metricsObserver: EngineeringMetricsObserver;
  readonly #projectCommands: ProjectCommands;
  readonly #sessionCommands: SessionCommands;
  readonly #workItemCommands: WorkItemCommands;
  readonly #reviewCommands: ReviewCommands;
  readonly #recordCommands: RecordCommands;

  private constructor(databases: AyanamiDatabaseManager) {
    this.databases = databases;
    this.#runtime = new ApplicationServiceRuntime(databases);
    this.#projectionCoordinator = new ProjectionCoordinator(this.#runtime);
    this.#metricsObserver = new EngineeringMetricsObserver(this.#runtime);
    this.#projectCommands = new ProjectCommands(this.#runtime, this.#projectionCoordinator);
    this.#sessionCommands = new SessionCommands(
      this.#runtime,
      this.#projectionCoordinator,
      this.#metricsObserver,
    );
    this.#workItemCommands = new WorkItemCommands(
      this.#runtime,
      this.#projectionCoordinator,
      this.#metricsObserver,
      this.#sessionCommands,
      (error, context) => this.enrichError(error, context),
    );
    this.#reviewCommands = new ReviewCommands(
      this.#runtime,
      this.#projectionCoordinator,
      (error, context) => this.enrichError(error, context),
    );
    this.#recordCommands = new RecordCommands(
      this.#runtime,
      this.#projectionCoordinator,
      this.#sessionCommands,
    );
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
    return this.#projectCommands.createProject(input);
  }

  listProjects(): RegisteredProject[] {
    return projectQueries.listProjects(this.#runtime);
  }

  attachProjectPath(projectCode: string, path: string, primary = true) {
    return this.#projectCommands.attachProjectPath(projectCode, path, primary);
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
    return this.#projectionCoordinator.reconcileProjection(projectCode);
  }

  async reconcileProjections(): Promise<ProjectionBatchReceipt> {
    return this.#projectionCoordinator.reconcileProjections((projectCode) =>
      this.reconcileProjection(projectCode),
    );
  }

  async engineeringMetrics(
    projectCode: string,
    input: { taskKey?: string; refresh?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    return this.#metricsObserver.engineeringMetrics(projectCode, input);
  }

  listSavedViews(projectCode?: string) {
    return projectQueries.listSavedViews(this.#runtime, projectCode);
  }

  createSavedView(input: Parameters<AyanamiDatabaseManager["createSavedView"]>[0]) {
    return this.#projectCommands.createSavedView(input);
  }

  updateSavedView(id: string, input: Parameters<AyanamiDatabaseManager["updateSavedView"]>[1]) {
    return this.#projectCommands.updateSavedView(id, input);
  }

  deleteSavedView(id: string, expectedVersion: number) {
    return this.#projectCommands.deleteSavedView(id, expectedVersion);
  }

  listSettings() {
    return projectQueries.listSettings(this.#runtime);
  }

  getSetting<T = unknown>(key: string, fallback?: T) {
    return projectQueries.getSetting(this.#runtime, key, fallback);
  }

  setSetting(key: string, value: unknown, expectedVersion?: number) {
    return this.#projectCommands.setSetting(key, value, expectedVersion);
  }

  runMaintenance(at?: Date) {
    return this.#projectCommands.runMaintenance(at);
  }

  async archiveProject(projectCode: string, actor = "USER") {
    return this.#projectCommands.archiveProject(projectCode, actor);
  }

  restoreProject(projectCode: string, actor = "USER") {
    return this.#projectCommands.restoreProject(projectCode, actor);
  }

  async trashProject(projectCode: string, actor = "USER") {
    return this.#projectCommands.trashProject(projectCode, actor);
  }

  listBackups(projectCode?: string) {
    return projectQueries.listBackups(this.#runtime, projectCode);
  }

  async createBackup(input: Parameters<AyanamiDatabaseManager["createBackup"]>[0]) {
    return this.#projectCommands.createBackup(input);
  }

  async restoreBackup(backupId: string) {
    return this.#projectCommands.restoreBackup(backupId);
  }

  exportProject(projectCode: string, format: "aytproj" | "json" | "csv" = "aytproj") {
    return this.#projectCommands.exportProject(projectCode, format);
  }

  previewAgentTaskImport(projectCode: string, content: string, sourceName = "agenttask.md") {
    return this.#projectCommands.previewAgentTaskImport(projectCode, content, sourceName);
  }

  async applyAgentTaskImport(
    projectCode: string,
    content: string,
    sourceName = "agenttask.md",
    expectedSha256?: string,
  ): Promise<Record<string, unknown>> {
    return this.#projectCommands.applyAgentTaskImport(
      projectCode,
      content,
      sourceName,
      expectedSha256,
    );
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
    return this.#sessionCommands.begin(input, (projectInput) => this.createProject(projectInput));
  }

  listQuickTasks(status?: string) {
    return projectQueries.listQuickTasks(this.#runtime, status);
  }

  createQuickTask(input: Parameters<AyanamiDatabaseManager["createQuickTask"]>[0]) {
    return this.#projectCommands.createQuickTask(input);
  }

  updateQuickTask(
    idOrKey: string,
    input: Parameters<AyanamiDatabaseManager["updateQuickTask"]>[1],
  ) {
    return this.#projectCommands.updateQuickTask(idOrKey, input);
  }

  async promoteQuickTask(input: {
    quickTask: string;
    expectedVersion: number;
    targetProjectCode?: string;
    actor?: string;
  }): Promise<any> {
    return this.#projectCommands.promoteQuickTask(input, (projectInput) =>
      this.createProject(projectInput),
    );
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
    return this.#projectCommands.ensurePlanningRoot(projectCode, sessionId);
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
    return this.#recordCommands.draftProjectUpdateAsUser(projectCode, opId);
  }

  async publishProjectUpdateAsUser(
    projectCode: string,
    opId: string,
    input: Parameters<ProjectRepository["publishProjectUpdate"]>[2],
  ) {
    return this.#recordCommands.publishProjectUpdateAsUser(projectCode, opId, input);
  }

  async createObjective(
    projectCode: string,
    sessionId: string,
    input: { title: string; description: string; definitionOfDone: string[] },
  ): Promise<any> {
    return this.#workItemCommands.createObjective(projectCode, sessionId, input);
  }

  async createObjectiveAsUser(
    projectCode: string,
    opId: string,
    input: { title: string; description: string; definitionOfDone: string[] },
  ): Promise<any> {
    return this.#workItemCommands.createObjectiveAsUser(projectCode, opId, input);
  }

  async createMilestone(
    projectCode: string,
    sessionId: string,
    input: { objectiveId: string; title: string; description?: string; targetDate?: string | null },
  ): Promise<any> {
    return this.#workItemCommands.createMilestone(projectCode, sessionId, input);
  }

  async createMilestoneAsUser(
    projectCode: string,
    opId: string,
    input: { objectiveId: string; title: string; description?: string; targetDate?: string | null },
  ): Promise<any> {
    return this.#workItemCommands.createMilestoneAsUser(projectCode, opId, input);
  }

  async createWorkItems(
    projectCode: string,
    sessionId: string,
    opId: string,
    items: Parameters<ProjectRepository["createWorkItems"]>[2],
    options: { resolvePlanningRoot?: boolean } = {},
  ) {
    return this.#workItemCommands.createWorkItems(projectCode, sessionId, opId, items, options);
  }

  async createWorkItemsAsUser(
    projectCode: string,
    opId: string,
    items: Parameters<ProjectRepository["createWorkItems"]>[2],
  ): Promise<ReturnType<ProjectRepository["createWorkItems"]> & { projection: ProjectionReceipt }> {
    return this.#workItemCommands.createWorkItemsAsUser(projectCode, opId, items);
  }

  async patchWorkItems(
    projectCode: string,
    sessionId: string,
    opId: string,
    patches: Parameters<ProjectRepository["patchWorkItems"]>[2],
  ) {
    return this.#workItemCommands.patchWorkItems(projectCode, sessionId, opId, patches);
  }

  async patchWorkItemsAsUser(
    projectCode: string,
    opId: string,
    patches: Parameters<ProjectRepository["patchWorkItems"]>[2],
  ): Promise<ReturnType<ProjectRepository["patchWorkItems"]> & { projection: ProjectionReceipt }> {
    return this.#workItemCommands.patchWorkItemsAsUser(projectCode, opId, patches);
  }

  async verifyAndComplete(
    projectCode: string,
    sessionId: string,
    opId: string,
    input: Parameters<ProjectRepository["verifyAndComplete"]>[2],
  ) {
    return this.#workItemCommands.verifyAndComplete(projectCode, sessionId, opId, input);
  }

  async verifyAndCompleteAsUser(
    projectCode: string,
    opId: string,
    input: Parameters<ProjectRepository["verifyAndComplete"]>[2],
  ): Promise<
    ReturnType<ProjectRepository["verifyAndComplete"]> & { projection: ProjectionReceipt }
  > {
    return this.#workItemCommands.verifyAndCompleteAsUser(projectCode, opId, input);
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
    return this.#sessionCommands.assertSessionCanProvisionPlanningRoot(
      projectCode,
      sessionId,
      (code, id) => this.getSession(code, id),
    );
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
    return this.#reviewCommands.createReviewRequest(projectCode, sessionId, opId, input);
  }

  async getReviewRequest(projectCode: string, requestKey: string) {
    return readQueries.getReviewRequest(this.#runtime, projectCode, requestKey);
  }

  async submitReview(
    projectCode: string,
    sessionId: string,
    opId: string,
    input: Parameters<ProjectRepository["submitReview"]>[2],
  ) {
    return this.#reviewCommands.submitReview(projectCode, sessionId, opId, input);
  }

  async updateChecklist(
    projectCode: string,
    sessionId: string,
    opId: string,
    input: Parameters<ProjectRepository["updateChecklist"]>[2],
  ) {
    return this.#workItemCommands.updateChecklist(projectCode, sessionId, opId, input);
  }

  async updateChecklistAsUser(
    projectCode: string,
    opId: string,
    input: Parameters<ProjectRepository["updateChecklist"]>[2],
  ): Promise<ReturnType<ProjectRepository["updateChecklist"]> & { projection: ProjectionReceipt }> {
    return this.#workItemCommands.updateChecklistAsUser(projectCode, opId, input);
  }

  async updateChecklistBatch(
    projectCode: string,
    sessionId: string,
    opId: string,
    input: Parameters<ProjectRepository["updateChecklistBatch"]>[2],
  ) {
    return this.#workItemCommands.updateChecklistBatch(projectCode, sessionId, opId, input);
  }

  async updateChecklistBatchAsUser(
    projectCode: string,
    opId: string,
    input: Parameters<ProjectRepository["updateChecklistBatch"]>[2],
  ): Promise<
    ReturnType<ProjectRepository["updateChecklistBatch"]> & { projection: ProjectionReceipt }
  > {
    return this.#workItemCommands.updateChecklistBatchAsUser(projectCode, opId, input);
  }

  async addProgress(
    projectCode: string,
    sessionId: string,
    opId: string,
    input: Parameters<ProjectRepository["addProgress"]>[2],
  ) {
    return this.#recordCommands.addProgress(projectCode, sessionId, opId, input);
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
    return this.#recordCommands.addProjectProgress(projectCode, sessionId, opId, input);
  }

  async createRecord(
    projectCode: string,
    sessionId: string,
    opId: string,
    input: Parameters<ProjectRepository["createRecord"]>[2],
  ) {
    return this.#recordCommands.createRecord(projectCode, sessionId, opId, input);
  }

  async createRecordAsUser(
    projectCode: string,
    opId: string,
    input: Parameters<ProjectRepository["createRecord"]>[2],
  ): Promise<ReturnType<ProjectRepository["createRecord"]> & { projection: ProjectionReceipt }> {
    return this.#recordCommands.createRecordAsUser(projectCode, opId, input);
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
    return this.#sessionCommands.end(projectCode, sessionId, opId, input);
  }

  async forceCloseSessionAsUser(projectCode: string, sessionId: string, releaseClaims = true) {
    return this.#sessionCommands.forceCloseSessionAsUser(projectCode, sessionId, releaseClaims);
  }

  async refreshSessionGitContextAsUser(projectCode: string, sessionId: string) {
    return this.#sessionCommands.refreshSessionGitContextAsUser(projectCode, sessionId);
  }

  async doctor(): Promise<Awaited<ReturnType<AyanamiDatabaseManager["doctor"]>>> {
    return projectQueries.doctor(this.#runtime);
  }

  close(): void {
    this.#runtime.close();
  }
}
