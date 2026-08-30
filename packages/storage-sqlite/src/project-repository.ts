import type Database from "better-sqlite3";
import { AtmError } from "@ayanami-task/errors";
import {
  createUlid,
  type WorkItemOperation,
  type WorkItemStatus,
  type EvidenceInput,
  type SearchPage,
  type RecordView,
  type TaskViewName,
} from "@ayanami-task/protocol";
import type { ManagedDatabase } from "./database.js";
import { ChecklistCommands } from "./checklist-commands.js";
import { ContextReadModel } from "./context-read-model.js";
import { EvidenceNormalizer } from "./evidence-normalizer.js";
import { ProjectActivityReadModel } from "./project-activity-read-model.js";
import { OutboxReadModel } from "./outbox-read-model.js";
import { ProjectProjectionSource } from "./project-projection-source.js";
import { ProjectMutationKernel, type MutationInput } from "./project-mutation-kernel.js";
import { ProjectUpdateCommands } from "./project-update-commands.js";
import { MutationRequestNormalizer } from "./mutation-request-normalizer.js";
import { PlanningCommands } from "./planning-commands.js";
import { ProgressCommands } from "./progress-commands.js";
import type {
  BriefSnapshot,
  ChecklistView,
  ProgressUpdateView,
  RecordPageFilters,
  RecordProjectionPage,
  SessionPageFilters,
  SessionProjectionPage,
  SessionView,
  TaskViewProjectionPage,
  WorkItemListFilters,
  WorkItemPageFilters,
  WorkItemProjectionPage,
  WorkItemView,
} from "./read-model-types.js";

export { requestFingerprint } from "./project-mutation-kernel.js";
import { RecordReadModel } from "./record-read-model.js";
import {
  RecordCommands,
  type CreateRecordInput,
  type CreateRecordResult,
} from "./record-commands.js";
import {
  ReviewCommands,
  type CreateReviewRequestInput,
  type ReviewRequestView,
  type SubmitReviewInput,
  type SubmitReviewResult,
} from "./review-commands.js";
import { SessionReadModel } from "./session-read-model.js";
import { SessionCommands } from "./session-commands.js";
import { TaskReadModel } from "./task-read-model.js";
import type { TaskViewProjectionRow } from "./task-view-query.js";
import { WorkItemCreateCommands } from "./work-item-create-commands.js";
import { WorkItemLifecycleCommands } from "./work-item-lifecycle-commands.js";
import { WorkItemMaintenance } from "./work-item-maintenance.js";

export type {
  BriefSnapshot,
  BriefSnapshotRecord,
  ChecklistView,
  ProgressUpdateView,
  RecordPageFilters,
  RecordProjectionPage,
  SessionPageFilters,
  SessionProjectionPage,
  SessionView,
  TaskViewProjectionPage,
  WorkItemListFilters,
  WorkItemPageFilters,
  WorkItemProgressBreakdown,
  WorkItemProjectionPage,
  WorkItemView,
} from "./read-model-types.js";

export type ProjectActor = {
  type: "AGENT" | "USER" | "SYSTEM";
  id: string;
  sessionId: string | null;
};

export type SessionGitContext = {
  available: boolean;
  repoRoot: string | null;
  worktreeRoot: string | null;
  gitCommonDir: string | null;
  isLinkedWorktree: boolean | null;
  branch: string | null;
  head: string | null;
  detached: boolean | null;
  dirty: boolean | null;
  error: string | null;
};

export type CreateSessionInput = {
  agentId: string;
  displayName: string;
  clientKind: string;
  parentSessionId?: string | null;
  threadId?: string | null;
  role: "PRIMARY" | "SUBAGENT" | "REVIEWER" | "OBSERVER";
  cwd?: string | null;
  gitBranch?: string | null;
  gitHead?: string | null;
  gitContext?: SessionGitContext | null;
  resume?: boolean;
  predecessorSessionId?: string | null;
};

export type WorkItemCreateInput = {
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

/**
 * MCP-only planning policy. Supplying it makes omitted objective/milestone fields resolve from
 * the active planning root, and can provision that root inside the same transaction as the batch.
 * Direct repository callers retain the historical explicit-objective/null-milestone behaviour.
 */
export type WorkItemPlanningRoot = {
  provisionIfMissing: boolean;
  objectiveTitle: string;
  objectiveDescription: string;
  milestoneTitle: string;
};

export type { CreateRecordInput, CreateRecordResult } from "./record-commands.js";
export type {
  CreateReviewRequestInput,
  ReviewCandidateHash,
  ReviewRequestView,
  ReviewSubmissionView,
  SubmitReviewInput,
  SubmitReviewResult,
} from "./review-commands.js";

export type MutationActorResolution = {
  actor: ProjectActor;
  disposition: "CURRENT" | "REPLAY" | "REBOUND";
  requestedSessionId: string;
};

export type SessionMutationExecution<T> = {
  result: T;
  resolution: MutationActorResolution;
};

export class ProjectRepository {
  readonly database: ManagedDatabase;
  readonly #sqlite: Database.Database;
  readonly #contextReads: ContextReadModel;
  readonly #activityReads: ProjectActivityReadModel;
  readonly #checklistCommands: ChecklistCommands;
  readonly #evidenceNormalizer: EvidenceNormalizer;
  readonly #planningCommands: PlanningCommands;
  readonly #progressCommands: ProgressCommands;
  readonly #projectUpdates: ProjectUpdateCommands;
  readonly #projectionSource: ProjectProjectionSource;
  readonly #recordCommands: RecordCommands;
  readonly #recordReads: RecordReadModel;
  readonly #requestNormalizer: MutationRequestNormalizer;
  readonly #reviewCommands: ReviewCommands;
  readonly #sessionCommands: SessionCommands;
  readonly #sessionReads: SessionReadModel;
  readonly #taskReads: TaskReadModel;
  readonly #mutation: ProjectMutationKernel;
  readonly #workItemCreates: WorkItemCreateCommands;
  readonly #workItemLifecycle: WorkItemLifecycleCommands;
  readonly #workItemMaintenance: WorkItemMaintenance;

  constructor(database: ManagedDatabase) {
    this.database = database;
    this.#sqlite = database.sqlite;
    this.#mutation = new ProjectMutationKernel(this.#sqlite);
    this.#planningCommands = new PlanningCommands(this.#sqlite, this.#mutation);
    const projectCode = () => this.meta.code;
    this.#taskReads = new TaskReadModel(this.#sqlite, projectCode);
    this.#sessionReads = new SessionReadModel(this.#sqlite, projectCode, (workItemId) =>
      this.#taskReads.taskKeyForId(workItemId),
    );
    const outboxReads = new OutboxReadModel(this.#sqlite);
    this.#recordReads = new RecordReadModel(this.#sqlite, projectCode, (workItemId) =>
      this.#taskReads.taskKeyForId(workItemId),
    );
    this.#evidenceNormalizer = new EvidenceNormalizer(
      this.#sqlite,
      this.#recordReads,
      this.#taskReads,
    );
    this.#workItemMaintenance = new WorkItemMaintenance(this.#sqlite);
    this.#workItemCreates = new WorkItemCreateCommands(
      this.#sqlite,
      this.#mutation,
      this.#planningCommands,
      this.#taskReads,
      this.#workItemMaintenance,
    );
    this.#workItemLifecycle = new WorkItemLifecycleCommands(
      this.#sqlite,
      this.#mutation,
      this.#taskReads,
      this.#workItemMaintenance,
    );
    this.#checklistCommands = new ChecklistCommands(
      this.#sqlite,
      this.#mutation,
      this.#taskReads,
      this.#workItemMaintenance,
      this.#evidenceNormalizer,
    );
    this.#progressCommands = new ProgressCommands(
      this.#sqlite,
      this.#mutation,
      this.#taskReads,
      this.#workItemMaintenance,
      this.#evidenceNormalizer,
    );
    this.#projectionSource = new ProjectProjectionSource({
      sqlite: this.#sqlite,
      outboxReads,
      getActiveObjective: () => this.getActiveObjective(),
      getActiveMilestone: (objectiveId) => this.getActiveMilestone(objectiveId),
    });
    this.#requestNormalizer = new MutationRequestNormalizer(
      (reference) => this.#recordReads.recordRow(reference).id,
    );
    this.#recordCommands = new RecordCommands({
      sqlite: this.#sqlite,
      mutation: this.#mutation,
      requestNormalizer: this.#requestNormalizer,
      taskReads: this.#taskReads,
      recordReads: this.#recordReads,
      maintenance: this.#workItemMaintenance,
      projectCode,
    });
    this.#reviewCommands = new ReviewCommands({
      sqlite: this.#sqlite,
      mutation: this.#mutation,
      taskReads: this.#taskReads,
      recordReads: this.#recordReads,
      evidence: this.#evidenceNormalizer,
      maintenance: this.#workItemMaintenance,
      projectCode,
      getSession: (id) => this.getSession(id),
      getReviewRequest: (key) => this.getReviewRequest(key),
    });
    this.#sessionCommands = new SessionCommands({
      sqlite: this.#sqlite,
      mutation: this.#mutation,
      schemaVersion: () => this.database.schemaVersion,
      meta: () => this.meta,
      getSession: (id) => this.getSession(id),
      createSession: (input) => this.createSession(input),
      requestNormalizer: this.#requestNormalizer,
    });
    this.#contextReads = new ContextReadModel(
      this.#sqlite,
      () => ({ code: this.meta.code, sequence: this.meta.sequence }),
      () => this.listWorkItems({ readyOnly: true, limit: 3 }),
      (key) => this.getWorkItem(key),
      (row) => this.#recordReads.recordKey(row),
    );
    this.#projectUpdates = new ProjectUpdateCommands({
      sqlite: this.#sqlite,
      meta: () => this.meta,
      mutate: (input) => this.mutate(input),
      appendEvent: (type, actor, aggregateType, aggregateId, payload) =>
        this.appendEvent(type, actor, aggregateType, aggregateId, payload),
      listWorkItems: (filters) => this.listWorkItems(filters),
      listProjectUpdates: (limit) => this.listProjectUpdates(limit),
      normalizeEvidence: (evidence, strictTyped) => this.normalizeEvidence(evidence, strictTyped),
      rowForTaskKey: (taskKey) => this.rowForTaskKey(taskKey),
      taskKeyForId: (workItemId) => this.taskKeyForId(workItemId),
      advanceWorkItemEvidenceAt: (workItemId, at) => this.advanceWorkItemEvidenceAt(workItemId, at),
    });
    this.#activityReads = new ProjectActivityReadModel({
      sqlite: this.#sqlite,
      meta: () => this.meta,
      getSession: (id) => this.getSession(id),
      getRecord: (reference) => this.getRecord(reference),
      progressUpdateView: (row) => this.progressUpdateView(row),
      projectUpdateView: (row) => this.projectUpdateView(row),
      rowForTaskKey: (taskKey) => this.rowForTaskKey(taskKey),
      checklistConflictSnapshot: (checklistId) => this.checklistConflictSnapshot(checklistId),
    });
  }

  get meta(): { id: string; code: string; name: string; sequence: number; version: number } {
    const row = this.#sqlite.prepare("SELECT * FROM project_meta WHERE singleton = 1").get() as any;
    if (!row) throw new AtmError("PROJECT_META_MISSING", { message: "项目元数据缺失" });
    return {
      id: row.project_id,
      code: row.project_code,
      name: row.name,
      sequence: row.current_sequence,
      version: row.version,
    };
  }

  private nextNumber(name: string): number {
    return this.#mutation.nextNumber(name);
  }

  private appendEvent(
    type: string,
    actor: ProjectActor,
    aggregateType: string,
    aggregateId: string,
    payload: unknown,
    correlationId: string | null = null,
  ): number {
    return this.#mutation.appendEvent(
      type,
      actor,
      aggregateType,
      aggregateId,
      payload,
      correlationId,
    );
  }

  private mutate<T>(input: MutationInput<T>): T {
    return this.#mutation.mutate(input);
  }

  private mutateWithReplay<T>(input: MutationInput<T>): { value: T; replayed: boolean } {
    return this.#mutation.mutateWithReplay(input);
  }

  createSession(input: CreateSessionInput): { id: string; sequence: number } {
    return this.#sessionCommands.createSession(input);
  }

  recoverOrCreateSession(
    operationId: string,
    request: unknown,
    input: CreateSessionInput,
  ): { id: string; sequence: number; disposition: "CREATED" | "RECOVERED" } {
    return this.#sessionCommands.recoverOrCreateSession(operationId, request, input);
  }

  getSession(id: string): any {
    return this.#sessionReads.getSession(id);
  }

  getSessionView(id: string): SessionView {
    return this.#sessionReads.sessionViewFromRow(this.getSession(id));
  }

  private normalizeMutationRequest(operation: string, request: unknown): unknown {
    return this.#requestNormalizer.normalize(operation, request);
  }

  /** Resolve exact replay or a safe successor before the application rejects a closed Session. */
  resolveMutationActor(
    sessionId: string,
    opId: string,
    operation: string,
    request: unknown,
  ): MutationActorResolution {
    return this.#sessionCommands.resolveMutationActor(sessionId, opId, operation, request);
  }

  executeSessionMutation<T>(
    sessionId: string,
    opId: string,
    operation: string,
    request: unknown,
    action: (actor: ProjectActor) => T,
  ): SessionMutationExecution<T> {
    return this.#sessionCommands.executeSessionMutation(
      sessionId,
      opId,
      operation,
      request,
      action,
    );
  }

  updateSessionGitContext(
    id: string,
    context: SessionGitContext,
  ): { updated: boolean; sequence: number } {
    return this.#sessionCommands.updateSessionGitContext(id, context);
  }

  getActiveObjective(): any | null {
    return this.#planningCommands.getActiveObjective();
  }

  getActiveMilestone(objectiveId?: string): any | null {
    return this.#planningCommands.getActiveMilestone(objectiveId);
  }

  listObjectives(): any[] {
    return this.#planningCommands.listObjectives();
  }

  listMilestones(objectiveId?: string): any[] {
    return this.#planningCommands.listMilestones(objectiveId);
  }

  listAgentSessionPage(filters: SessionPageFilters = {}): SessionProjectionPage {
    return this.#sessionReads.listAgentSessionPage(filters);
  }

  listAgentSessions(limit = 100): any[] {
    return this.#sessionReads.listAgentSessions(limit);
  }

  countAgentSessions(): number {
    return this.#sessionReads.countAgentSessions();
  }

  recoverStaleSessions(cutoffIso: string): number {
    return this.#sessionCommands.recoverStaleSessions(cutoffIso);
  }

  forceCloseSession(
    sessionId: string,
    releaseClaims: boolean,
  ): { ok: 1; session: string; released: number; seq: number } {
    return this.#sessionCommands.forceCloseSession(sessionId, releaseClaims);
  }

  listRecordPage(filters: RecordPageFilters = {}): RecordProjectionPage {
    return this.#recordReads.listRecordPage(filters);
  }

  listRecords(limit = 100): RecordView[] {
    return this.listRecordPage({ limit }).items;
  }

  private recordKey(row: { local_no: number; kind: string }): string {
    return this.#recordReads.recordKey(row);
  }

  private recordRow(reference: string): any {
    return this.#recordReads.recordRow(reference);
  }

  getRecord(reference: string): RecordView {
    return this.#recordReads.getRecord(reference);
  }

  private progressUpdateView(row: any): ProgressUpdateView {
    return this.#recordReads.progressUpdateView(row);
  }

  getProgressUpdate(id: string): ProgressUpdateView {
    return this.#recordReads.getProgressUpdate(id);
  }

  getOperationTrace(opId: string, sessionId?: string | null): any {
    return this.#activityReads.getOperationTrace(opId, sessionId);
  }

  private projectUpdateView(row: any): any {
    return this.#projectUpdates.projectUpdateView(row);
  }

  getProjectUpdate(id: string): any {
    return this.#projectUpdates.getProjectUpdate(id);
  }

  listProjectUpdates(limit = 50): any[] {
    return this.#projectUpdates.listProjectUpdates(limit);
  }

  draftProjectUpdate(actor: ProjectActor, opId: string): any {
    return this.#projectUpdates.draftProjectUpdate(actor, opId);
  }

  publishProjectUpdate(
    actor: ProjectActor,
    opId: string,
    input: {
      draftId?: string | null;
      health: "ON_TRACK" | "AT_RISK" | "OFF_TRACK" | "UNKNOWN";
      summary: string;
      completed?: Array<string | { text: string; workItemKey?: string }>;
      risks?: string[];
      next?: string[];
      evidence?: EvidenceInput[];
    },
  ): any {
    return this.#projectUpdates.publishProjectUpdate(actor, opId, input);
  }

  createObjective(
    actor: ProjectActor,
    input: { title: string; description: string; definitionOfDone: string[] },
    opId = `objective-${createUlid()}`,
  ): any {
    return this.#planningCommands.createObjective(actor, input, opId);
  }

  createMilestone(
    actor: ProjectActor,
    input: { objectiveId: string; title: string; description?: string; targetDate?: string | null },
    opId = `milestone-${createUlid()}`,
  ): any {
    return this.#planningCommands.createMilestone(actor, input, opId);
  }

  private rowForTaskKey(taskKey: string): any {
    return this.#taskReads.rowForTaskKey(taskKey);
  }

  private workItemViewFromRow(row: any): WorkItemView {
    return this.#taskReads.workItemViewFromRow(row);
  }

  private taskKeyForId(workItemId: string): string | null {
    return this.#taskReads.taskKeyForId(workItemId);
  }

  private recordWorkItemLifecycleAt(workItemId: string, at: string, started: boolean): void {
    this.#workItemMaintenance.recordWorkItemLifecycleAt(workItemId, at, started);
  }

  private advanceWorkItemEvidenceAt(workItemId: string, at: string): void {
    this.#workItemMaintenance.advanceWorkItemEvidenceAt(workItemId, at);
  }

  private normalizeEvidence(evidence: unknown[], strictTyped = false): unknown[] {
    return this.#evidenceNormalizer.normalize(evidence, strictTyped);
  }

  getWorkItem(taskKey: string): WorkItemView & {
    checklist: ChecklistView[];
    dependencies: string[];
    discoveredFrom: string | null;
    discovered: string[];
    executionSession: Record<string, unknown> | null;
  } {
    return this.#taskReads.getWorkItem(taskKey);
  }

  private reviewRequestRow(requestKey: string): any {
    return this.#reviewCommands.reviewRequestRow(requestKey);
  }

  private reviewRequestKey(localNo: number): string {
    return this.#reviewCommands.reviewRequestKey(localNo);
  }

  private reviewSubmissionKey(localNo: number): string {
    return this.#reviewCommands.reviewSubmissionKey(localNo);
  }

  getReviewRequest(requestKey: string): ReviewRequestView {
    return this.#reviewCommands.getReviewRequest(requestKey);
  }

  createReviewRequest(
    actor: ProjectActor,
    opId: string,
    input: CreateReviewRequestInput,
  ): { request: ReviewRequestView; sequence: number } {
    return this.#reviewCommands.createReviewRequest(actor, opId, input);
  }

  submitReview(actor: ProjectActor, opId: string, input: SubmitReviewInput): SubmitReviewResult {
    return this.#reviewCommands.submitReview(actor, opId, input);
  }

  listTaskViewPage(
    filters: WorkItemPageFilters = {},
    view: TaskViewName = "core",
  ): TaskViewProjectionPage {
    return this.#taskReads.listTaskViewPage(filters, view);
  }

  /**
   * Desktop projection with the same tl1 selection/order as the bounded task
   * view. The raw fields are retained for filters, board/tree rows and actions;
   * no second offset-based query is allowed to drift from the task page.
   */
  listWorkItemPage(filters: WorkItemPageFilters = {}): WorkItemProjectionPage {
    return this.#taskReads.listWorkItemPage(filters);
  }

  listTaskViewRows(
    filters: WorkItemListFilters = {},
    view: TaskViewName = "core",
  ): TaskViewProjectionRow[] {
    return this.#taskReads.listTaskViewRows(filters, view);
  }

  getTaskViewRow(taskKey: string, view: TaskViewName = "core"): TaskViewProjectionRow {
    return this.#taskReads.getTaskViewRow(taskKey, view);
  }

  listWorkItems(filters: WorkItemListFilters = {}): WorkItemView[] {
    return this.#taskReads.listWorkItems(filters);
  }

  workItemSuggestionCandidates(
    reference: string,
    limit = 50,
  ): { total: number; candidates: Array<{ key: string; status: string }> } {
    return this.#taskReads.workItemSuggestionCandidates(reference, limit);
  }

  createWorkItems(
    actor: ProjectActor,
    opId: string,
    items: WorkItemCreateInput[],
    planningRoot?: WorkItemPlanningRoot,
  ): { items: WorkItemView[]; sequence: number; planningRootProvisioned: boolean } {
    return this.#workItemCreates.createWorkItems(actor, opId, items, planningRoot);
  }

  patchWorkItems(
    actor: ProjectActor,
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
    return this.#workItemLifecycle.patchWorkItems(actor, opId, patches);
  }

  verifyAndComplete(
    actor: ProjectActor,
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
    return this.#workItemLifecycle.verifyAndComplete(actor, opId, input);
  }

  // blockers 是独立记录，work_items.blocked_reason 只是它在任务行上的影子。
  // 表结构里 status 允许 RESOLVED/CANCELLED、还有 resolved_at 和 version，
  // 说明它本就是照「可关闭」设计的；但在此之前全仓库只有一处 INSERT（progress
  // 带 blocker）和一处闸门 SELECT，没有任何路径能把它置成非 ACTIVE。于是任务
  // 只要被带 blocker 的 progress 写过一次，就永远过不了完成闸门（blocker active），
  // 而且清掉 blocked_reason 之后界面上看不出任何异常。
  resolveActiveBlockers(workItemId: string, now: string): number {
    return this.#workItemMaintenance.resolveActiveBlockers(workItemId, now);
  }

  updateChecklist(
    actor: ProjectActor,
    opId: string,
    input: {
      checklistId: string;
      /** 传了才校验归属；REST 的 `PATCH /checklist/:id` 拿不到任务，所以是可选的。 */
      taskKey?: string;
      expectedVersion: number;
      status: "TODO" | "DOING" | "DONE" | "SKIPPED";
      evidence?: unknown[];
    },
  ): { checklist: ChecklistView; taskProgress: number; taskVersion: number; sequence: number } {
    return this.#checklistCommands.updateChecklist(actor, opId, input);
  }

  updateChecklistBatch(
    actor: ProjectActor,
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
    return this.#checklistCommands.updateChecklistBatch(actor, opId, input);
  }

  private recomputeWorkItem(id: string): number {
    return this.#workItemMaintenance.recomputeWorkItem(id);
  }

  private upsertSearchDocument(
    entityType: string,
    entityId: string,
    entityKey: string,
    title: string,
    body: string,
  ): void {
    this.#workItemMaintenance.upsertSearchDocument(entityType, entityId, entityKey, title, body);
  }

  private refreshWorkItemSearchDocument(workItemId: string): void {
    this.#workItemMaintenance.refreshWorkItemSearchDocument(workItemId);
  }

  addProgress(
    actor: ProjectActor,
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
    return this.#progressCommands.addProgress(actor, opId, input);
  }

  createRecord(actor: ProjectActor, opId: string, input: CreateRecordInput): CreateRecordResult {
    return this.#recordCommands.createRecord(actor, opId, input);
  }

  search(query: string, limit = 20, cursor?: string): SearchPage {
    return this.#activityReads.search(query, limit, cursor);
  }

  delta(
    sinceSequence: number,
    limit = 50,
    types: string[] = [],
  ): {
    events: Array<{
      seq: number;
      type: string;
      key: string | null;
      summary: string | null;
      actor: string;
      title: string;
      detail: string;
      changes?: Record<string, unknown>;
      project: { id: string; code: string; name: string };
      projectCode: string;
      projectName: string;
      opId: string | null;
      at: string;
    }>;
    currentSequence: number;
    hasMore: boolean;
  } {
    return this.#activityReads.delta(sinceSequence, limit, types);
  }

  recentWorkItemChanges(
    taskKey: string,
    limit = 6,
  ): Array<{
    seq: number;
    type: string;
    key: string;
    summary: string;
    opId: string | null;
    at: string;
  }> {
    return this.#activityReads.recentWorkItemChanges(taskKey, limit);
  }

  checklistConflictSnapshot(checklistId: string): {
    id: string;
    taskKey: string;
    taskVersion: number;
    title: string;
    status: string;
    evidenceRequired: boolean;
    evidenceCount: number;
    version: number;
    updatedAt: string;
  } {
    return this.#activityReads.checklistConflictSnapshot(checklistId);
  }

  recentChecklistChanges(
    checklistId: string,
    limit = 6,
  ): Array<{
    seq: number;
    type: string;
    key: string;
    summary: string;
    opId: string | null;
    at: string;
  }> {
    return this.#activityReads.recentChecklistChanges(checklistId, limit);
  }

  endSession(
    actor: ProjectActor,
    opId: string,
    input: {
      outcome: string;
      summary: string;
      next?: string[];
      releaseClaims: boolean;
      retirementReason?: string | null;
    },
  ): {
    ok: 1;
    seq: number;
    session: string;
    handoffs: number;
    releasedItems: Array<{ key: string; version: number }>;
  } {
    return this.#sessionCommands.endSession(actor, opId, input);
  }

  summaryProjection(): any {
    return this.#projectionSource.summaryProjection();
  }

  searchProjection(): any[] {
    return this.#projectionSource.searchProjection();
  }

  searchProjectionForChanges(
    changes: Array<{ eventType: string; aggregateType: string; aggregateId: string }>,
  ): any[] {
    return this.#projectionSource.searchProjectionForChanges(changes);
  }

  pendingOutbox(limit = 500): Array<{
    id: string;
    project_sequence: number;
    eventId: string | null;
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    actor: string;
    eventPayload: Record<string, unknown>;
    eventSequence: number;
    eventAt: string | null;
  }> {
    return this.#projectionSource.pendingOutbox(limit);
  }

  markOutboxDelivered(ids: string[]): void {
    this.#projectionSource.markOutboxDelivered(ids);
  }

  markOutboxFailed(ids: string[], error: string): void {
    this.#projectionSource.markOutboxFailed(ids, error);
  }

  briefSnapshot(sessionId?: string | null): BriefSnapshot {
    return this.#contextReads.briefSnapshot(sessionId);
  }

  brief(sessionId?: string | null, maxChars = 1200): any {
    return this.#contextReads.formatBrief(this.briefSnapshot(sessionId), maxChars);
  }
}
