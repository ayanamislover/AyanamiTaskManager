import type Database from "better-sqlite3";
import { AtmError } from "@ayanami-task/errors";
import {
  createUlid,
  EvidenceReferenceSchema,
  normalizeReviewCandidateHashes,
  nowIso,
  RecordSummarySchema,
  type WorkItemOperation,
  type WorkItemStatus,
  type EvidenceInput,
  type SearchHit,
  type SearchPage,
  type RecordView,
  type TaskViewName,
} from "@ayanami-task/protocol";
import type { ManagedDatabase } from "./database.js";
import { assertCompletionGates } from "./completion-gates.js";
import { ChecklistCommands } from "./checklist-commands.js";
import { ContextReadModel } from "./context-read-model.js";
import { EvidenceNormalizer } from "./evidence-normalizer.js";
import { presentEvent, type PresentedEvent } from "./event-presentation.js";
import { OutboxReadModel } from "./outbox-read-model.js";
import { ProjectMutationKernel, type MutationInput } from "./project-mutation-kernel.js";
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
import { decodeSearchCursor, encodeSearchCursor } from "./search-pagination.js";
import { SessionReadModel } from "./session-read-model.js";
import { SessionCommands } from "./session-commands.js";
import { TaskReadModel } from "./task-read-model.js";
import type { TaskViewProjectionRow } from "./task-view-query.js";
import { WorkItemCreateCommands } from "./work-item-create-commands.js";
import { WorkItemLifecycleCommands } from "./work-item-lifecycle-commands.js";
import { WorkItemMaintenance } from "./work-item-maintenance.js";
import { resolveStoredWorkItemOperation } from "./work-item-operation.js";

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

function json<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

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

export type ReviewCandidateHash = { name: string; value: string };

export type ReviewSubmissionView = {
  key: string;
  requestKey: string;
  verdict: "APPROVED" | "CHANGES_REQUESTED";
  reviewedHashes: ReviewCandidateHash[];
  evidence: unknown[];
  recordKey: string;
  reviewerAgentId: string;
  reviewerSessionId: string;
  reviewTaskVersion: number;
  parentChecklistVersion: number;
  createdAt: string;
  opId: string;
};

export type ReviewRequestView = {
  key: string;
  reviewTaskKey: string;
  parentTaskKey: string;
  parentChecklistId: string;
  parentChecklistVersion: number;
  expectedCandidateHashes: ReviewCandidateHash[];
  createdByAgentId: string;
  createdBySessionId: string;
  createdAt: string;
  opId: string;
  submission: ReviewSubmissionView | null;
};

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
  readonly #checklistCommands: ChecklistCommands;
  readonly #evidenceNormalizer: EvidenceNormalizer;
  readonly #planningCommands: PlanningCommands;
  readonly #progressCommands: ProgressCommands;
  readonly #outboxReads: OutboxReadModel;
  readonly #recordReads: RecordReadModel;
  readonly #requestNormalizer: MutationRequestNormalizer;
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
    this.#outboxReads = new OutboxReadModel(this.#sqlite);
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
    this.#requestNormalizer = new MutationRequestNormalizer(
      (reference) => this.#recordReads.recordRow(reference).id,
    );
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
    const normalized = opId.trim();
    if (!normalized) throw new AtmError("OPERATION_ID_INVALID", { message: "operationId 无效" });
    const normalizedSession = sessionId == null ? null : sessionId.trim();
    if (normalizedSession !== null) this.getSession(normalizedSession);
    const mutations = this.#sqlite
      .prepare(
        `SELECT operation, response_json, actor_session_id, created_at
         FROM idempotency_keys WHERE op_id = ? AND (? IS NULL OR actor_session_id = ?)
         ORDER BY created_at`,
      )
      .all(normalized, normalizedSession, normalizedSession)
      .map((row: any) => ({
        operation: row.operation,
        response: json(row.response_json, null),
        sessionId: row.actor_session_id,
        createdAt: row.created_at,
      }));
    const records = (
      this.#sqlite
        .prepare(
          `SELECT id FROM records
           WHERE op_id = ? AND (? IS NULL OR source_session_id = ?)
           ORDER BY created_at`,
        )
        .all(normalized, normalizedSession, normalizedSession) as Array<{ id: string }>
    ).map((row) => this.getRecord(row.id));
    const progress = (
      this.#sqlite
        .prepare(
          `SELECT progress.*, item.local_no FROM progress_updates progress
           JOIN work_items item ON item.id = progress.work_item_id
           WHERE progress.op_id = ? AND (? IS NULL OR progress.session_id = ?)
           ORDER BY progress.created_at`,
        )
        .all(normalized, normalizedSession, normalizedSession) as any[]
    ).map((row) => this.progressUpdateView(row));
    const projectUpdates = (
      this.#sqlite
        .prepare(
          `SELECT * FROM project_updates
           WHERE op_id = ? AND (? IS NULL OR session_id = ?)
           ORDER BY created_at`,
        )
        .all(normalized, normalizedSession, normalizedSession) as any[]
    ).map((row) => this.projectUpdateView(row));
    const events = (
      this.#sqlite
        .prepare(
          `SELECT sequence, type, aggregate_type, aggregate_id, actor_id, session_id,
                  payload_json, created_at, op_id
           FROM events
           WHERE op_id = ? AND (? IS NULL OR session_id = ?)
           ORDER BY sequence`,
        )
        .all(normalized, normalizedSession, normalizedSession) as any[]
    ).map((row) => ({
      seq: row.sequence,
      type: row.type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      actor: row.actor_id,
      sessionId: row.session_id,
      payload: json(row.payload_json, {}),
      at: row.created_at,
      opId: row.op_id,
    }));
    if (
      mutations.length === 0 &&
      records.length === 0 &&
      progress.length === 0 &&
      projectUpdates.length === 0 &&
      events.length === 0
    ) {
      throw new AtmError("OPERATION_NOT_FOUND", {
        message: `操作不存在：${normalized}`,
        details: { entity: "OPERATION", reference: normalized },
      });
    }
    return { opId: normalized, mutations, records, progress, projectUpdates, events };
  }

  private projectUpdateView(row: any): any {
    return {
      id: row.id,
      health: row.health,
      summary: row.summary,
      completed: json(row.completed_json, []),
      risks: json(row.risks_json, []),
      next: json(row.next_json, []),
      evidence: json(row.evidence_json, []),
      fromSequence: row.from_sequence,
      toSequence: row.to_sequence,
      status: row.status,
      actor: row.actor,
      publishedAt: row.published_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      opId: row.op_id ?? null,
      sessionId: row.session_id ?? null,
    };
  }

  getProjectUpdate(id: string): any {
    const normalized = id.trim();
    const row = this.#sqlite.prepare("SELECT * FROM project_updates WHERE id = ?").get(normalized);
    if (!row)
      throw new AtmError("PROJECT_UPDATE_NOT_FOUND", {
        message: `项目更新不存在：${normalized}`,
        details: { entity: "PROJECT_UPDATE", reference: normalized },
      });
    return this.projectUpdateView(row);
  }

  listProjectUpdates(limit = 50): any[] {
    return (
      this.#sqlite
        .prepare(
          `SELECT id, health, summary, completed_json, risks_json, next_json, evidence_json,
                from_sequence, to_sequence, status, actor, published_at, created_at, updated_at,
                op_id, session_id
         FROM project_updates ORDER BY created_at DESC LIMIT ?`,
        )
        .all(Math.min(100, Math.max(1, limit))) as any[]
    ).map((row) => this.projectUpdateView(row));
  }

  draftProjectUpdate(actor: ProjectActor, opId: string): any {
    return this.mutate({
      actor,
      opId,
      operation: "project-update.draft",
      request: {},
      action: () => {
        const meta = this.#sqlite
          .prepare("SELECT * FROM project_meta WHERE singleton = 1")
          .get() as any;
        const last = this.#sqlite
          .prepare(
            "SELECT to_sequence FROM project_updates WHERE status = 'PUBLISHED' ORDER BY published_at DESC LIMIT 1",
          )
          .get() as { to_sequence: number } | undefined;
        const fromSequence = last?.to_sequence ?? 0;
        const toSequence = meta.current_sequence;
        const completed = (
          this.#sqlite
            .prepare(
              `SELECT item.title FROM events event
             JOIN work_items item ON item.id = event.aggregate_id
             WHERE event.sequence > ? AND event.sequence <= ? AND event.type = 'work.completed'
             ORDER BY event.sequence DESC LIMIT 10`,
            )
            .all(fromSequence, toSequence) as Array<{ title: string }>
        ).map((row) => row.title);
        const risks = (
          this.#sqlite
            .prepare(
              `SELECT COALESCE(blocked_reason, waiting_for, title) AS value FROM work_items
             WHERE status IN ('BLOCKED','WAITING_USER','WAITING_AGENT') AND archived_at IS NULL
             ORDER BY updated_at DESC LIMIT 10`,
            )
            .all() as Array<{ value: string }>
        ).map((row) => row.value);
        const next = this.listWorkItems({ limit: 5 })
          .filter((item) => ["READY", "CLAIMED", "IN_PROGRESS"].includes(item.status))
          .map((item) => item.title);
        const summary = `${completed.length ? `完成 ${completed.length} 项` : "暂无新增完成项"}；${risks.length ? `存在 ${risks.length} 项风险` : "当前无阻塞风险"}`;
        const id = createUlid();
        const now = nowIso();
        this.#sqlite
          .prepare(
            `INSERT INTO project_updates(
               id, health, summary, completed_json, risks_json, next_json,
               from_sequence, to_sequence, status, actor, published_at, created_at, updated_at,
               op_id, session_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, NULL, ?, ?, ?, ?)`,
          )
          .run(
            id,
            meta.health,
            summary,
            JSON.stringify(completed),
            JSON.stringify(risks),
            JSON.stringify(next),
            fromSequence,
            toSequence,
            actor.id,
            now,
            now,
            opId,
            actor.sessionId,
          );
        const seq = this.appendEvent("project.update.drafted", actor, "PROJECT_UPDATE", id, {
          fromSequence,
          toSequence,
        });
        return { ...this.listProjectUpdates(100).find((update) => update.id === id), seq };
      },
    });
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
    const normalizedInput = {
      ...input,
      ...(input.evidence === undefined
        ? {}
        : { evidence: this.normalizeEvidence(input.evidence, true) as EvidenceInput[] }),
      ...(input.completed === undefined
        ? {}
        : {
            completed: input.completed.map((entry) => {
              if (typeof entry === "string" || entry.workItemKey === undefined) return entry;
              const row = this.rowForTaskKey(entry.workItemKey);
              return { ...entry, workItemKey: this.taskKeyForId(row.id)! };
            }),
          }),
    };
    return this.mutate({
      actor,
      opId,
      operation: "project-update.publish",
      request: normalizedInput,
      action: () => {
        const draft = normalizedInput.draftId
          ? (this.#sqlite
              .prepare("SELECT * FROM project_updates WHERE id = ? AND status = 'DRAFT'")
              .get(normalizedInput.draftId) as any)
          : null;
        if (normalizedInput.draftId && !draft)
          throw new AtmError("PROJECT_UPDATE_DRAFT_NOT_FOUND", {
            message: `项目更新草稿不存在：${normalizedInput.draftId}`,
            details: { entity: "PROJECT_UPDATE_DRAFT", reference: normalizedInput.draftId },
          });
        const id = draft?.id ?? createUlid();
        const now = nowIso();
        const meta = this.meta;
        const completed = normalizedInput.completed ?? json(draft?.completed_json, []);
        const risks = normalizedInput.risks ?? json(draft?.risks_json, []);
        const next = normalizedInput.next ?? json(draft?.next_json, []);
        const evidence = normalizedInput.evidence ?? json(draft?.evidence_json, []);
        const fromSequence =
          draft?.from_sequence ??
          (
            this.#sqlite
              .prepare(
                "SELECT MAX(to_sequence) AS value FROM project_updates WHERE status = 'PUBLISHED'",
              )
              .get() as { value: number | null }
          ).value ??
          0;
        const toSequence = draft?.to_sequence ?? meta.sequence;
        if (draft) {
          this.#sqlite
            .prepare(
              `UPDATE project_updates SET health = ?, summary = ?, completed_json = ?, risks_json = ?,
               next_json = ?, evidence_json = ?, status = 'PUBLISHED', actor = ?, published_at = ?,
               updated_at = ?, op_id = ?, session_id = ? WHERE id = ?`,
            )
            .run(
              normalizedInput.health,
              normalizedInput.summary.trim(),
              JSON.stringify(completed),
              JSON.stringify(risks),
              JSON.stringify(next),
              JSON.stringify(evidence),
              actor.id,
              now,
              now,
              opId,
              actor.sessionId,
              id,
            );
        } else {
          this.#sqlite
            .prepare(
              `INSERT INTO project_updates(
                 id, health, summary, completed_json, risks_json, next_json, evidence_json,
                 from_sequence, to_sequence, status, actor, published_at, created_at, updated_at,
                 op_id, session_id
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PUBLISHED', ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              id,
              normalizedInput.health,
              normalizedInput.summary.trim(),
              JSON.stringify(completed),
              JSON.stringify(risks),
              JSON.stringify(next),
              JSON.stringify(evidence),
              fromSequence,
              toSequence,
              actor.id,
              now,
              now,
              now,
              opId,
              actor.sessionId,
            );
        }
        this.#sqlite
          .prepare(
            "UPDATE project_meta SET health = ?, version = version + 1, updated_at = ? WHERE singleton = 1",
          )
          .run(normalizedInput.health, now);
        const seq = this.appendEvent("project.update.published", actor, "PROJECT_UPDATE", id, {
          health: normalizedInput.health,
          summary: normalizedInput.summary.trim(),
        });
        const linkedKeys = new Set(
          completed.flatMap((entry: string | { text: string; workItemKey?: string }) =>
            typeof entry === "string" || !entry.workItemKey ? [] : [entry.workItemKey],
          ),
        );
        if (evidence.length > 0) {
          for (const taskKey of linkedKeys) {
            this.advanceWorkItemEvidenceAt(this.rowForTaskKey(taskKey).id, now);
          }
        }
        const openWorkItemSummary = this.openWorkItemSummary(linkedKeys, 20);
        return {
          ...this.listProjectUpdates(100).find((update) => update.id === id),
          seq,
          opId,
          unlinked: completed.length > 0 && openWorkItemSummary.total > 0,
          openWorkItemCount: openWorkItemSummary.total,
          openWorkItems: openWorkItemSummary.keys,
          openWorkItemsTruncated: openWorkItemSummary.truncated,
        };
      },
    });
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
    const prefix = `${this.meta.code}-RR-`;
    const suffix = requestKey.startsWith(prefix) ? requestKey.slice(prefix.length) : "";
    if (!/^\d+$/u.test(suffix))
      throw new AtmError("REVIEW_REQUEST_NOT_FOUND", {
        message: `Review 请求不存在：${requestKey}`,
        details: { entity: "REVIEW_REQUEST", reference: requestKey },
      });
    const row = this.#sqlite
      .prepare("SELECT * FROM review_requests WHERE local_no = ?")
      .get(Number(suffix));
    if (!row)
      throw new AtmError("REVIEW_REQUEST_NOT_FOUND", {
        message: `Review 请求不存在：${requestKey}`,
        details: { entity: "REVIEW_REQUEST", reference: requestKey },
      });
    return row;
  }

  private reviewRequestKey(localNo: number): string {
    return `${this.meta.code}-RR-${String(localNo).padStart(4, "0")}`;
  }

  private reviewSubmissionKey(localNo: number): string {
    return `${this.meta.code}-RS-${String(localNo).padStart(4, "0")}`;
  }

  getReviewRequest(requestKey: string): ReviewRequestView {
    const request = this.reviewRequestRow(requestKey);
    const reviewTaskKey = this.taskKeyForId(request.review_work_item_id);
    const parentTaskKey = this.taskKeyForId(request.parent_work_item_id);
    if (!reviewTaskKey || !parentTaskKey)
      throw new AtmError("INTERNAL_ERROR", { message: "Review 绑定数据无效" });
    const submission = this.#sqlite
      .prepare("SELECT * FROM review_submissions WHERE request_id = ?")
      .get(request.id) as any;
    let submissionView: ReviewSubmissionView | null = null;
    if (submission) {
      const record = this.#sqlite
        .prepare("SELECT local_no, kind FROM records WHERE id = ?")
        .get(submission.record_id) as { local_no: number; kind: string } | undefined;
      if (!record) throw new AtmError("INTERNAL_ERROR", { message: "Review 提交记录缺失" });
      submissionView = {
        key: this.reviewSubmissionKey(Number(submission.local_no)),
        requestKey: this.reviewRequestKey(Number(request.local_no)),
        verdict: submission.verdict,
        reviewedHashes: json<ReviewCandidateHash[]>(submission.reviewed_hashes_json, []),
        evidence: json<unknown[]>(submission.evidence_json, []),
        recordKey: this.recordKey(record),
        reviewerAgentId: submission.reviewer_agent_id,
        reviewerSessionId: submission.reviewer_session_id,
        reviewTaskVersion: Number(submission.review_task_version),
        parentChecklistVersion: Number(submission.parent_checklist_version),
        createdAt: String(submission.created_at),
        opId: String(submission.op_id),
      };
    }
    return {
      key: this.reviewRequestKey(Number(request.local_no)),
      reviewTaskKey,
      parentTaskKey,
      parentChecklistId: String(request.parent_checklist_id),
      parentChecklistVersion: Number(request.parent_checklist_version),
      expectedCandidateHashes: json<ReviewCandidateHash[]>(
        request.expected_candidate_hashes_json,
        [],
      ),
      createdByAgentId: String(request.created_by_agent_id),
      createdBySessionId: String(request.created_by_session_id),
      createdAt: String(request.created_at),
      opId: String(request.op_id),
      submission: submissionView,
    };
  }

  createReviewRequest(
    actor: ProjectActor,
    opId: string,
    input: {
      reviewTaskKey: string;
      expectedReviewTaskVersion: number;
      parentChecklistId: string;
      expectedParentChecklistVersion: number;
      expectedCandidateHashes: ReviewCandidateHash[];
    },
  ): { request: ReviewRequestView; sequence: number } {
    const normalizedInput = {
      ...input,
      expectedCandidateHashes: normalizeReviewCandidateHashes(input.expectedCandidateHashes),
    };
    return this.mutate({
      actor,
      opId,
      operation: "review.request.create",
      request: normalizedInput,
      immediate: true,
      action: () => {
        if (!actor.sessionId)
          throw new AtmError("REVIEW_REQUEST_REQUIRES_SESSION", {
            message: "创建 Review 请求需要活动 Session",
          });
        const reviewTask = this.rowForTaskKey(normalizedInput.reviewTaskKey);
        if (reviewTask.type !== "REVIEW") {
          throw new AtmError("REVIEW_TASK_INVALID", {
            message: `WorkItem 不是 Review 类型：${normalizedInput.reviewTaskKey}`,
            details: { task_key: normalizedInput.reviewTaskKey },
          });
        }
        if (reviewTask.version !== normalizedInput.expectedReviewTaskVersion) {
          throw new AtmError("VERSION_CONFLICT", {
            message: "Review WorkItem 版本已变化",
            details: {
              entity: "WORK_ITEM",
              key: normalizedInput.reviewTaskKey,
              expected: normalizedInput.expectedReviewTaskVersion,
              actual: reviewTask.version,
            },
          });
        }
        if (reviewTask.status === "DONE" || reviewTask.status === "CANCELLED") {
          throw new AtmError("REVIEW_TASK_CLOSED", {
            message: `Review WorkItem 已关闭：${normalizedInput.reviewTaskKey}`,
            details: { task_key: normalizedInput.reviewTaskKey },
          });
        }
        const checklist = this.#sqlite
          .prepare("SELECT * FROM checklist_items WHERE id = ?")
          .get(normalizedInput.parentChecklistId) as any;
        if (!checklist)
          throw new AtmError("CHECKLIST_NOT_FOUND", {
            message: `检查项不存在：${normalizedInput.parentChecklistId}`,
            details: { entity: "CHECKLIST", reference: normalizedInput.parentChecklistId },
          });
        if (checklist.version !== normalizedInput.expectedParentChecklistVersion) {
          throw new AtmError("VERSION_CONFLICT", {
            message: "检查项版本已变化",
            details: {
              entity: "CHECKLIST",
              key: normalizedInput.parentChecklistId,
              expected: normalizedInput.expectedParentChecklistVersion,
              actual: checklist.version,
            },
          });
        }
        if (!reviewTask.parent_id || reviewTask.parent_id !== checklist.work_item_id) {
          throw new AtmError("REVIEW_BINDING_MISMATCH", {
            message: `Review WorkItem 与父检查项不匹配：${normalizedInput.reviewTaskKey}`,
            details: {
              task_key: normalizedInput.reviewTaskKey,
              checklist_id: normalizedInput.parentChecklistId,
            },
          });
        }
        if (checklist.status === "DONE" || checklist.status === "SKIPPED") {
          throw new AtmError("REVIEW_CHECKLIST_CLOSED", {
            message: `父检查项已关闭：${normalizedInput.parentChecklistId}`,
            details: { checklist_id: normalizedInput.parentChecklistId },
          });
        }
        const existing = this.#sqlite
          .prepare("SELECT id FROM review_requests WHERE review_work_item_id = ?")
          .get(reviewTask.id);
        if (existing)
          throw new AtmError("REVIEW_REQUEST_CONFLICT", {
            message: `Review WorkItem 已绑定请求：${normalizedInput.reviewTaskKey}`,
            details: { task_key: normalizedInput.reviewTaskKey },
          });
        const id = createUlid();
        const localNo = this.nextNumber("review_request");
        const key = this.reviewRequestKey(localNo);
        const now = nowIso();
        this.#sqlite
          .prepare(
            `INSERT INTO review_requests(
               id, local_no, review_work_item_id, parent_work_item_id, parent_checklist_id,
               parent_checklist_version, expected_candidate_hashes_json, created_by_agent_id,
               created_by_session_id, created_at, op_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            localNo,
            reviewTask.id,
            checklist.work_item_id,
            checklist.id,
            checklist.version,
            JSON.stringify(normalizedInput.expectedCandidateHashes),
            actor.id,
            actor.sessionId,
            now,
            opId,
          );
        const sequence = this.appendEvent("review.requested", actor, "REVIEW_REQUEST", id, {
          key,
          reviewTaskKey: normalizedInput.reviewTaskKey,
          parentTaskKey: this.taskKeyForId(checklist.work_item_id),
          parentChecklistId: checklist.id,
          expectedCandidateHashes: normalizedInput.expectedCandidateHashes,
        });
        return { request: this.getReviewRequest(key), sequence };
      },
    });
  }

  submitReview(
    actor: ProjectActor,
    opId: string,
    input: {
      requestKey: string;
      reviewTaskKey?: string;
      expectedReviewTaskVersion: number;
      verdict: "APPROVED" | "CHANGES_REQUESTED";
      reviewedHashes: ReviewCandidateHash[];
      evidence: unknown[];
    },
  ): {
    requestKey: string;
    submissionKey: string;
    recordKey: string;
    verdict: "APPROVED" | "CHANGES_REQUESTED";
    reviewTask: { key: string; status: WorkItemStatus; version: number };
    parentChecklist: { id: string; status: string; version: number };
    parentTask: { key: string; status: WorkItemStatus; version: number };
    sequence: number;
  } {
    const normalizedInput = {
      ...input,
      reviewedHashes: normalizeReviewCandidateHashes(input.reviewedHashes),
      evidence: this.normalizeEvidence(
        input.evidence.map((entry) => EvidenceReferenceSchema.parse(entry)),
      ),
    };
    return this.mutate({
      actor,
      opId,
      operation: "review.submit",
      request: normalizedInput,
      immediate: true,
      action: () => {
        if (!actor.sessionId)
          throw new AtmError("REVIEWER_SESSION_REQUIRED", {
            message: "提交 Review 需要活动 Session",
          });
        const session = this.getSession(actor.sessionId);
        if (
          session.role !== "REVIEWER" ||
          session.agent_id !== actor.id ||
          session.connection_state !== "ONLINE"
        ) {
          throw new AtmError("REVIEWER_REQUIRED", {
            message: `当前 Session 不具备 Reviewer 身份：${actor.sessionId}`,
            details: { session_id: actor.sessionId },
          });
        }
        const request = this.reviewRequestRow(normalizedInput.requestKey);
        const existing = this.#sqlite
          .prepare("SELECT id FROM review_submissions WHERE request_id = ?")
          .get(request.id);
        if (existing)
          throw new AtmError("REVIEW_ALREADY_SUBMITTED", {
            message: `Review 请求已提交：${normalizedInput.requestKey}`,
            details: { request_key: normalizedInput.requestKey },
          });
        const reviewTask = this.#sqlite
          .prepare("SELECT * FROM work_items WHERE id = ?")
          .get(request.review_work_item_id) as any;
        if (!reviewTask || reviewTask.type !== "REVIEW") {
          throw new AtmError("INTERNAL_ERROR", { message: "Review 请求指向无效 WorkItem" });
        }
        const reviewTaskKey = this.taskKeyForId(reviewTask.id);
        if (!reviewTaskKey)
          throw new AtmError("INTERNAL_ERROR", { message: "Review WorkItem key 缺失" });
        if (
          normalizedInput.reviewTaskKey !== undefined &&
          normalizedInput.reviewTaskKey !== reviewTaskKey
        ) {
          throw new AtmError("REVIEW_BINDING_MISMATCH", {
            message: `Review 请求与 WorkItem 不匹配：${normalizedInput.reviewTaskKey}`,
            details: {
              request_key: normalizedInput.requestKey,
              task_key: normalizedInput.reviewTaskKey,
              expected_task_key: reviewTaskKey,
            },
          });
        }
        if (reviewTask.version !== normalizedInput.expectedReviewTaskVersion) {
          throw new AtmError("VERSION_CONFLICT", {
            message: "Review WorkItem 版本已变化",
            details: {
              entity: "WORK_ITEM",
              key: reviewTaskKey,
              expected: normalizedInput.expectedReviewTaskVersion,
              actual: reviewTask.version,
            },
          });
        }
        if (
          reviewTask.assignee_agent_id !== actor.id ||
          reviewTask.claimed_by_session_id !== actor.sessionId
        ) {
          throw new AtmError("REVIEW_IDENTITY_MISMATCH", {
            message: `Reviewer 身份与 Review WorkItem 领取者不匹配：${reviewTaskKey}`,
            details: { task_key: reviewTaskKey, session_id: actor.sessionId },
          });
        }
        const expectedHashes = json<ReviewCandidateHash[]>(
          request.expected_candidate_hashes_json,
          [],
        );
        if (JSON.stringify(expectedHashes) !== JSON.stringify(normalizedInput.reviewedHashes)) {
          throw new AtmError("CANDIDATE_HASH_MISMATCH", {
            message: `Review 候选哈希不匹配：${normalizedInput.requestKey}`,
            details: {
              request_key: normalizedInput.requestKey,
              expected: expectedHashes,
              actual: normalizedInput.reviewedHashes,
            },
          });
        }
        const parentChecklist = this.#sqlite
          .prepare("SELECT * FROM checklist_items WHERE id = ?")
          .get(request.parent_checklist_id) as any;
        if (
          !parentChecklist ||
          parentChecklist.work_item_id !== request.parent_work_item_id ||
          reviewTask.parent_id !== request.parent_work_item_id
        ) {
          throw new AtmError("INTERNAL_ERROR", { message: "已存储的 Review 绑定无效" });
        }
        if (parentChecklist.version !== request.parent_checklist_version) {
          throw new AtmError("VERSION_CONFLICT", {
            message: "父检查项版本已变化",
            details: {
              entity: "CHECKLIST",
              key: request.parent_checklist_id,
              expected: request.parent_checklist_version,
              actual: parentChecklist.version,
            },
          });
        }
        resolveStoredWorkItemOperation("complete", reviewTask);
        assertCompletionGates(this.#sqlite, reviewTask);

        const now = nowIso();
        const requestKey = this.reviewRequestKey(Number(request.local_no));
        const submissionId = createUlid();
        const submissionLocalNo = this.nextNumber("review_submission");
        const submissionKey = this.reviewSubmissionKey(submissionLocalNo);
        const recordId = createUlid();
        const recordLocalNo = this.nextNumber("record");
        const recordKey = this.recordKey({ local_no: recordLocalNo, kind: "VERIFICATION" });
        const summary = `${normalizedInput.verdict} review for ${reviewTaskKey}`;
        const detail = JSON.stringify(
          {
            requestKey,
            submissionKey,
            verdict: normalizedInput.verdict,
            expectedCandidateHashes: expectedHashes,
            reviewedHashes: normalizedInput.reviewedHashes,
            evidence: normalizedInput.evidence,
            reviewerAgentId: actor.id,
            reviewerSessionId: actor.sessionId,
          },
          null,
          2,
        );
        this.#sqlite
          .prepare(
            `INSERT INTO records(
               id, local_no, kind, title, summary, detail, importance, status,
               supersedes_id, scope, work_item_id, actor, version, created_at, updated_at,
               source_type, source_actor_id, source_session_id, source_ref, topic, subject_key,
               op_id
             ) VALUES (?, ?, 'VERIFICATION', ?, ?, ?, 'HIGH', 'ACTIVE', NULL,
               'REVIEW_AUDIT', ?, ?, 0, ?, ?, 'AGENT', ?, ?, ?, 'review-verdict', ?, ?)`,
          )
          .run(
            recordId,
            recordLocalNo,
            `Review ${normalizedInput.verdict}: ${reviewTaskKey}`,
            summary,
            detail,
            reviewTask.id,
            actor.id,
            now,
            now,
            actor.id,
            actor.sessionId,
            submissionKey,
            reviewTaskKey,
            opId,
          );
        this.appendEvent("record.created", actor, "RECORD", recordId, {
          key: recordKey,
          kind: "VERIFICATION",
          title: `Review ${normalizedInput.verdict}: ${reviewTaskKey}`,
          summary,
          topic: "review-verdict",
          subjectKey: reviewTaskKey,
        });
        this.upsertSearchDocument(
          "RECORD",
          recordId,
          recordKey,
          `Review ${normalizedInput.verdict}: ${reviewTaskKey}`,
          `${summary}\n${detail}`,
        );

        if (normalizedInput.verdict === "APPROVED") {
          this.#sqlite
            .prepare(
              `UPDATE checklist_items SET status = 'DONE', evidence_json = ?,
               version = version + 1, updated_at = ? WHERE id = ?`,
            )
            .run(JSON.stringify(normalizedInput.evidence), now, parentChecklist.id);
          this.recomputeWorkItem(parentChecklist.work_item_id);
          this.appendEvent("checklist.updated", actor, "CHECKLIST", parentChecklist.id, {
            workItemId: parentChecklist.work_item_id,
            taskKey: this.taskKeyForId(parentChecklist.work_item_id),
            status: "DONE",
            reviewRequestKey: requestKey,
            reviewSubmissionKey: submissionKey,
          });
        }

        this.#sqlite
          .prepare(
            `UPDATE work_items SET status = 'DONE', phase = 'DONE', phase_inferred = 0,
             waiting_on = NULL, waiting_for = NULL, completed_at = ?, computed_progress = 100,
             reported_progress = 100, version = version + 1, updated_at = ? WHERE id = ?`,
          )
          .run(now, now, reviewTask.id);
        this.#sqlite
          .prepare(
            `UPDATE agent_sessions SET current_work_item_id = NULL, work_state = 'IDLE',
             heartbeat_at = ?, updated_at = ?, version = version + 1
             WHERE id = ? AND current_work_item_id = ?`,
          )
          .run(now, now, actor.sessionId, reviewTask.id);
        this.appendEvent("work.completed", actor, "WORK_ITEM", reviewTask.id, {
          key: reviewTaskKey,
          title: reviewTask.title,
          operation: "review_submit",
          status: "DONE",
          phase: "DONE",
          reviewRequestKey: requestKey,
          verdict: normalizedInput.verdict,
        });
        this.recomputeWorkItem(request.parent_work_item_id);

        const finalReviewTask = this.#sqlite
          .prepare("SELECT * FROM work_items WHERE id = ?")
          .get(reviewTask.id) as any;
        const finalChecklist = this.#sqlite
          .prepare("SELECT * FROM checklist_items WHERE id = ?")
          .get(parentChecklist.id) as any;
        const finalParent = this.#sqlite
          .prepare("SELECT * FROM work_items WHERE id = ?")
          .get(request.parent_work_item_id) as any;
        const parentTaskKey = this.taskKeyForId(finalParent.id);
        if (!parentTaskKey)
          throw new AtmError("INTERNAL_ERROR", { message: "父 WorkItem key 缺失" });
        this.#sqlite
          .prepare(
            `INSERT INTO review_submissions(
               id, local_no, request_id, verdict, reviewed_hashes_json, evidence_json,
               record_id, reviewer_agent_id, reviewer_session_id, review_task_version,
               parent_checklist_version, created_at, op_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            submissionId,
            submissionLocalNo,
            request.id,
            normalizedInput.verdict,
            JSON.stringify(normalizedInput.reviewedHashes),
            JSON.stringify(normalizedInput.evidence),
            recordId,
            actor.id,
            actor.sessionId,
            finalReviewTask.version,
            finalChecklist.version,
            now,
            opId,
          );
        if (normalizedInput.evidence.length > 0) {
          this.advanceWorkItemEvidenceAt(reviewTask.id, now);
          this.advanceWorkItemEvidenceAt(request.parent_work_item_id, now);
        }
        const sequence = this.appendEvent(
          "review.submitted",
          actor,
          "REVIEW_SUBMISSION",
          submissionId,
          {
            key: submissionKey,
            requestKey,
            reviewTaskKey,
            parentTaskKey,
            parentChecklistId: finalChecklist.id,
            recordKey,
            verdict: normalizedInput.verdict,
            reviewedHashes: normalizedInput.reviewedHashes,
          },
        );
        return {
          requestKey,
          submissionKey,
          recordKey,
          verdict: normalizedInput.verdict,
          reviewTask: {
            key: reviewTaskKey,
            status: finalReviewTask.status,
            version: finalReviewTask.version,
          },
          parentChecklist: {
            id: finalChecklist.id,
            status: finalChecklist.status,
            version: finalChecklist.version,
          },
          parentTask: {
            key: parentTaskKey,
            status: finalParent.status,
            version: finalParent.version,
          },
          sequence,
        };
      },
    });
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

  private openWorkItemSummary(
    excludedTaskKeys: ReadonlySet<string>,
    limit: number,
  ): { keys: string[]; total: number; truncated: boolean } {
    const excludedIds = [...excludedTaskKeys].map((key) => this.rowForTaskKey(key).id);
    const clauses = ["archived_at IS NULL", "status NOT IN ('DONE','CANCELLED')"];
    const parameters: unknown[] = [];
    if (excludedIds.length > 0) {
      clauses.push(`id NOT IN (${excludedIds.map(() => "?").join(", ")})`);
      parameters.push(...excludedIds);
    }
    const where = clauses.join(" AND ");
    const countRow = this.#sqlite
      .prepare(`SELECT COUNT(*) AS count FROM work_items WHERE ${where}`)
      .get(...parameters) as { count: number };
    const boundedLimit = Math.min(100, Math.max(1, limit));
    const rows = this.#sqlite
      .prepare(
        `SELECT local_no FROM work_items WHERE ${where}
         ORDER BY CASE priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1
           WHEN 'NORMAL' THEN 2 ELSE 3 END, sort_key, created_at, local_no LIMIT ?`,
      )
      .all(...parameters, boundedLimit) as Array<{ local_no: number }>;
    const total = Number(countRow.count);
    const code = this.meta.code;
    const keys = rows.map((row) => `${code}-T-${String(row.local_no).padStart(4, "0")}`);
    return { keys, total, truncated: keys.length < total };
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

  createRecord(
    actor: ProjectActor,
    opId: string,
    input: {
      kind: string;
      title: string;
      summary: string;
      detail?: string;
      importance?: string;
      scope?: string;
      workItemKey?: string | null;
      supersedes?: string | null;
      topic?: string | null;
      subjectKey?: string | null;
      sourceType?: "USER" | "AGENT" | "SYSTEM" | "IMPORT";
      sourceActorId?: string | null;
      sourceSessionId?: string | null;
      sourceRef?: string | null;
    },
  ): { ok: 1; seq: number; key: string; v: number; relatedRecords: string[] } {
    const normalizedInput = this.normalizeMutationRequest("record.create", input) as typeof input;
    return this.mutate({
      actor,
      opId,
      operation: "record.create",
      request: normalizedInput,
      action: () => {
        if (!RecordSummarySchema.safeParse(normalizedInput.summary).success)
          throw new AtmError("VALIDATION_ERROR", {
            message: "记录摘要不能超过 300 字",
            details: { field: "summary", max: 300 },
          });
        const id = createUlid();
        const localNo = this.nextNumber("record");
        const code = this.meta.code;
        const key = `${code}-${normalizedInput.kind === "DECISION" ? "D" : "R"}-${String(localNo).padStart(3, "0")}`;
        const workItemId = normalizedInput.workItemKey
          ? this.rowForTaskKey(normalizedInput.workItemKey).id
          : null;
        const now = nowIso();
        if (normalizedInput.supersedes) {
          const superseded = this.#sqlite
            .prepare("SELECT local_no, kind, scope FROM records WHERE id = ?")
            .get(normalizedInput.supersedes) as
            | { local_no: number; kind: string; scope: string }
            | undefined;
          if (superseded?.scope === "REVIEW_AUDIT") {
            const recordKey = this.recordKey(superseded);
            throw new AtmError("IMMUTABLE_RECORD", {
              message: `Review 审计记录不可替换：${recordKey}`,
              details: { record_key: recordKey },
            });
          }
          this.#sqlite
            .prepare(
              `UPDATE records SET status = 'SUPERSEDED', version = version + 1,
               updated_at = ? WHERE id = ?`,
            )
            .run(now, normalizedInput.supersedes);
        }
        this.#sqlite
          .prepare(
            `INSERT INTO records(
               id, local_no, kind, title, summary, detail, importance, status,
               supersedes_id, scope, work_item_id, actor, version, created_at, updated_at,
               source_type, source_actor_id, source_session_id, source_ref, topic, subject_key,
               op_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            localNo,
            normalizedInput.kind,
            normalizedInput.title,
            normalizedInput.summary,
            normalizedInput.detail ?? "",
            normalizedInput.importance ?? "NORMAL",
            normalizedInput.supersedes ?? null,
            normalizedInput.scope ?? "PROJECT",
            workItemId,
            actor.id,
            now,
            now,
            normalizedInput.sourceType ?? actor.type,
            normalizedInput.sourceActorId ?? actor.id,
            normalizedInput.sourceSessionId ?? actor.sessionId,
            normalizedInput.sourceRef ?? null,
            normalizedInput.topic ?? null,
            normalizedInput.subjectKey ?? null,
            opId,
          );
        const seq = this.appendEvent("record.created", actor, "RECORD", id, {
          key,
          kind: normalizedInput.kind,
          title: normalizedInput.title,
          summary: normalizedInput.summary,
          topic: normalizedInput.topic ?? null,
          subjectKey: normalizedInput.subjectKey ?? null,
        });
        this.upsertSearchDocument(
          "RECORD",
          id,
          key,
          normalizedInput.title,
          `${normalizedInput.summary}\n${normalizedInput.detail ?? ""}`,
        );
        const relatedRecords = (
          this.#sqlite
            .prepare(
              `SELECT local_no, kind FROM records
               WHERE id <> ? AND status = 'ACTIVE' AND (
                 (? IS NOT NULL AND topic = ?) OR
                 (? IS NOT NULL AND subject_key = ?)
               ) ORDER BY updated_at DESC LIMIT 20`,
            )
            .all(
              id,
              normalizedInput.topic ?? null,
              normalizedInput.topic ?? null,
              normalizedInput.subjectKey ?? null,
              normalizedInput.subjectKey ?? null,
            ) as Array<{ local_no: number; kind: string }>
        ).map((row) => this.recordKey(row));
        return { ok: 1, seq, key, v: 0, relatedRecords };
      },
    });
  }

  search(query: string, limit = 20, cursor?: string): SearchPage {
    const bounded = Math.max(1, Math.min(30, limit));
    const normalized = query.trim();
    if (!normalized) return { hits: [], nextCursor: null, hasMore: false };
    const scope = this.meta.code;
    const decoded = cursor ? decodeSearchCursor(cursor, { scope, query: normalized }) : null;
    const snapshot = decoded?.snapshot ?? {
      documents: Number(
        (
          this.#sqlite
            .prepare("SELECT COALESCE(MAX(rowid), 0) AS value FROM search_documents")
            .get() as {
            value: number;
          }
        ).value,
      ),
      quickTasks: 0,
    };
    const clauses = ["documents.rowid <= ?"];
    const params: unknown[] = [snapshot.documents];
    if (decoded) {
      clauses.push(`(
        documents.updated_at < ? OR
        (documents.updated_at = ? AND documents.entity_type > ?) OR
        (documents.updated_at = ? AND documents.entity_type = ? AND documents.entity_key > ?)
      )`);
      params.push(
        decoded.last.updatedAt,
        decoded.last.updatedAt,
        decoded.last.entityType,
        decoded.last.updatedAt,
        decoded.last.entityType,
        decoded.last.entityKey,
      );
    }
    let rows: any[];
    if ([...normalized].length < 3) {
      const escaped = normalized.replace(/[\\%_]/gu, "\\$&");
      rows = this.#sqlite
        .prepare(
          `SELECT documents.entity_type, documents.entity_key, documents.title,
                  documents.body, documents.updated_at
           FROM search_documents documents
           WHERE (documents.title LIKE ? ESCAPE '\\' OR documents.body LIKE ? ESCAPE '\\')
             AND ${clauses.join(" AND ")}
           ORDER BY documents.updated_at DESC, documents.entity_type, documents.entity_key
           LIMIT ?`,
        )
        .all(`%${escaped}%`, `%${escaped}%`, ...params, bounded + 1) as any[];
    } else {
      const phrase = `"${normalized.replaceAll('"', '""')}"`;
      rows = this.#sqlite
        .prepare(
          `SELECT documents.entity_type, documents.entity_key, documents.title, documents.body,
             documents.updated_at
           FROM search_documents_fts fts
           JOIN search_documents documents
             ON documents.entity_type = fts.entity_type AND documents.entity_id = fts.entity_id
           WHERE search_documents_fts MATCH ?
             AND ${clauses.join(" AND ")}
           ORDER BY documents.updated_at DESC, documents.entity_type, documents.entity_key
           LIMIT ?`,
        )
        .all(phrase, ...params, bounded + 1) as any[];
    }
    const hits: SearchHit[] = rows.slice(0, bounded).map((row) => ({
      entityType: row.entity_type,
      entityKey: row.entity_key,
      title: row.title,
      snippet: String(row.body).slice(0, 240),
      updatedAt: row.updated_at,
    }));
    const hasMore = rows.length > bounded;
    const last = hits.at(-1);
    return {
      hits,
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeSearchCursor({
              scope,
              query: normalized,
              snapshot,
              last: {
                updatedAt: last.updatedAt,
                project: "",
                entityType: last.entityType,
                entityKey: last.entityKey,
              },
            })
          : null,
    };
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
    const clauses = ["sequence > ?"];
    const params: unknown[] = [sinceSequence];
    if (types.length > 0) {
      clauses.push(`type IN (${types.map(() => "?").join(",")})`);
      params.push(...types);
    }
    const bounded = Math.max(1, Math.min(100, limit));
    params.push(bounded + 1);
    const rows = this.#sqlite
      .prepare(
        `SELECT sequence, type, aggregate_type, aggregate_id, actor_type, actor_id,
                payload_json, created_at, op_id FROM events
         WHERE ${clauses.join(" AND ")} ORDER BY sequence LIMIT ?`,
      )
      .all(...params) as any[];
    const hasMore = rows.length > bounded;
    return {
      events: rows.slice(0, bounded).map((row) => {
        const payload = json<Record<string, unknown>>(row.payload_json, {});
        const presented: PresentedEvent = presentEvent({
          type: row.type,
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          actor: row.actor_id ?? row.actor_type,
          payload,
          project: {
            id: this.meta.id,
            code: this.meta.code,
            name: this.meta.name,
          },
        });
        return {
          seq: row.sequence,
          type: row.type,
          key: presented.key,
          summary: presented.summary,
          actor: presented.actor,
          title: presented.title,
          detail: presented.detail,
          ...(payload.changes && typeof payload.changes === "object"
            ? { changes: payload.changes as Record<string, unknown> }
            : {}),
          project: presented.project!,
          projectCode: this.meta.code,
          projectName: this.meta.name,
          opId: row.op_id ?? null,
          at: row.created_at,
        };
      }),
      currentSequence: this.meta.sequence,
      hasMore,
    };
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
    const task = this.rowForTaskKey(taskKey);
    const bounded = Math.max(1, Math.min(6, limit));
    const rows = this.#sqlite
      .prepare(
        `SELECT sequence, type, aggregate_type, aggregate_id, actor_type, actor_id,
                payload_json, created_at, op_id
         FROM events
         WHERE aggregate_type = 'WORK_ITEM' AND aggregate_id = ?
         ORDER BY sequence DESC LIMIT ?`,
      )
      .all(task.id, bounded) as any[];
    return rows.map((row) => {
      const presented = presentEvent({
        type: row.type,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        actor: row.actor_id ?? row.actor_type,
        payload: json<Record<string, unknown>>(row.payload_json, {}),
        project: {
          id: this.meta.id,
          code: this.meta.code,
          name: this.meta.name,
        },
      });
      return {
        seq: Number(row.sequence),
        type: String(row.type),
        key: taskKey,
        summary: presented.summary,
        opId: row.op_id ?? null,
        at: String(row.created_at),
      };
    });
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
    const row = this.#sqlite
      .prepare(
        `SELECT checklist.*, task.local_no AS task_local_no, task.version AS task_version
         FROM checklist_items checklist
         JOIN work_items task ON task.id = checklist.work_item_id
         WHERE checklist.id = ?`,
      )
      .get(checklistId) as any;
    if (!row)
      throw new AtmError("CHECKLIST_NOT_FOUND", {
        message: `检查项不存在：${checklistId}`,
        details: { entity: "CHECKLIST", reference: checklistId },
      });
    return {
      id: row.id,
      taskKey: `${this.meta.code}-T-${String(row.task_local_no).padStart(4, "0")}`,
      taskVersion: Number(row.task_version),
      title: String(row.title),
      status: String(row.status),
      evidenceRequired: Number(row.evidence_required) === 1,
      evidenceCount: json<unknown[]>(row.evidence_json, []).length,
      version: Number(row.version),
      updatedAt: String(row.updated_at),
    };
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
    this.checklistConflictSnapshot(checklistId);
    const bounded = Math.max(1, Math.min(6, limit));
    const rows = this.#sqlite
      .prepare(
        `SELECT sequence, type, aggregate_type, aggregate_id, actor_type, actor_id,
                payload_json, created_at, op_id
         FROM events
         WHERE aggregate_type = 'CHECKLIST' AND aggregate_id = ?
         ORDER BY sequence DESC LIMIT ?`,
      )
      .all(checklistId, bounded) as any[];
    return rows.map((row) => {
      const presented = presentEvent({
        type: row.type,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        actor: row.actor_id ?? row.actor_type,
        payload: json<Record<string, unknown>>(row.payload_json, {}),
        project: {
          id: this.meta.id,
          code: this.meta.code,
          name: this.meta.name,
        },
      });
      return {
        seq: Number(row.sequence),
        type: String(row.type),
        key: checklistId,
        summary: presented.summary,
        opId: row.op_id ?? null,
        at: String(row.created_at),
      };
    });
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
    const meta = this.#sqlite
      .prepare("SELECT * FROM project_meta WHERE singleton = 1")
      .get() as any;
    const weights = this.#sqlite
      .prepare(
        `SELECT computed_progress, weight FROM work_items
         WHERE parent_id IS NULL AND archived_at IS NULL AND status <> 'CANCELLED'`,
      )
      .all() as Array<{ computed_progress: number; weight: number }>;
    const totalWeight = weights.reduce((sum, item) => sum + item.weight, 0);
    const progress =
      totalWeight === 0
        ? 0
        : Math.round(
            (weights.reduce((sum, item) => sum + item.computed_progress * item.weight, 0) /
              totalWeight) *
              10,
          ) / 10;
    const counts = this.#sqlite
      .prepare(
        `SELECT
           SUM(CASE WHEN status IN ('CLAIMED','IN_PROGRESS','VERIFYING') THEN 1 ELSE 0 END) active_count,
           SUM(CASE WHEN status = 'READY' THEN 1 ELSE 0 END) ready_count,
           SUM(CASE WHEN status = 'BLOCKED' THEN 1 ELSE 0 END) blocked_count,
           SUM(CASE WHEN status = 'WAITING_USER' THEN 1 ELSE 0 END) waiting_user_count,
           SUM(CASE WHEN status = 'WAITING_AGENT' THEN 1 ELSE 0 END) waiting_agent_count,
           SUM(CASE WHEN claimed_by_session_id IS NOT NULL
             AND claim_lease_until IS NOT NULL AND claim_lease_until < ?
             AND status NOT IN ('DONE','CANCELLED') THEN 1 ELSE 0 END) stale_claim_count,
           SUM(CASE WHEN target_date IS NOT NULL AND target_date < date('now')
             AND status NOT IN ('DONE','CANCELLED') THEN 1 ELSE 0 END) overdue_count,
           MAX(updated_at) last_activity_at,
           MIN(CASE WHEN status NOT IN ('DONE','CANCELLED') THEN target_date END) next_target_date
         FROM work_items WHERE archived_at IS NULL`,
      )
      .get(nowIso()) as any;
    const objective = this.getActiveObjective();
    const milestone = this.getActiveMilestone(objective?.id);
    const activeAgents = (
      this.#sqlite
        .prepare("SELECT COUNT(*) AS count FROM agent_sessions WHERE connection_state = 'ONLINE'")
        .get() as { count: number }
    ).count;
    const lastUpdate = this.#sqlite
      .prepare(
        "SELECT published_at FROM project_updates WHERE status = 'PUBLISHED' ORDER BY published_at DESC LIMIT 1",
      )
      .get() as { published_at: string } | undefined;
    return {
      projectId: meta.project_id,
      projectSequence: meta.current_sequence,
      progress,
      progressSource: weights.length ? "CHILDREN" : "NONE",
      health: meta.health,
      lifecycle: meta.lifecycle,
      currentObjective: objective?.title ?? null,
      currentMilestone: milestone?.title ?? null,
      activeCount: Number(counts.active_count ?? 0),
      readyCount: Number(counts.ready_count ?? 0),
      blockedCount: Number(counts.blocked_count ?? 0),
      waitingUserCount: Number(counts.waiting_user_count ?? 0),
      waitingAgentCount: Number(counts.waiting_agent_count ?? 0),
      staleClaimCount: Number(counts.stale_claim_count ?? 0),
      activeAgentCount: activeAgents,
      overdueCount: Number(counts.overdue_count ?? 0),
      lastProjectUpdateAt: lastUpdate?.published_at ?? null,
      lastActivityAt: counts.last_activity_at ?? meta.updated_at,
      nextTargetDate: counts.next_target_date ?? null,
    };
  }

  searchProjection(): any[] {
    return this.#sqlite
      .prepare(
        `SELECT entity_type, entity_key, title, substr(body, 1, 500) AS summary, updated_at
         FROM (
           SELECT *, ROW_NUMBER() OVER (
             PARTITION BY entity_type, entity_key ORDER BY updated_at DESC, rowid DESC
           ) AS recency
           FROM search_documents
         )
         WHERE recency = 1 ORDER BY updated_at DESC`,
      )
      .all() as any[];
  }

  searchProjectionForChanges(
    changes: Array<{ eventType: string; aggregateType: string; aggregateId: string }>,
  ): any[] {
    const documents = new Map<string, any>();
    const byEntity = this.#sqlite.prepare(
      `SELECT entity_type, entity_key, title, substr(body, 1, 500) AS summary, updated_at
       FROM search_documents WHERE entity_type = ? AND entity_id = ?`,
    );
    const workKey = this.#sqlite.prepare(
      "SELECT entity_key AS task_key FROM search_documents WHERE entity_type = 'WORK_ITEM' AND entity_id = ?",
    );
    const latestProgress = this.#sqlite.prepare(
      `SELECT entity_type, entity_key, title, substr(body, 1, 500) AS summary, updated_at
       FROM search_documents WHERE entity_type = 'PROGRESS' AND entity_key = ?
       ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
    );
    for (const change of changes) {
      if (change.aggregateType === "WORK_ITEM" || change.aggregateType === "RECORD") {
        const document = byEntity.get(change.aggregateType, change.aggregateId) as any;
        if (document) documents.set(`${document.entity_type}:${document.entity_key}`, document);
      }
      if (change.eventType === "work.progressed" || change.eventType === "work.blocked") {
        const task = workKey.get(change.aggregateId) as { task_key: string } | undefined;
        const progress = task ? (latestProgress.get(task.task_key) as any) : undefined;
        if (progress) documents.set(`${progress.entity_type}:${progress.entity_key}`, progress);
      }
    }
    return [...documents.values()];
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
    return this.#outboxReads.pendingOutbox(limit);
  }

  markOutboxDelivered(ids: string[]): void {
    if (ids.length === 0) return;
    const statement = this.#sqlite.prepare(
      `UPDATE outbox SET delivered_at = ?, attempts = attempts + 1, last_error = NULL
       WHERE id = ? AND delivered_at IS NULL`,
    );
    const transaction = this.#sqlite.transaction(() => {
      const now = nowIso();
      for (const id of ids) statement.run(now, id);
    });
    transaction();
  }

  markOutboxFailed(ids: string[], error: string): void {
    if (ids.length === 0) return;
    const boundedError = error.slice(0, 2_000);
    const statement = this.#sqlite.prepare(
      "UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ? AND delivered_at IS NULL",
    );
    const transaction = this.#sqlite.transaction(() => {
      for (const id of ids) statement.run(boundedError, id);
    });
    transaction();
  }

  briefSnapshot(sessionId?: string | null): BriefSnapshot {
    return this.#contextReads.briefSnapshot(sessionId);
  }

  brief(sessionId?: string | null, maxChars = 1200): any {
    return this.#contextReads.formatBrief(this.briefSnapshot(sessionId), maxChars);
  }
}
