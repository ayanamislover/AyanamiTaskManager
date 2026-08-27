import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { assertParentMove, assertAcyclicDependency, computeProgress } from "@ayanami-task/domain";
import { AtmError } from "@ayanami-task/errors";
import {
  ChecklistBatchFailureError,
  createUlid,
  EvidenceInputSchema,
  EvidenceReferenceSchema,
  normalizeReviewCandidateHashes,
  nowIso,
  RecordSummarySchema,
  resolveWorkItemOperation,
  workItemOperationHasEffect,
  type WorkItemOperation,
  type WorkItemPhase,
  type WorkItemStatus,
  type WorkItemWaitingOn,
  type EvidenceInput,
  type ChecklistBatchFailureReason,
  type SearchHit,
  type SearchPage,
  type RecordView,
  type TaskViewName,
} from "@ayanami-task/protocol";
import type { ManagedDatabase } from "./database.js";
import { assertCompletionGates } from "./completion-gates.js";
import { presentEvent, type PresentedEvent } from "./event-presentation.js";
import { decodeSearchCursor, encodeSearchCursor } from "./search-pagination.js";
import { decodeRecordListCursor, encodeRecordListCursor } from "./record-list-pagination.js";
import {
  canonicalTaskListSelection,
  decodeTaskListCursor,
  encodeTaskListCursor,
  type TaskListSelection,
} from "./task-list-pagination.js";
import { taskViewProjectionSql, type TaskViewProjectionRow } from "./task-view-query.js";

function storedWorkItemPhase(row: { status: WorkItemStatus; phase?: WorkItemPhase | null }) {
  return (row.phase ??
    (row.status === "WAITING_AGENT" || row.status === "WAITING_USER"
      ? "IN_PROGRESS"
      : row.status)) as WorkItemPhase;
}

function resolveStoredWorkItemOperation(
  operation: WorkItemOperation,
  row: { status: WorkItemStatus; phase?: WorkItemPhase | null },
  options: { successorReclaim?: boolean } = {},
) {
  return resolveWorkItemOperation(operation, {
    currentStatus: row.status,
    phase: storedWorkItemPhase(row),
    ...options,
  });
}

function json<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function requestFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)) ?? "null")
    .digest("hex");
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

type MutationInput<T> = {
  actor: ProjectActor;
  opId: string;
  operation: string;
  request: unknown;
  action: () => T;
  idempotencyKey?: string;
  immediate?: boolean;
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

export type WorkItemListFilters = {
  status?: string;
  assigneeAgentId?: string;
  parentId?: string;
  parentKey?: string;
  milestoneId?: string;
  readyOnly?: boolean;
  query?: string;
  limit?: number;
  offset?: number;
};

export type WorkItemPageFilters = Omit<WorkItemListFilters, "offset"> & {
  cursor?: string;
};

export type TaskViewProjectionPage = {
  items: TaskViewProjectionRow[];
  itemCursors: string[];
  nextCursor: string | null;
  retryCursor: string;
  hasMore: boolean;
};

export type WorkItemView = {
  id: string;
  key: string;
  localNo: number;
  parentId: string | null;
  parentKey: string | null;
  objectiveId: string;
  milestoneId: string | null;
  type: string;
  title: string;
  description: string;
  acceptance: string[];
  status: WorkItemStatus;
  phase: WorkItemPhase;
  waitingOn: WorkItemWaitingOn | null;
  phaseInferred: boolean;
  priority: string;
  assigneeAgentId: string | null;
  claimedBySessionId: string | null;
  claimLeaseUntil: string | null;
  progress: number;
  reportedProgress: number | null;
  progressSource: string;
  progressBreakdown: WorkItemProgressBreakdown;
  weight: number;
  blockedReason: string | null;
  waitingFor: string | null;
  cancelReason: string | null;
  duplicateOf: string | null;
  supersededBy: string | null;
  targetDate: string | null;
  discoveredFrom: string | null;
  discoveredCount: number;
  everClaimedAt: string | null;
  lastStartedAt: string | null;
  lastSessionClosedAt: string | null;
  lastEvidenceAt: string | null;
  version: number;
  updatedAt: string;
};

export type WorkItemProgressBreakdown = {
  computed: number;
  reported: number | null;
  source: string;
  doneWeight: number;
  totalWeight: number;
  doneStages: number;
  totalStages: number;
  blocker: string | null;
};

export type ChecklistView = {
  id: string;
  title: string;
  kind: string;
  status: string;
  weight: number;
  evidenceRequired: boolean;
  evidence: unknown[];
  version: number;
};

export type RecordPageFilters = { limit?: number; cursor?: string };

export type RecordProjectionPage = {
  items: RecordView[];
  itemCursors: string[];
  nextCursor: string | null;
  retryCursor: string;
  hasMore: boolean;
};

export type BriefSnapshotRecord = {
  key: string;
  kind: string;
  summary: string;
  importance: string;
  source_type: string;
  source_actor_id: string | null;
  source_session_id: string | null;
  source_ref: string | null;
};

export type BriefSnapshot = {
  truncated: false;
  project: string;
  seq: number;
  objective: string | null;
  milestone: string | null;
  active: number;
  blocked: number;
  waitingUser: number;
  waitingAgent: number;
  own: string[];
  next: string[];
  records: BriefSnapshotRecord[];
  currentTask: Record<string, unknown> | null;
  handoff: {
    summary: string;
    nextAction: string;
    checkpointSequence: number;
  } | null;
  recentProgress: string | null;
  artifacts: Array<{ name: string; ref: string | null }>;
};

export type ProgressUpdateView = {
  id: string;
  taskKey: string;
  percent: number | null;
  progressBucket: number | null;
  summary: string;
  completed: Array<string | { text: string; workItemKey?: string }>;
  next: string[];
  blocker: string | null;
  actor: string;
  sessionId: string | null;
  evidence: unknown[];
  opId: string | null;
  createdAt: string;
};

export type SessionView = {
  id: string;
  agentId: string;
  displayName: string;
  clientKind: string;
  capabilities: unknown[];
  parentSessionId: string | null;
  predecessorSessionId: string | null;
  threadId: string | null;
  role: string;
  cwd: string | null;
  workState: string;
  connectionState: string;
  currentTaskKey: string | null;
  heartbeatAt: string | null;
  version: number;
  startedAt: string;
  updatedAt: string;
  closedAt: string | null;
  retirementReason: string | null;
  closeReason: string | null;
  git: {
    available: boolean;
    repoRoot: string | null;
    worktreeRoot: string | null;
    commonDir: string | null;
    isLinkedWorktree: boolean | null;
    branch: string | null;
    head: string | null;
    detached: boolean | null;
    dirty: boolean | null;
    error: string | null;
  };
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

function workItemFromRow(
  row: any,
  projectCode: string,
  progressBreakdown: WorkItemProgressBreakdown,
): WorkItemView {
  const status = row.status as WorkItemStatus;
  const phase = (row.phase ??
    (status === "WAITING_AGENT" || status === "WAITING_USER"
      ? "IN_PROGRESS"
      : status)) as WorkItemPhase;
  return {
    id: row.id,
    key: `${projectCode}-T-${String(row.local_no).padStart(4, "0")}`,
    localNo: row.local_no,
    parentId: row.parent_id,
    parentKey: row.parent_key ?? null,
    objectiveId: row.objective_id,
    milestoneId: row.milestone_id,
    type: row.type,
    title: row.title,
    description: row.description,
    acceptance: json(row.acceptance_json, []),
    status,
    phase,
    waitingOn:
      row.waiting_on ??
      (status === "WAITING_AGENT" ? "AGENT" : status === "WAITING_USER" ? "USER" : null),
    phaseInferred:
      Number(row.phase_inferred ?? (status === "WAITING_AGENT" || status === "WAITING_USER")) === 1,
    priority: row.priority,
    assigneeAgentId: row.assignee_agent_id,
    claimedBySessionId: row.claimed_by_session_id,
    claimLeaseUntil: row.claim_lease_until,
    progress: row.computed_progress,
    reportedProgress: row.reported_progress,
    progressSource: row.progress_source,
    progressBreakdown,
    weight: row.weight,
    blockedReason: row.blocked_reason,
    waitingFor: row.waiting_for,
    cancelReason: row.cancel_reason ?? null,
    duplicateOf: row.duplicate_of_key ?? null,
    supersededBy: row.superseded_by_key ?? null,
    targetDate: row.target_date,
    discoveredFrom:
      typeof row.discovered_from_local_no === "number"
        ? `${projectCode}-T-${String(row.discovered_from_local_no).padStart(4, "0")}`
        : null,
    discoveredCount: Number(row.discovered_count ?? 0),
    everClaimedAt: row.ever_claimed_at ?? null,
    lastStartedAt: row.last_started_at ?? null,
    lastSessionClosedAt: row.last_session_closed_at ?? null,
    lastEvidenceAt: row.last_evidence_at ?? null,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

export class ProjectRepository {
  readonly database: ManagedDatabase;
  readonly #sqlite: Database.Database;
  #activeOperationId: string | null = null;

  constructor(database: ManagedDatabase) {
    this.database = database;
    this.#sqlite = database.sqlite;
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
    const row = this.#sqlite
      .prepare(
        "UPDATE counters SET next_value = next_value + 1 WHERE name = ? RETURNING next_value - 1 AS value",
      )
      .get(name) as { value: number } | undefined;
    if (!row)
      throw new AtmError("COUNTER_NOT_FOUND", {
        message: `计数器不存在：${name}`,
        details: { reference: name },
      });
    return row.value;
  }

  private appendEvent(
    type: string,
    actor: ProjectActor,
    aggregateType: string,
    aggregateId: string,
    payload: unknown,
    correlationId: string | null = null,
  ): number {
    const at = nowIso();
    const sequenceRow = this.#sqlite
      .prepare(
        `UPDATE project_meta SET current_sequence = current_sequence + 1, updated_at = ?
         WHERE singleton = 1 RETURNING current_sequence`,
      )
      .get(at) as { current_sequence: number };
    const eventId = createUlid();
    this.#sqlite
      .prepare(
        `INSERT INTO events(
           id, sequence, type, actor_type, actor_id, session_id, aggregate_type, aggregate_id,
           causation_id, correlation_id, payload_json, created_at, op_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        sequenceRow.current_sequence,
        type,
        actor.type,
        actor.id,
        actor.sessionId,
        aggregateType,
        aggregateId,
        correlationId,
        JSON.stringify(payload),
        at,
        this.#activeOperationId,
      );
    this.#sqlite
      .prepare(
        `INSERT INTO outbox(id, project_sequence, type, payload_json, created_at)
         VALUES (?, ?, 'registry.project_changed', ?, ?)`,
      )
      .run(
        createUlid(),
        sequenceRow.current_sequence,
        JSON.stringify({ eventId, type, aggregateType, aggregateId }),
        at,
      );
    return sequenceRow.current_sequence;
  }

  private mutate<T>(input: MutationInput<T>): T {
    return this.mutateWithReplay(input).value;
  }

  private mutateWithReplay<T>(input: MutationInput<T>): { value: T; replayed: boolean } {
    const key = input.idempotencyKey ?? `${input.actor.sessionId ?? input.actor.id}:${input.opId}`;
    const fingerprint = requestFingerprint(input.request);
    const transaction = this.#sqlite.transaction(() => {
      const cached = this.#sqlite
        .prepare("SELECT * FROM idempotency_keys WHERE key = ?")
        .get(key) as any;
      if (cached) {
        if (cached.operation !== input.operation || cached.request_fingerprint !== fingerprint) {
          throw new AtmError("IDEMPOTENCY_CONFLICT", {
            message: `幂等键冲突：${key}`,
            details: { key },
          });
        }
        return { value: JSON.parse(cached.response_json) as T, replayed: true };
      }
      const previousOperationId = this.#activeOperationId;
      this.#activeOperationId = input.opId;
      let result: T;
      try {
        result = input.action();
      } finally {
        this.#activeOperationId = previousOperationId;
      }
      this.#sqlite
        .prepare(
          `INSERT INTO idempotency_keys(
             key, operation, request_fingerprint, response_json, created_at, op_id, actor_session_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          key,
          input.operation,
          fingerprint,
          JSON.stringify(result),
          nowIso(),
          input.opId,
          input.actor.sessionId,
        );
      return { value: result, replayed: false };
    });
    return input.immediate ? transaction.immediate() : transaction();
  }

  createSession(input: CreateSessionInput): { id: string; sequence: number } {
    return this.#sqlite.transaction(() => {
      const now = nowIso();
      if (input.resume && input.predecessorSessionId) {
        const predecessor = this.#sqlite
          .prepare(
            "SELECT agent_id, connection_state, retirement_reason FROM agent_sessions WHERE id = ?",
          )
          .get(input.predecessorSessionId) as
          | { agent_id: string; connection_state: string; retirement_reason: string | null }
          | undefined;
        if (!predecessor)
          throw new AtmError("SESSION_NOT_FOUND", {
            message: `Session 不存在：${input.predecessorSessionId}`,
            details: { entity: "SESSION", reference: input.predecessorSessionId },
          });
        if (predecessor.agent_id !== input.agentId)
          throw new AtmError("SESSION_SUCCESSOR_AGENT_MISMATCH", {
            message: "Session successor Agent 不匹配",
          });
        if (predecessor.connection_state !== "CLOSED" || !predecessor.retirement_reason) {
          throw new AtmError("SESSION_NOT_RETIRED", { message: "前序 Session 尚未退休" });
        }
      }
      this.#sqlite
        .prepare(
          `INSERT INTO agents(id, display_name, client_kind, capabilities_json, created_at, updated_at)
           VALUES (?, ?, ?, '[]', ?, ?)
           ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name,
             client_kind = excluded.client_kind, updated_at = excluded.updated_at`,
        )
        .run(input.agentId, input.displayName, input.clientKind, now, now);
      const id = createUlid();
      this.#sqlite
        .prepare(
          `INSERT INTO agent_sessions(
             id, agent_id, parent_session_id, thread_id, role, cwd, git_branch, git_head,
             work_state, connection_state, heartbeat_at, version, started_at, updated_at,
             predecessor_session_id, git_repo_root, worktree_root, git_common_dir,
             git_is_linked_worktree, git_detached, git_dirty, git_available, git_error
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PLANNING', 'ONLINE', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.agentId,
          input.parentSessionId ?? null,
          input.threadId ?? null,
          input.role,
          input.cwd ?? null,
          input.gitContext?.available ? input.gitContext.branch : (input.gitBranch ?? null),
          input.gitContext?.available ? input.gitContext.head : (input.gitHead ?? null),
          now,
          now,
          now,
          input.predecessorSessionId ?? null,
          input.gitContext?.repoRoot ?? null,
          input.gitContext?.worktreeRoot ?? null,
          input.gitContext?.gitCommonDir ?? null,
          input.gitContext == null || input.gitContext.isLinkedWorktree === null
            ? null
            : input.gitContext.isLinkedWorktree
              ? 1
              : 0,
          input.gitContext == null || input.gitContext.detached === null
            ? null
            : input.gitContext.detached
              ? 1
              : 0,
          input.gitContext == null || input.gitContext.dirty === null
            ? null
            : input.gitContext.dirty
              ? 1
              : 0,
          input.gitContext?.available ? 1 : 0,
          input.gitContext?.error ?? null,
        );
      if (input.resume) {
        this.#sqlite
          .prepare(
            `UPDATE handoffs SET to_session_id = ?, acknowledged_at = ?
             WHERE to_agent_id = ? AND to_session_id IS NULL
               AND from_session_id = COALESCE(?, from_session_id)`,
          )
          .run(id, now, input.agentId, input.predecessorSessionId ?? null);
      }
      const sequence = this.appendEvent(
        "agent.joined",
        { type: "AGENT", id: input.agentId, sessionId: id },
        "SESSION",
        id,
        {
          agentId: input.agentId,
          displayName: input.displayName,
          role: input.role,
          parentSessionId: input.parentSessionId ?? null,
          resume: input.resume ?? false,
          predecessorSessionId: input.predecessorSessionId ?? null,
          git: input.gitContext ?? null,
        },
      );
      return { id, sequence };
    })();
  }

  recoverOrCreateSession(
    operationId: string,
    request: unknown,
    input: CreateSessionInput,
  ): { id: string; sequence: number; disposition: "CREATED" | "RECOVERED" } {
    const normalizedOperationId = operationId.trim();
    if (!normalizedOperationId || normalizedOperationId.length > 128) {
      throw new AtmError("OPERATION_ID_INVALID", { message: "operationId 无效" });
    }
    const mutation = this.mutateWithReplay({
      actor: { type: "SYSTEM", id: "session-begin", sessionId: null },
      opId: normalizedOperationId,
      operation: "session.recover-or-begin",
      request,
      idempotencyKey: `session-begin:${normalizedOperationId}`,
      immediate: true,
      action: () => this.createSession(input),
    });
    return {
      ...mutation.value,
      disposition: mutation.replayed ? "RECOVERED" : "CREATED",
    };
  }

  getSession(id: string): any {
    const row = this.#sqlite
      .prepare(
        `SELECT session.*, agent.display_name, agent.client_kind, agent.capabilities_json
         FROM agent_sessions session
         JOIN agents agent ON agent.id = session.agent_id
         WHERE session.id = ?`,
      )
      .get(id);
    if (!row)
      throw new AtmError("SESSION_NOT_FOUND", {
        message: `Session 不存在：${id}`,
        details: { entity: "SESSION", reference: id },
      });
    return row;
  }

  getSessionView(id: string): SessionView {
    const row = this.getSession(id);
    const nullableBoolean = (value: unknown): boolean | null =>
      value == null ? null : Boolean(value);
    return {
      id: row.id,
      agentId: row.agent_id,
      displayName: row.display_name,
      clientKind: row.client_kind,
      capabilities: json(row.capabilities_json, []),
      parentSessionId: row.parent_session_id ?? null,
      predecessorSessionId: row.predecessor_session_id ?? null,
      threadId: row.thread_id ?? null,
      role: row.role,
      cwd: row.cwd ?? null,
      workState: row.work_state,
      connectionState: row.connection_state,
      currentTaskKey: row.current_work_item_id
        ? this.taskKeyForId(String(row.current_work_item_id))
        : null,
      heartbeatAt: row.heartbeat_at ?? null,
      version: Number(row.version),
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      closedAt: row.closed_at ?? null,
      retirementReason: row.retirement_reason ?? null,
      closeReason: row.close_reason ?? null,
      git: {
        available: Boolean(row.git_available),
        repoRoot: row.git_repo_root ?? null,
        worktreeRoot: row.worktree_root ?? null,
        commonDir: row.git_common_dir ?? null,
        isLinkedWorktree: nullableBoolean(row.git_is_linked_worktree),
        branch: row.git_branch ?? null,
        head: row.git_head ?? null,
        detached: nullableBoolean(row.git_detached),
        dirty: nullableBoolean(row.git_dirty),
        error: row.git_error ?? null,
      },
    };
  }

  private normalizeMutationRequest(operation: string, request: unknown): unknown {
    if (
      operation !== "record.create" ||
      !request ||
      typeof request !== "object" ||
      Array.isArray(request)
    ) {
      return request;
    }
    const record = request as Record<string, unknown>;
    return {
      ...record,
      ...(typeof record.supersedes === "string" && record.supersedes.trim()
        ? { supersedes: this.recordRow(record.supersedes).id }
        : {}),
      ...(typeof record.topic === "string" ? { topic: record.topic.trim() || null } : {}),
      ...(typeof record.subjectKey === "string"
        ? { subjectKey: record.subjectKey.trim() || null }
        : {}),
    };
  }

  /** Resolve exact replay or a safe successor before the application rejects a closed Session. */
  resolveMutationActor(
    sessionId: string,
    opId: string,
    operation: string,
    request: unknown,
  ): MutationActorResolution {
    return this.resolveMutationActorInternal(sessionId, opId, operation, request, false);
  }

  executeSessionMutation<T>(
    sessionId: string,
    opId: string,
    operation: string,
    request: unknown,
    action: (actor: ProjectActor) => T,
  ): SessionMutationExecution<T> {
    return this.#sqlite
      .transaction(() => {
        const resolution = this.resolveMutationActorInternal(
          sessionId,
          opId,
          operation,
          request,
          true,
        );
        return { result: action(resolution.actor), resolution };
      })
      .immediate();
  }

  private resolveMutationActorInternal(
    sessionId: string,
    opId: string,
    operation: string,
    request: unknown,
    createRecoverySuccessor: boolean,
  ): MutationActorResolution {
    const normalizedOpId = opId.trim();
    if (!normalizedOpId || normalizedOpId.length > 128)
      throw new AtmError("OPERATION_ID_INVALID", { message: "operationId 无效" });
    const fingerprint = requestFingerprint(this.normalizeMutationRequest(operation, request));
    const requested = this.getSession(sessionId);
    const visited = new Set<string>();
    let candidate: any | undefined = requested;
    while (candidate && !visited.has(String(candidate.id))) {
      visited.add(String(candidate.id));
      const cached = this.#sqlite
        .prepare("SELECT operation, request_fingerprint FROM idempotency_keys WHERE key = ?")
        .get(`${candidate.id}:${normalizedOpId}`) as
        | { operation: string; request_fingerprint: string }
        | undefined;
      if (cached) {
        if (cached.operation !== operation || cached.request_fingerprint !== fingerprint) {
          throw new AtmError("IDEMPOTENCY_CONFLICT", {
            message: "幂等操作与现有 Session 不一致",
            details: { session_id: candidate.id, operation_id: normalizedOpId },
          });
        }
        return {
          actor: { type: "AGENT", id: candidate.agent_id, sessionId: candidate.id },
          disposition: "REPLAY",
          requestedSessionId: sessionId,
        };
      }
      if (requested.connection_state !== "ONLINE" || !candidate.predecessor_session_id) break;
      candidate = this.#sqlite
        .prepare("SELECT * FROM agent_sessions WHERE id = ?")
        .get(candidate.predecessor_session_id);
    }

    if (requested.connection_state === "ONLINE") {
      return {
        actor: { type: "AGENT", id: requested.agent_id, sessionId },
        disposition: "CURRENT",
        requestedSessionId: sessionId,
      };
    }
    if (requested.close_reason !== "HEARTBEAT_TIMEOUT") {
      throw new AtmError("SESSION_CLOSED", {
        message: sessionId,
        details: { entity: "SESSION", session_id: sessionId, reference: sessionId },
      });
    }
    const successors = this.#sqlite
      .prepare(
        `SELECT * FROM agent_sessions
         WHERE predecessor_session_id = ? AND connection_state = 'ONLINE'
         ORDER BY started_at DESC`,
      )
      .all(sessionId) as any[];
    if (successors.length > 1)
      throw new AtmError("SESSION_SUCCESSOR_AMBIGUOUS", {
        message: `Session successor 不唯一：${sessionId}`,
        details: { session_id: sessionId },
      });
    let successor = successors[0];
    if (successor && !this.isMatchingRecoverySuccessor(requested, successor)) {
      throw new AtmError("SESSION_SUCCESSOR_IDENTITY_MISMATCH", {
        message: `Session successor 身份不匹配：${sessionId}`,
        details: { session_id: sessionId },
      });
    }
    if (!successor && createRecoverySuccessor) {
      const agent = this.#sqlite
        .prepare("SELECT display_name, client_kind FROM agents WHERE id = ?")
        .get(requested.agent_id) as { display_name: string; client_kind: string } | undefined;
      if (!agent)
        throw new AtmError("SESSION_SUCCESSOR_IDENTITY_MISMATCH", {
          message: `Session successor 身份不匹配：${sessionId}`,
          details: { session_id: sessionId },
        });
      const created = this.createSession({
        agentId: requested.agent_id,
        displayName: agent.display_name,
        clientKind: agent.client_kind,
        parentSessionId: requested.parent_session_id ?? null,
        threadId: requested.thread_id ?? null,
        role: requested.role,
        cwd: requested.cwd ?? null,
        gitBranch: requested.git_branch ?? null,
        gitHead: requested.git_head ?? null,
        gitContext: {
          available: Boolean(requested.git_available),
          repoRoot: requested.git_repo_root ?? null,
          worktreeRoot: requested.worktree_root ?? null,
          gitCommonDir: requested.git_common_dir ?? null,
          isLinkedWorktree:
            requested.git_is_linked_worktree == null
              ? null
              : Boolean(requested.git_is_linked_worktree),
          branch: requested.git_branch ?? null,
          head: requested.git_head ?? null,
          detached: requested.git_detached == null ? null : Boolean(requested.git_detached),
          dirty: requested.git_dirty == null ? null : Boolean(requested.git_dirty),
          error: requested.git_error ?? null,
        },
        resume: true,
        predecessorSessionId: requested.id,
      });
      successor = this.getSession(created.id);
    }
    if (!successor) {
      throw new AtmError("SESSION_CLOSED", {
        message: sessionId,
        details: { entity: "SESSION", session_id: sessionId, reference: sessionId },
      });
    }
    return {
      actor: { type: "AGENT", id: successor.agent_id, sessionId: successor.id },
      disposition: "REBOUND",
      requestedSessionId: sessionId,
    };
  }

  private isMatchingRecoverySuccessor(predecessor: any, successor: any): boolean {
    return (
      successor.agent_id === predecessor.agent_id &&
      successor.thread_id === predecessor.thread_id &&
      successor.parent_session_id === predecessor.parent_session_id &&
      successor.role === predecessor.role
    );
  }

  updateSessionGitContext(
    id: string,
    context: SessionGitContext,
  ): { updated: boolean; sequence: number } {
    const current = this.getSession(id);
    const next = {
      git_branch: context.available ? context.branch : current.git_branch,
      git_head: context.available ? context.head : current.git_head,
      git_repo_root: context.available ? context.repoRoot : current.git_repo_root,
      worktree_root: context.available ? context.worktreeRoot : current.worktree_root,
      git_common_dir: context.available ? context.gitCommonDir : current.git_common_dir,
      git_is_linked_worktree: context.available
        ? context.isLinkedWorktree === null
          ? null
          : context.isLinkedWorktree
            ? 1
            : 0
        : current.git_is_linked_worktree,
      git_detached: context.available
        ? context.detached === null
          ? null
          : context.detached
            ? 1
            : 0
        : current.git_detached,
      git_dirty: context.available
        ? context.dirty === null
          ? null
          : context.dirty
            ? 1
            : 0
        : current.git_dirty,
      git_available: context.available ? 1 : 0,
      git_error: context.error,
    };
    if (Object.entries(next).every(([key, value]) => current[key] === value)) {
      return { updated: false, sequence: this.meta.sequence };
    }
    const now = nowIso();
    this.#sqlite
      .prepare(
        `UPDATE agent_sessions SET git_branch = ?, git_head = ?, git_repo_root = ?,
           worktree_root = ?, git_common_dir = ?, git_is_linked_worktree = ?,
           git_detached = ?, git_dirty = ?, git_available = ?, git_error = ?,
           updated_at = ?, version = version + 1 WHERE id = ?`,
      )
      .run(
        next.git_branch,
        next.git_head,
        next.git_repo_root,
        next.worktree_root,
        next.git_common_dir,
        next.git_is_linked_worktree,
        next.git_detached,
        next.git_dirty,
        next.git_available,
        next.git_error,
        now,
        id,
      );
    const sequence = this.appendEvent(
      "agent.git_context.updated",
      { type: "SYSTEM", id: "SYSTEM", sessionId: null },
      "SESSION",
      id,
      {
        agentId: current.agent_id,
        available: context.available,
        branch: next.git_branch,
        head: next.git_head,
        worktreeRoot: next.worktree_root,
        dirty: next.git_dirty === null ? null : next.git_dirty === 1,
        error: next.git_error,
      },
    );
    return { updated: true, sequence };
  }

  getActiveObjective(): any | null {
    return (
      this.#sqlite
        .prepare(
          "SELECT * FROM objectives WHERE status = 'ACTIVE' ORDER BY updated_at DESC LIMIT 1",
        )
        .get() ?? null
    );
  }

  getActiveMilestone(objectiveId?: string): any | null {
    return (
      this.#sqlite
        .prepare(
          `SELECT * FROM milestones WHERE status = 'ACTIVE'
           AND (? IS NULL OR objective_id = ?) ORDER BY sort_key LIMIT 1`,
        )
        .get(objectiveId ?? null, objectiveId ?? null) ?? null
    );
  }

  listObjectives(): any[] {
    return this.#sqlite.prepare("SELECT * FROM objectives ORDER BY created_at").all() as any[];
  }

  listMilestones(objectiveId?: string): any[] {
    return this.#sqlite
      .prepare(
        `SELECT * FROM milestones WHERE (? IS NULL OR objective_id = ?)
         ORDER BY sort_key, created_at`,
      )
      .all(objectiveId ?? null, objectiveId ?? null) as any[];
  }

  listAgentSessions(limit = 100): any[] {
    return this.#sqlite
      .prepare(
        `SELECT session.id, session.agent_id, agent.display_name, agent.client_kind,
                session.role, session.connection_state, session.work_state,
                session.current_work_item_id AS current_task_id,
                session.parent_session_id, session.thread_id, session.started_at,
                session.cwd, session.git_branch, session.git_head, session.git_repo_root,
                session.worktree_root, session.git_common_dir, session.git_is_linked_worktree,
                session.git_detached, session.git_dirty, session.git_available, session.git_error,
                task.local_no AS current_task_local_no,
                COALESCE(session.heartbeat_at, session.updated_at) AS last_seen_at,
                session.closed_at AS ended_at, NULL AS outcome, NULL AS summary
         FROM agent_sessions session
         JOIN agents agent ON agent.id = session.agent_id
         LEFT JOIN work_items task ON task.id = session.current_work_item_id
         ORDER BY COALESCE(session.heartbeat_at, session.updated_at) DESC LIMIT ?`,
      )
      .all(Math.min(200, Math.max(1, limit)))
      .map((row: any) => ({
        ...row,
        current_task_key:
          typeof row.current_task_local_no === "number"
            ? `${this.meta.code}-T-${String(row.current_task_local_no).padStart(4, "0")}`
            : null,
      })) as any[];
  }

  countAgentSessions(): number {
    const row = this.#sqlite.prepare("SELECT COUNT(*) AS count FROM agent_sessions").get() as {
      count: number;
    };
    return Number(row.count);
  }

  recoverStaleSessions(cutoffIso: string): number {
    return this.#sqlite.transaction(() => {
      const rows = this.#sqlite
        .prepare(
          `SELECT id, agent_id, closed_at FROM agent_sessions
           WHERE connection_state = 'ONLINE' AND COALESCE(heartbeat_at, updated_at) < ?`,
        )
        .all(cutoffIso) as Array<{ id: string; agent_id: string; closed_at: string | null }>;
      const now = nowIso();
      for (const row of rows) {
        const closedAt = row.closed_at ?? now;
        this.#sqlite
          .prepare(
            `UPDATE agent_sessions SET connection_state = 'CLOSED', work_state = 'IDLE',
             closed_at = COALESCE(closed_at, ?), updated_at = ?, retirement_reason = 'startup recovery: heartbeat expired',
             close_reason = 'HEARTBEAT_TIMEOUT', version = version + 1 WHERE id = ?`,
          )
          .run(closedAt, now, row.id);
        this.recordSessionClosedAtForHandledWorkItems(row.id, closedAt);
        this.appendEvent(
          "agent.recovered_stale",
          { type: "SYSTEM", id: "SYSTEM", sessionId: null },
          "SESSION",
          row.id,
          { agentId: row.agent_id, claimDisposition: "STALE_TAKEOVER_REQUIRED" },
        );
      }
      return rows.length;
    })();
  }

  forceCloseSession(
    sessionId: string,
    releaseClaims: boolean,
  ): { ok: 1; session: string; released: number; seq: number } {
    return this.#sqlite.transaction(() => {
      const session = this.#sqlite
        .prepare("SELECT id, agent_id, closed_at FROM agent_sessions WHERE id = ?")
        .get(sessionId) as { id: string; agent_id: string; closed_at: string | null } | undefined;
      if (!session)
        throw new AtmError("SESSION_NOT_FOUND", {
          message: `Session 不存在：${sessionId}`,
          details: { entity: "SESSION", reference: sessionId },
        });
      const now = nowIso();
      const closedAt = session.closed_at ?? now;
      const released = releaseClaims
        ? (
            this.#sqlite
              .prepare("SELECT COUNT(*) AS count FROM work_items WHERE claimed_by_session_id = ?")
              .get(sessionId) as { count: number }
          ).count
        : 0;
      if (releaseClaims) {
        this.#sqlite
          .prepare(
            `UPDATE work_items SET status = CASE WHEN status = 'CLAIMED' THEN 'READY' ELSE status END,
             phase = CASE WHEN status = 'CLAIMED' THEN 'READY' ELSE phase END,
             phase_inferred = CASE WHEN status = 'CLAIMED' THEN 0 ELSE phase_inferred END,
             assignee_agent_id = CASE WHEN status = 'CLAIMED' THEN NULL ELSE assignee_agent_id END,
             claimed_by_session_id = NULL, claim_lease_until = NULL,
             version = version + 1, updated_at = ? WHERE claimed_by_session_id = ?`,
          )
          .run(now, sessionId);
      }
      this.#sqlite
        .prepare(
          `UPDATE agent_sessions SET connection_state = 'CLOSED', work_state = 'IDLE',
           closed_at = COALESCE(closed_at, ?), updated_at = ?,
           retirement_reason = 'closed by user', close_reason = 'FORCE_CLOSE',
           version = version + 1 WHERE id = ?`,
        )
        .run(closedAt, now, sessionId);
      this.recordSessionClosedAtForHandledWorkItems(sessionId, closedAt);
      const seq = this.appendEvent(
        "agent.force_closed",
        { type: "USER", id: "USER", sessionId: null },
        "SESSION",
        sessionId,
        { agentId: session.agent_id, releasedClaims: released },
      );
      return { ok: 1 as const, session: sessionId, released, seq };
    })();
  }

  listRecordPage(filters: RecordPageFilters = {}): RecordProjectionPage {
    const project = this.meta.code;
    const selection = { list: "records" as const };
    const decoded = filters.cursor
      ? decodeRecordListCursor(filters.cursor, { project, selection })
      : { last: null };
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (decoded.last) {
      clauses.push("(records.updated_at, records.local_no) < (?, ?)");
      parameters.push(decoded.last.updatedAt, decoded.last.localNo);
    }
    const limit = Math.min(100, Math.max(1, filters.limit ?? 100));
    parameters.push(limit + 1, project, project, project);
    const rows = this.#sqlite
      .prepare(
        `WITH selected_records AS (
           SELECT records.*
           FROM records
           ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
           ORDER BY records.updated_at DESC, records.local_no DESC
           LIMIT ?
         ), related_candidates AS (
           SELECT selected_records.id AS selected_id,
                  related.updated_at AS related_updated_at,
                  related.local_no AS related_local_no,
                  ? || CASE WHEN related.kind = 'DECISION' THEN '-D-' ELSE '-R-' END ||
                    printf('%03d', related.local_no) AS related_key,
                  row_number() OVER (
                    PARTITION BY selected_records.id
                    ORDER BY related.updated_at DESC, related.local_no DESC
                  ) AS related_rank
           FROM selected_records
           JOIN records related
             ON related.id <> selected_records.id
            AND related.status = 'ACTIVE'
            AND ((selected_records.topic IS NOT NULL AND related.topic = selected_records.topic)
              OR (selected_records.subject_key IS NOT NULL
                AND related.subject_key = selected_records.subject_key))
         ), related_aggregates AS (
           SELECT selected_id, json_group_array(related_key) AS related_records_json
           FROM (
             SELECT selected_id, related_key
             FROM related_candidates
             WHERE related_rank <= 20
             ORDER BY selected_id, related_updated_at DESC, related_local_no DESC
           ) ordered_related
           GROUP BY selected_id
         ), projected_records AS (
           SELECT selected_records.*,
                  CASE WHEN work_item.local_no IS NULL THEN NULL
                       ELSE ? || '-T-' || printf('%04d', work_item.local_no) END AS work_item_key,
                  CASE WHEN superseded.local_no IS NULL THEN NULL
                       ELSE ? || CASE WHEN superseded.kind = 'DECISION' THEN '-D-' ELSE '-R-' END ||
                            printf('%03d', superseded.local_no) END AS supersedes_key,
                  COALESCE(related_aggregates.related_records_json, '[]') AS related_records_json
           FROM selected_records
           LEFT JOIN work_items work_item ON work_item.id = selected_records.work_item_id
           LEFT JOIN records superseded ON superseded.id = selected_records.supersedes_id
           LEFT JOIN related_aggregates ON related_aggregates.selected_id = selected_records.id
         )
         SELECT * FROM projected_records
         ORDER BY updated_at DESC, local_no DESC`,
      )
      .all(...parameters) as any[];
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const items = selected.map(
      (row): RecordView => ({
        id: String(row.id),
        key: this.recordKey(row),
        kind: String(row.kind),
        title: String(row.title),
        summary: String(row.summary),
        detail: String(row.detail),
        importance: String(row.importance),
        scope: String(row.scope),
        workItemKey: row.work_item_key ? String(row.work_item_key) : null,
        supersedes: row.supersedes_key ? String(row.supersedes_key) : null,
        status: row.status as RecordView["status"],
        topic: row.topic === null ? null : String(row.topic),
        subjectKey: row.subject_key === null ? null : String(row.subject_key),
        relatedRecords: json<string[]>(row.related_records_json, []),
        opId: row.op_id === null ? null : String(row.op_id),
        sourceType: row.source_type as RecordView["sourceType"],
        sourceActorId: row.source_actor_id === null ? null : String(row.source_actor_id),
        sourceSessionId: row.source_session_id === null ? null : String(row.source_session_id),
        sourceRef: row.source_ref === null ? null : String(row.source_ref),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      }),
    );
    const itemCursors = selected.map((row) =>
      encodeRecordListCursor({
        project,
        selection,
        last: { updatedAt: String(row.updated_at), localNo: Number(row.local_no) },
      }),
    );
    const startCursor = encodeRecordListCursor({ project, selection, last: null });
    return {
      items,
      itemCursors,
      nextCursor: hasMore ? itemCursors.at(-1)! : null,
      retryCursor: filters.cursor ?? startCursor,
      hasMore,
    };
  }

  listRecords(limit = 100): RecordView[] {
    return this.listRecordPage({ limit }).items;
  }

  private recordKey(row: { local_no: number; kind: string }): string {
    return `${this.meta.code}-${row.kind === "DECISION" ? "D" : "R"}-${String(row.local_no).padStart(3, "0")}`;
  }

  private recordRow(reference: string): any {
    const normalized = reference.trim();
    let row = this.#sqlite.prepare("SELECT * FROM records WHERE id = ?").get(normalized) as any;
    if (!row) {
      const publicPrefix = `${this.meta.code}-`;
      if (normalized.startsWith(publicPrefix)) {
        const suffix = normalized.slice(publicPrefix.length);
        const match = /^(D|R)-(\d{3,})$/u.exec(suffix);
        if (match) {
          row = this.#sqlite
            .prepare("SELECT * FROM records WHERE local_no = ?")
            .get(Number(match[2])) as any;
          if (row && (match[1] === "D") !== (row.kind === "DECISION")) row = undefined;
        }
      }
    }
    if (!row)
      throw new AtmError("RECORD_NOT_FOUND", {
        message: `Record 不存在：${reference}`,
        details: { entity: "RECORD", reference },
      });
    return row;
  }

  private relatedRecordKeys(row: any): string[] {
    if (!row.topic && !row.subject_key) return [];
    return (
      this.#sqlite
        .prepare(
          `SELECT local_no, kind FROM records
           WHERE id <> ? AND status = 'ACTIVE' AND (
             (? IS NOT NULL AND topic = ?) OR (? IS NOT NULL AND subject_key = ?)
           ) ORDER BY updated_at DESC LIMIT 20`,
        )
        .all(row.id, row.topic, row.topic, row.subject_key, row.subject_key) as Array<{
        local_no: number;
        kind: string;
      }>
    ).map((candidate) => this.recordKey(candidate));
  }

  getRecord(reference: string): RecordView {
    const row = this.recordRow(reference);
    return {
      id: row.id,
      key: this.recordKey(row),
      kind: row.kind,
      title: row.title,
      summary: row.summary,
      detail: row.detail,
      importance: row.importance,
      scope: row.scope,
      workItemKey: row.work_item_id ? this.taskKeyForId(row.work_item_id) : null,
      supersedes: row.supersedes_id
        ? this.recordKey(this.recordRow(String(row.supersedes_id)))
        : null,
      status: row.status,
      topic: row.topic ?? null,
      subjectKey: row.subject_key ?? null,
      relatedRecords: this.relatedRecordKeys(row),
      opId: row.op_id ?? null,
      sourceType: row.source_type,
      sourceActorId: row.source_actor_id ?? null,
      sourceSessionId: row.source_session_id ?? null,
      sourceRef: row.source_ref ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private progressUpdateView(row: any): ProgressUpdateView {
    return {
      id: row.id,
      taskKey: `${this.meta.code}-T-${String(row.local_no).padStart(4, "0")}`,
      percent: row.percent,
      progressBucket: row.progress_bucket,
      summary: row.summary,
      completed: json(row.completed_json, []),
      next: json(row.next_json, []),
      blocker: row.blocker_text,
      actor: row.actor,
      sessionId: row.session_id,
      evidence: json(row.evidence_json, []),
      opId: row.op_id ?? null,
      createdAt: row.created_at,
    };
  }

  getProgressUpdate(id: string): ProgressUpdateView {
    const normalized = id.trim();
    const row = this.#sqlite
      .prepare(
        `SELECT progress.*, item.local_no FROM progress_updates progress
         JOIN work_items item ON item.id = progress.work_item_id
         WHERE progress.id = ?`,
      )
      .get(normalized);
    if (!row)
      throw new AtmError("PROGRESS_NOT_FOUND", {
        message: `进度记录不存在：${normalized}`,
        details: { entity: "PROGRESS", reference: normalized },
      });
    return this.progressUpdateView(row);
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
    return this.mutate({
      actor,
      opId,
      operation: "objective.create",
      request: input,
      action: () => {
        const now = nowIso();
        this.#sqlite
          .prepare(
            "UPDATE objectives SET status = 'PLANNED', version = version + 1, updated_at = ? WHERE status = 'ACTIVE'",
          )
          .run(now);
        const id = createUlid();
        const localNo = this.nextNumber("objective");
        this.#sqlite
          .prepare(
            `INSERT INTO objectives(
               id, local_no, title, description, definition_of_done_json, status, weight,
               version, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', 1, 0, ?, ?)`,
          )
          .run(
            id,
            localNo,
            input.title,
            input.description,
            JSON.stringify(input.definitionOfDone),
            now,
            now,
          );
        const sequence = this.appendEvent("objective.created", actor, "OBJECTIVE", id, {
          localNo,
          title: input.title,
        });
        return { id, localNo, title: input.title, status: "ACTIVE", version: 0, sequence };
      },
    });
  }

  createMilestone(
    actor: ProjectActor,
    input: { objectiveId: string; title: string; description?: string; targetDate?: string | null },
    opId = `milestone-${createUlid()}`,
  ): any {
    return this.mutate({
      actor,
      opId,
      operation: "milestone.create",
      request: input,
      action: () => {
        const objective = this.#sqlite
          .prepare("SELECT id FROM objectives WHERE id = ?")
          .get(input.objectiveId);
        if (!objective)
          throw new AtmError("OBJECTIVE_NOT_FOUND", {
            message: `目标不存在：${input.objectiveId}`,
            details: { entity: "OBJECTIVE", reference: input.objectiveId },
          });
        const now = nowIso();
        const id = createUlid();
        const localNo = this.nextNumber("milestone");
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
             ) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', 1, ?, 0, ?, ?)`,
          )
          .run(
            id,
            localNo,
            input.objectiveId,
            input.title,
            input.description ?? "",
            input.targetDate ?? null,
            sortKey,
            now,
            now,
          );
        const sequence = this.appendEvent("milestone.created", actor, "MILESTONE", id, {
          localNo,
          title: input.title,
        });
        return { id, localNo, title: input.title, status: "ACTIVE", version: 0, sequence };
      },
    });
  }

  private rowForTaskKey(taskKey: string): any {
    const prefix = `${this.meta.code}-T-`;
    const suffix = taskKey.startsWith(prefix) ? taskKey.slice(prefix.length) : "";
    const localNo = /^\d+$/u.test(suffix) ? Number(suffix) : Number.NaN;
    if (!Number.isSafeInteger(localNo))
      throw new AtmError("WORK_ITEM_NOT_FOUND", {
        message: `WorkItem 不存在：${taskKey}`,
        details: { entity: "WORK_ITEM", reference: taskKey },
      });
    const row = this.#sqlite.prepare("SELECT * FROM work_items WHERE local_no = ?").get(localNo);
    if (!row)
      throw new AtmError("WORK_ITEM_NOT_FOUND", {
        message: `WorkItem 不存在：${taskKey}`,
        details: { entity: "WORK_ITEM", reference: taskKey },
      });
    return row;
  }

  private progressBreakdownForRow(row: any): WorkItemProgressBreakdown {
    type Denominator = {
      done_weight: number;
      total_weight: number;
      done_stages: number;
      total_stages: number;
    };
    const children = this.#sqlite
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN status = 'DONE' THEN weight ELSE 0 END), 0) AS done_weight,
           COALESCE(SUM(weight), 0) AS total_weight,
           SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) AS done_stages,
           COUNT(*) AS total_stages
         FROM work_items
         WHERE parent_id = ? AND archived_at IS NULL AND status <> 'CANCELLED'`,
      )
      .get(row.id) as Denominator;
    const checklist = this.#sqlite
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN status = 'DONE' THEN weight ELSE 0 END), 0) AS done_weight,
           COALESCE(SUM(weight), 0) AS total_weight,
           SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) AS done_stages,
           COUNT(*) AS total_stages
         FROM checklist_items
         WHERE work_item_id = ? AND status <> 'SKIPPED'`,
      )
      .get(row.id) as Denominator;
    const denominator = children.total_stages > 0 ? children : checklist;
    const activeBlocker = this.#sqlite
      .prepare(
        `SELECT COALESCE(NULLIF(detail, ''), NULLIF(waiting_for, ''), title) AS reason
         FROM blockers WHERE work_item_id = ? AND status = 'ACTIVE'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(row.id) as { reason: string } | undefined;
    return {
      computed: Number(row.computed_progress),
      reported: row.reported_progress === null ? null : Number(row.reported_progress),
      source: String(row.progress_source),
      doneWeight: Number(denominator.done_weight),
      totalWeight: Number(denominator.total_weight),
      doneStages: Number(denominator.done_stages),
      totalStages: Number(denominator.total_stages),
      blocker: row.blocked_reason ?? activeBlocker?.reason ?? null,
    };
  }

  private workItemViewFromRow(row: any): WorkItemView {
    return workItemFromRow(
      {
        ...row,
        parent_key: row.parent_id ? this.taskKeyForId(row.parent_id) : null,
        duplicate_of_key: row.duplicate_of_id ? this.taskKeyForId(row.duplicate_of_id) : null,
        superseded_by_key: row.superseded_by_id ? this.taskKeyForId(row.superseded_by_id) : null,
      },
      this.meta.code,
      this.progressBreakdownForRow(row),
    );
  }

  private taskKeyForId(workItemId: string): string | null {
    const row = this.#sqlite
      .prepare("SELECT local_no FROM work_items WHERE id = ?")
      .get(workItemId) as { local_no: number } | undefined;
    return row ? `${this.meta.code}-T-${String(row.local_no).padStart(4, "0")}` : null;
  }

  private recordWorkItemLifecycleAt(workItemId: string, at: string, started: boolean): void {
    if (started) {
      this.#sqlite
        .prepare(
          `UPDATE work_items
           SET ever_claimed_at = COALESCE(ever_claimed_at, ?),
               last_started_at = CASE
                 WHEN last_started_at IS NULL OR last_started_at < ? THEN ?
                 ELSE last_started_at
               END
           WHERE id = ?`,
        )
        .run(at, at, at, workItemId);
      return;
    }
    this.#sqlite
      .prepare("UPDATE work_items SET ever_claimed_at = COALESCE(ever_claimed_at, ?) WHERE id = ?")
      .run(at, workItemId);
  }

  private advanceWorkItemEvidenceAt(workItemId: string, at: string): void {
    this.#sqlite
      .prepare(
        `UPDATE work_items
         SET last_evidence_at = CASE
           WHEN last_evidence_at IS NULL OR last_evidence_at < ? THEN ?
           ELSE last_evidence_at
         END
         WHERE id = ?`,
      )
      .run(at, at, workItemId);
  }

  private recordSessionClosedAtForHandledWorkItems(sessionId: string, closedAt: string): void {
    if (this.database.schemaVersion < 15) return;
    this.#sqlite
      .prepare(
        `UPDATE work_items
         SET last_session_closed_at = CASE
           WHEN last_session_closed_at IS NULL OR last_session_closed_at < ? THEN ?
           ELSE last_session_closed_at
         END
         WHERE id IN (
           SELECT event.aggregate_id
           FROM events AS event INDEXED BY idx_events_work_session_lifecycle
           WHERE event.session_id = ?
             AND event.aggregate_type = 'WORK_ITEM'
             AND event.type IN ('work.claimed', 'work.started')
           GROUP BY event.aggregate_id
         )`,
      )
      .run(closedAt, closedAt, sessionId);
  }

  private normalizeEvidence(evidence: unknown[], strictTyped = false): unknown[] {
    return evidence.map((entry) => {
      let reference: Record<string, unknown>;
      if (strictTyped) {
        const parsed = EvidenceInputSchema.parse(entry);
        if (typeof parsed === "string") return parsed;
        reference = parsed;
      } else {
        if (typeof entry === "string") return entry;
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
        reference = entry as Record<string, unknown>;
      }
      if (reference.kind !== "atm_record" && reference.kind !== "atm_task") {
        return strictTyped ? reference : entry;
      }
      if (typeof reference.value !== "string" || !reference.value.trim()) {
        throw new AtmError("VALIDATION_ERROR", {
          message: `${String(reference.kind)} evidence value required`,
        });
      }
      if (reference.kind === "atm_record") {
        const normalized = reference.value.trim();
        const publicPrefix = `${this.meta.code}-`;
        const publicSuffix = normalized.startsWith(publicPrefix)
          ? normalized.slice(publicPrefix.length)
          : "";
        if (!/^(?:D|R)-\d{3,}$/u.test(publicSuffix)) {
          throw new AtmError("RECORD_NOT_FOUND", {
            message: `Record 不存在：${reference.value}`,
            details: { entity: "RECORD", reference: reference.value },
          });
        }
        return { ...reference, value: this.getRecord(normalized).key };
      }
      const row = this.rowForTaskKey(reference.value);
      const taskKey = this.taskKeyForId(row.id);
      if (!taskKey)
        throw new AtmError("WORK_ITEM_NOT_FOUND", {
          message: `WorkItem 不存在：${reference.value}`,
          details: { entity: "WORK_ITEM", reference: reference.value },
        });
      return { ...reference, value: taskKey };
    });
  }

  getWorkItem(taskKey: string): WorkItemView & {
    checklist: ChecklistView[];
    dependencies: string[];
    discoveredFrom: string | null;
    discovered: string[];
    executionSession: Record<string, unknown> | null;
  } {
    const row = this.rowForTaskKey(taskKey);
    const code = this.meta.code;
    const checklist = (
      this.#sqlite
        .prepare("SELECT * FROM checklist_items WHERE work_item_id = ? ORDER BY created_at")
        .all(row.id) as any[]
    ).map((item) => ({
      id: item.id,
      title: item.title,
      kind: item.kind,
      status: item.status,
      weight: item.weight,
      evidenceRequired: Number(item.evidence_required) === 1,
      evidence: json(item.evidence_json, []),
      version: item.version,
    }));
    const dependencies = (
      this.#sqlite
        .prepare(
          `SELECT source.local_no FROM work_item_relations relation
           JOIN work_items source ON source.id = relation.source_id
           WHERE relation.target_id = ? AND relation.relation_type = 'BLOCKS'`,
        )
        .all(row.id) as Array<{ local_no: number }>
    ).map((dependency) => `${code}-T-${String(dependency.local_no).padStart(4, "0")}`);
    const discoveredFromRow = this.#sqlite
      .prepare(
        `SELECT target.local_no FROM work_item_relations relation
         JOIN work_items target ON target.id = relation.target_id
         WHERE relation.source_id = ? AND relation.relation_type = 'DISCOVERED_FROM'
         ORDER BY relation.created_at LIMIT 1`,
      )
      .get(row.id) as { local_no: number } | undefined;
    const discovered = (
      this.#sqlite
        .prepare(
          `SELECT source.local_no FROM work_item_relations relation
           JOIN work_items source ON source.id = relation.source_id
           WHERE relation.target_id = ? AND relation.relation_type = 'DISCOVERED_FROM'
           ORDER BY relation.created_at, source.local_no`,
        )
        .all(row.id) as Array<{ local_no: number }>
    ).map((entry) => `${code}-T-${String(entry.local_no).padStart(4, "0")}`);
    const discoveredFrom = discoveredFromRow
      ? `${code}-T-${String(discoveredFromRow.local_no).padStart(4, "0")}`
      : null;
    const executionSession = row.claimed_by_session_id
      ? ((this.#sqlite
          .prepare(
            `SELECT session.id, session.agent_id, agent.display_name, session.role,
                    session.connection_state, session.work_state, session.cwd,
                    session.git_branch, session.git_head, session.git_repo_root,
                    session.worktree_root, session.git_is_linked_worktree,
                    session.git_detached, session.git_dirty, session.git_available, session.git_error
             FROM agent_sessions session
             JOIN agents agent ON agent.id = session.agent_id
             WHERE session.id = ?`,
          )
          .get(row.claimed_by_session_id) as Record<string, unknown> | undefined) ?? null)
      : null;
    return {
      ...this.workItemViewFromRow(row),
      checklist,
      dependencies,
      discoveredFrom,
      discovered,
      executionSession,
    };
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

  private taskViewFilter(filters: WorkItemListFilters): {
    clauses: string[];
    params: unknown[];
    selection: TaskListSelection;
  } {
    const clauses = ["archived_at IS NULL"];
    const params: unknown[] = [];
    const parentIds: string[] = [];
    if (filters.parentId) parentIds.push(filters.parentId);
    if (filters.parentKey) parentIds.push(this.rowForTaskKey(filters.parentKey).id);
    const selection = canonicalTaskListSelection({
      status: filters.status ?? null,
      owner: filters.assigneeAgentId ?? null,
      parent: [...new Set(parentIds)].sort().join("\u0000") || null,
      milestone: filters.milestoneId ?? null,
      ready: filters.readyOnly === true,
      query: filters.query ?? null,
    });
    if (selection.status) {
      clauses.push("status = ?");
      params.push(selection.status);
    }
    if (selection.owner) {
      clauses.push("assignee_agent_id = ?");
      params.push(selection.owner);
    }
    for (const parentId of parentIds) {
      clauses.push("parent_id = ?");
      params.push(parentId);
    }
    if (selection.milestone) {
      clauses.push("milestone_id = ?");
      params.push(selection.milestone);
    }
    if (selection.query) {
      clauses.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
      const escaped = selection.query.replace(/[\\%_]/gu, "\\$&");
      params.push(`%${escaped}%`, `%${escaped}%`);
    }
    if (selection.ready) {
      clauses.push(
        `status = 'READY' AND NOT EXISTS (
          SELECT 1 FROM work_item_relations relation
          JOIN work_items dependency ON dependency.id = relation.source_id
          WHERE relation.target_id = work_items.id AND relation.relation_type = 'BLOCKS'
            AND dependency.status <> 'DONE'
        )`,
      );
    }
    return { clauses, params, selection };
  }

  listTaskViewPage(
    filters: WorkItemPageFilters = {},
    view: TaskViewName = "core",
  ): TaskViewProjectionPage {
    const { clauses, params, selection } = this.taskViewFilter(filters);
    const project = this.meta.code;
    const decoded = filters.cursor
      ? decodeTaskListCursor(filters.cursor, { project, selection })
      : { last: null };
    if (decoded.last) {
      clauses.push(
        `(CASE priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1
           WHEN 'NORMAL' THEN 2 ELSE 3 END, sort_key, created_at, local_no) > (?, ?, ?, ?)`,
      );
      params.push(
        decoded.last.priorityRank,
        decoded.last.sortKey,
        decoded.last.createdAt,
        decoded.last.localNo,
      );
    }
    const limit = Math.min(100, Math.max(1, filters.limit ?? 20));
    params.push(limit + 1);
    const rows = this.#sqlite
      .prepare(
        taskViewProjectionSql({
          whereSql: clauses.join(" AND "),
          selectionTailSql: `ORDER BY CASE priority
            WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1
            WHEN 'NORMAL' THEN 2 ELSE 3 END,
            sort_key, created_at, local_no LIMIT ?`,
          view,
        }),
      )
      .all(...params) as TaskViewProjectionRow[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const itemCursors = items.map((row) =>
      encodeTaskListCursor({
        project,
        selection,
        last: {
          priorityRank: Number(row.priorityRank),
          sortKey: Number(row.sortKey),
          createdAt: row.createdAt,
          localNo: Number(row.localNo),
        },
      }),
    );
    const startCursor = encodeTaskListCursor({ project, selection, last: null });
    return {
      items,
      itemCursors,
      nextCursor: hasMore ? itemCursors.at(-1)! : null,
      retryCursor: filters.cursor ?? startCursor,
      hasMore,
    };
  }

  listTaskViewRows(
    filters: WorkItemListFilters = {},
    view: TaskViewName = "core",
  ): TaskViewProjectionRow[] {
    const { clauses, params } = this.taskViewFilter(filters);
    params.push(Math.min(100, Math.max(1, filters.limit ?? 20)), Math.max(0, filters.offset ?? 0));
    return this.#sqlite
      .prepare(
        taskViewProjectionSql({
          whereSql: clauses.join(" AND "),
          selectionTailSql: `ORDER BY CASE priority
            WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1
            WHEN 'NORMAL' THEN 2 ELSE 3 END,
            sort_key, created_at, local_no LIMIT ? OFFSET ?`,
          view,
        }),
      )
      .all(...params) as TaskViewProjectionRow[];
  }

  getTaskViewRow(taskKey: string, view: TaskViewName = "core"): TaskViewProjectionRow {
    const code = this.meta.code;
    const prefix = `${code}-T-`;
    const suffix = taskKey.startsWith(prefix) ? taskKey.slice(prefix.length) : "";
    const localNo = /^\d+$/u.test(suffix) ? Number(suffix) : Number.NaN;
    if (!Number.isSafeInteger(localNo))
      throw new AtmError("WORK_ITEM_NOT_FOUND", {
        message: `WorkItem 不存在：${taskKey}`,
        details: { entity: "WORK_ITEM", reference: taskKey },
      });
    const row = this.#sqlite
      .prepare(
        taskViewProjectionSql({
          whereSql: "archived_at IS NULL AND local_no = ?",
          selectionTailSql: "",
          view,
        }),
      )
      .get(localNo) as TaskViewProjectionRow | undefined;
    if (!row)
      throw new AtmError("WORK_ITEM_NOT_FOUND", {
        message: `WorkItem 不存在：${taskKey}`,
        details: { entity: "WORK_ITEM", reference: taskKey },
      });
    return row;
  }

  listWorkItems(filters: WorkItemListFilters = {}): WorkItemView[] {
    const clauses = ["archived_at IS NULL"];
    const params: unknown[] = [];
    if (filters.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }
    if (filters.assigneeAgentId) {
      clauses.push("assignee_agent_id = ?");
      params.push(filters.assigneeAgentId);
    }
    if (filters.parentId) {
      clauses.push("parent_id = ?");
      params.push(filters.parentId);
    }
    if (filters.parentKey) {
      clauses.push("parent_id = ?");
      params.push(this.rowForTaskKey(filters.parentKey).id);
    }
    if (filters.milestoneId) {
      clauses.push("milestone_id = ?");
      params.push(filters.milestoneId);
    }
    if (filters.query) {
      clauses.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
      const escaped = filters.query.replace(/[\\%_]/gu, "\\$&");
      params.push(`%${escaped}%`, `%${escaped}%`);
    }
    if (filters.readyOnly) {
      clauses.push(
        `status = 'READY' AND NOT EXISTS (
          SELECT 1 FROM work_item_relations relation
          JOIN work_items dependency ON dependency.id = relation.source_id
          WHERE relation.target_id = work_items.id AND relation.relation_type = 'BLOCKS'
            AND dependency.status <> 'DONE'
        )`,
      );
    }
    params.push(Math.min(100, Math.max(1, filters.limit ?? 20)), Math.max(0, filters.offset ?? 0));
    const rows = this.#sqlite
      .prepare(
        `SELECT * FROM work_items WHERE ${clauses.join(" AND ")}
         ORDER BY CASE priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END,
           sort_key, created_at LIMIT ? OFFSET ?`,
      )
      .all(...params) as any[];
    const relationStatement = this.#sqlite.prepare(
      `SELECT
         (SELECT target.local_no FROM work_item_relations relation
          JOIN work_items target ON target.id = relation.target_id
          WHERE relation.source_id = work_items.id
            AND relation.relation_type = 'DISCOVERED_FROM' LIMIT 1) AS discovered_from_local_no,
         (SELECT COUNT(*) FROM work_item_relations relation
          WHERE relation.target_id = work_items.id
            AND relation.relation_type = 'DISCOVERED_FROM') AS discovered_count
       FROM work_items WHERE id = ?`,
    );
    return rows.map((row) =>
      this.workItemViewFromRow({ ...row, ...(relationStatement.get(row.id) as object) }),
    );
  }

  workItemSuggestionCandidates(
    reference: string,
    limit = 50,
  ): { total: number; candidates: Array<{ key: string; status: string }> } {
    const totalRow = this.#sqlite
      .prepare("SELECT COUNT(*) AS count FROM work_items WHERE archived_at IS NULL")
      .get() as { count: number };
    const boundedLimit = Math.min(100, Math.max(1, limit));
    const normalized = reference.trim().toUpperCase();
    const prefix = `${this.meta.code}-T-`;
    const suffix = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
    const digits = suffix.match(/\d+/gu)?.join("") ?? "";
    const approximateLocalNo = digits.length > 0 ? Number(digits) : null;
    const safeLocalNo =
      approximateLocalNo !== null && Number.isSafeInteger(approximateLocalNo)
        ? approximateLocalNo
        : null;
    const rows = (
      safeLocalNo === null
        ? this.#sqlite
            .prepare(
              `SELECT local_no, status FROM work_items WHERE archived_at IS NULL
             ORDER BY local_no LIMIT ?`,
            )
            .all(boundedLimit)
        : this.#sqlite
            .prepare(
              `SELECT local_no, status FROM work_items WHERE archived_at IS NULL
             ORDER BY ABS(local_no - ?), local_no LIMIT ?`,
            )
            .all(safeLocalNo, boundedLimit)
    ) as Array<{ local_no: number; status: string }>;
    const code = this.meta.code;
    return {
      total: Number(totalRow.count),
      candidates: rows.map((row) => ({
        key: `${code}-T-${String(row.local_no).padStart(4, "0")}`,
        status: row.status,
      })),
    };
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
    return this.mutate({
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
        const code = this.meta.code;
        const activeObjective = planningRoot ? this.getActiveObjective() : null;
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
          ? this.getActiveMilestone(defaultObjectiveId)
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
          input: WorkItemCreateInput;
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
            itemMilestoneId = this.getActiveMilestone(itemObjectiveId)?.id ?? null;
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
          const row = this.rowForTaskKey(taskKey);
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
          const localNo = this.nextNumber("objective");
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
          this.appendEvent("objective.created", actor, "OBJECTIVE", plannedObjective.id, {
            localNo,
            title: planningRoot!.objectiveTitle,
          });
          planningRootProvisioned = true;
        }
        if (plannedMilestone) {
          const now = nowIso();
          const localNo = this.nextNumber("milestone");
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
          this.appendEvent("milestone.created", actor, "MILESTONE", plannedMilestone.id, {
            localNo,
            title: planningRoot!.milestoneTitle,
          });
        }

        const references = new Map<string, { id: string; key: string }>();
        for (const item of items) {
          const entry = plannedByRef.get(item.clientRef)!;
          const localNo = this.nextNumber("work_item");
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
          this.upsertSearchDocument(
            "WORK_ITEM",
            entry.id,
            reference.key,
            entry.input.title,
            entry.input.description ?? "",
          );
          this.recomputeWorkItem(entry.id);
          if (entry.discoveredFromId) this.refreshWorkItemSearchDocument(entry.discoveredFromId);
        }

        let sequence = this.meta.sequence;
        for (const entry of planned) {
          const reference = references.get(entry.input.clientRef)!;
          const discoveredFromKey = entry.input.discoveredFromRef
            ? references.get(entry.input.discoveredFromRef)?.key
            : entry.discoveredFromKey;
          sequence = this.appendEvent("work.created", actor, "WORK_ITEM", entry.id, {
            key: reference.key,
            title: entry.input.title,
            status: entry.status,
            ...(discoveredFromKey ? { discoveredFrom: discoveredFromKey } : {}),
          });
        }

        return {
          items: planned.map((entry) =>
            this.workItemViewFromRow(
              this.#sqlite.prepare("SELECT * FROM work_items WHERE id = ?").get(entry.id),
            ),
          ),
          sequence,
          planningRootProvisioned,
        };
      },
    });
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
    if (patches.length === 0 || patches.length > 50)
      throw new AtmError("VALIDATION_ERROR", {
        message: "WorkItem patch 批次数量必须为 1 至 50",
        details: { field: "patches", min: 1, max: 50, actual: patches.length },
      });
    return this.mutate({
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
        let sequence = this.meta.sequence;
        for (const patch of patches) {
          const row = this.rowForTaskKey(patch.taskKey);
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
              acceptance: json<string[]>(row.acceptance_json, []),
              targetDate: (row.target_date ?? null) as string | null,
              parentKey: row.parent_id ? this.taskKeyForId(row.parent_id) : null,
            };
            const expectedFields = patch.expectedFields;
            const safeMerge =
              patch.operation === "edit" &&
              patch.assigneeAgentId === undefined &&
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
          const acceptanceChange =
            patch.operation === "edit" && patch.acceptance !== undefined
              ? {
                  acceptance: {
                    before: json<string[]>(row.acceptance_json, []),
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
              this.resolveActiveBlockers(row.id, now);
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
            const duplicateOf = patch.duplicateOf ? this.rowForTaskKey(patch.duplicateOf) : null;
            const supersededBy = patch.supersededBy ? this.rowForTaskKey(patch.supersededBy) : null;
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
            this.resolveActiveBlockers(row.id, now);
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
              const parentId = patch.parentKey ? this.rowForTaskKey(patch.parentKey).id : null;
              const parents = new Map(
                (this.#sqlite.prepare("SELECT id, parent_id FROM work_items").all() as any[]).map(
                  (candidate) => [candidate.id, candidate.parent_id],
                ),
              );
              assertParentMove(row.id, parentId, parents);
              updates.push("parent_id = ?");
              values.push(parentId);
              eventType = "work.moved";
            }
          } else {
            throw new AtmError("VALIDATION_ERROR", {
              message: `未知 WorkItem 操作：${patch.operation}`,
              details: { field: "operation", value: patch.operation, issue: "unknown" },
            });
          }
          if (updates.length === 0)
            throw new AtmError("VALIDATION_ERROR", {
              message: "WorkItem patch 未产生任何变更",
              details: { task_key: patch.taskKey, issue: "empty_patch" },
            });
          updates.push("version = version + 1", "updated_at = ?");
          values.push(now, row.id);
          this.#sqlite
            .prepare(`UPDATE work_items SET ${updates.join(", ")} WHERE id = ?`)
            .run(...values);
          if (patch.operation === "claim" || patch.operation === "start") {
            this.recordWorkItemLifecycleAt(row.id, now, targetStatus === "IN_PROGRESS");
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
            this.upsertSearchDocument(
              "WORK_ITEM",
              row.id,
              patch.taskKey,
              searchRow.title,
              searchRow.description,
            );
          }
          sequence = this.appendEvent(eventType, actor, "WORK_ITEM", row.id, {
            key: patch.taskKey,
            title: row.title,
            operation: patch.operation,
            status: targetStatus,
            phase: targetPhase,
            ...(mergeReceipt === undefined ? {} : { mergedAcrossVersion: mergeReceipt }),
            ...(acceptanceChange === undefined ? {} : { changes: acceptanceChange }),
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
          if (row.parent_id) this.recomputeWorkItem(row.parent_id);
          const updated = this.#sqlite.prepare("SELECT * FROM work_items WHERE id = ?").get(row.id);
          result.push(this.workItemViewFromRow(updated));
        }
        return { items: result, sequence, ...(merges.length === 0 ? {} : { merges }) };
      },
    });
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
    return this.mutate({
      actor,
      opId,
      operation: "work.verify-and-complete",
      request: input,
      immediate: true,
      action: () => {
        const initial = this.rowForTaskKey(input.taskKey);
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
        let sequence = this.meta.sequence;
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
          sequence = this.appendEvent(
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
        sequence = this.appendEvent("work.completed", actor, "WORK_ITEM", initial.id, {
          key: input.taskKey,
          title: initial.title,
          operation: "verify_and_complete",
          status: "DONE",
          phase: "DONE",
          composite: true,
          ...(verificationSequence === null ? {} : { verificationSequence }),
        });
        transitions.push("DONE");
        if (initial.parent_id) this.recomputeWorkItem(initial.parent_id);
        const updated = this.#sqlite
          .prepare("SELECT * FROM work_items WHERE id = ?")
          .get(initial.id);
        const item = this.workItemViewFromRow(updated);
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

  // blockers 是独立记录，work_items.blocked_reason 只是它在任务行上的影子。
  // 表结构里 status 允许 RESOLVED/CANCELLED、还有 resolved_at 和 version，
  // 说明它本就是照「可关闭」设计的；但在此之前全仓库只有一处 INSERT（progress
  // 带 blocker）和一处闸门 SELECT，没有任何路径能把它置成非 ACTIVE。于是任务
  // 只要被带 blocker 的 progress 写过一次，就永远过不了完成闸门（blocker active），
  // 而且清掉 blocked_reason 之后界面上看不出任何异常。
  resolveActiveBlockers(workItemId: string, now: string): number {
    return this.#sqlite
      .prepare(
        `UPDATE blockers SET status = ?, resolved_at = ?, updated_at = ?, version = version + 1
         WHERE work_item_id = ? AND status = 'ACTIVE'`,
      )
      .run("RESOLVED", now, now, workItemId).changes;
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
    const normalizedInput = {
      ...input,
      ...(input.evidence === undefined ? {} : { evidence: this.normalizeEvidence(input.evidence) }),
    };
    return this.mutate({
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
        const evidence = normalizedInput.evidence ?? json(row.evidence_json, []);
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
          this.advanceWorkItemEvidenceAt(row.work_item_id, now);
        }
        const taskProgress = this.recomputeWorkItem(row.work_item_id);
        const task = this.#sqlite
          .prepare("SELECT version FROM work_items WHERE id = ?")
          .get(row.work_item_id) as {
          version: number;
        };
        const sequence = this.appendEvent("checklist.updated", actor, "CHECKLIST", row.id, {
          workItemId: row.work_item_id,
          taskKey: this.taskKeyForId(row.work_item_id),
          status: input.status,
        });
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
            evidence: json(updated.evidence_json, []),
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
        ...(item.evidence === undefined ? {} : { evidence: this.normalizeEvidence(item.evidence) }),
      })),
    };
    return this.mutate({
      actor,
      opId,
      operation: "checklist.update.batch",
      request: normalizedInput,
      immediate: true,
      action: () => {
        const task = this.rowForTaskKey(input.taskKey);
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
          const evidence = item.evidence ?? json(row.evidence_json, []);
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
          this.advanceWorkItemEvidenceAt(task.id, now);
        }
        const taskProgress = this.recomputeWorkItem(task.id);
        const updatedTask = this.#sqlite
          .prepare("SELECT version FROM work_items WHERE id = ?")
          .get(task.id) as { version: number };
        const sequence = this.appendEvent("checklist.batch_updated", actor, "WORK_ITEM", task.id, {
          key: input.taskKey,
          taskKey: input.taskKey,
          expectedVersion: input.expectedVersion,
          taskVersion: updatedTask.version,
          items: rows.map(({ row, item }) => ({ checklistId: row.id, status: item.status })),
        });
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
            evidence: json(updated.evidence_json, []),
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

  private recomputeWorkItem(id: string): number {
    const row = this.#sqlite.prepare("SELECT * FROM work_items WHERE id = ?").get(id) as any;
    if (!row) return 0;
    const children = this.#sqlite
      .prepare(
        "SELECT computed_progress, weight, status FROM work_items WHERE parent_id = ? AND archived_at IS NULL",
      )
      .all(id) as any[];
    const checklist = this.#sqlite
      .prepare("SELECT status, weight FROM checklist_items WHERE work_item_id = ?")
      .all(id) as any[];
    const progress = computeProgress({
      status: row.status,
      children: children.map((child) => ({
        progress: child.computed_progress,
        weight: child.weight,
        cancelled: child.status === "CANCELLED",
      })),
      checklist: checklist
        .filter((item) => item.status !== "SKIPPED")
        .map((item) => ({ done: item.status === "DONE", weight: item.weight })),
      reported: row.reported_progress,
    });
    this.#sqlite
      .prepare(
        `UPDATE work_items SET computed_progress = ?, progress_source = ?,
         version = version + 1, updated_at = ? WHERE id = ?`,
      )
      .run(progress.value, progress.source, nowIso(), id);
    if (row.parent_id) this.recomputeWorkItem(row.parent_id);
    return progress.value;
  }

  private upsertSearchDocument(
    entityType: string,
    entityId: string,
    entityKey: string,
    title: string,
    body: string,
  ): void {
    const now = nowIso();
    this.#sqlite
      .prepare(
        `INSERT INTO search_documents(entity_type, entity_id, entity_key, title, body, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(entity_type, entity_id) DO UPDATE SET entity_key = excluded.entity_key,
           title = excluded.title, body = excluded.body, updated_at = excluded.updated_at`,
      )
      .run(entityType, entityId, entityKey, title, body, now);
    this.#sqlite
      .prepare("DELETE FROM search_documents_fts WHERE entity_type = ? AND entity_id = ?")
      .run(entityType, entityId);
    this.#sqlite
      .prepare(
        "INSERT INTO search_documents_fts(entity_type, entity_id, entity_key, title, body) VALUES (?, ?, ?, ?, ?)",
      )
      .run(entityType, entityId, entityKey, title, body);
  }

  private refreshWorkItemSearchDocument(workItemId: string): void {
    const row = this.#sqlite
      .prepare("SELECT * FROM work_items WHERE id = ?")
      .get(workItemId) as any;
    if (!row) return;
    const code = this.meta.code;
    const relationRows = this.#sqlite
      .prepare(
        `SELECT relation.source_id, source.local_no AS source_local_no, source.title AS source_title,
                relation.target_id, target.local_no AS target_local_no, target.title AS target_title
         FROM work_item_relations relation
         JOIN work_items source ON source.id = relation.source_id
         JOIN work_items target ON target.id = relation.target_id
         WHERE relation.relation_type = 'DISCOVERED_FROM'
           AND (relation.source_id = ? OR relation.target_id = ?)
         ORDER BY relation.created_at`,
      )
      .all(workItemId, workItemId) as Array<{
      source_id: string;
      source_local_no: number;
      source_title: string;
      target_id: string;
      target_local_no: number;
      target_title: string;
    }>;
    const relationText = relationRows.map((relation) => {
      if (relation.source_id === workItemId) {
        return `工作中发现于 ${code}-T-${String(relation.target_local_no).padStart(4, "0")} ${relation.target_title}`;
      }
      return `工作中发现 ${code}-T-${String(relation.source_local_no).padStart(4, "0")} ${relation.source_title}`;
    });
    this.upsertSearchDocument(
      "WORK_ITEM",
      row.id,
      `${code}-T-${String(row.local_no).padStart(4, "0")}`,
      row.title,
      [row.description, ...relationText].filter(Boolean).join("\n"),
    );
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
    const normalizedInput = {
      ...input,
      ...(input.evidence === undefined ? {} : { evidence: this.normalizeEvidence(input.evidence) }),
    };
    return this.mutate({
      actor,
      opId,
      operation: "work.progress",
      request: normalizedInput,
      action: () => {
        const row = this.rowForTaskKey(normalizedInput.taskKey);
        if (normalizedInput.blocker?.trim()) resolveStoredWorkItemOperation("block", row);
        const bucket =
          normalizedInput.percent === undefined
            ? null
            : Math.round(Math.max(0, Math.min(100, normalizedInput.percent)) / 10) * 10;
        const hash = createHash("sha256").update(normalizedInput.summary.trim()).digest("hex");
        const last = this.#sqlite
          .prepare(
            `SELECT id, progress_bucket, summary_hash FROM progress_updates
             WHERE work_item_id = ? ORDER BY created_at DESC LIMIT 1`,
          )
          .get(row.id) as
          | { id: string; progress_bucket: number | null; summary_hash: string }
          | undefined;
        if (
          last &&
          last.progress_bucket === bucket &&
          last.summary_hash === hash &&
          !normalizedInput.evidence?.length &&
          !normalizedInput.blocker
        ) {
          return {
            ok: 1,
            noop: true,
            seq: this.meta.sequence,
            key: normalizedInput.taskKey,
            v: row.version,
            opId,
            progressId: last.id,
          };
        }
        const now = nowIso();
        const progressId = createUlid();
        this.#sqlite
          .prepare(
            `INSERT INTO progress_updates(
               id, work_item_id, percent, progress_bucket, summary, summary_hash,
               completed_json, next_json, blocker_text, actor, session_id, created_at,
               evidence_json, op_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            progressId,
            row.id,
            normalizedInput.percent ?? null,
            bucket,
            normalizedInput.summary.trim(),
            hash,
            JSON.stringify(normalizedInput.completed ?? []),
            JSON.stringify(normalizedInput.next ?? []),
            normalizedInput.blocker ?? null,
            actor.id,
            actor.sessionId,
            now,
            JSON.stringify(normalizedInput.evidence ?? []),
            opId,
          );
        const updates = ["reported_progress = ?", "version = version + 1", "updated_at = ?"];
        const values: unknown[] = [bucket, now];
        if (normalizedInput.blocker?.trim()) {
          updates.push(
            "status = 'BLOCKED'",
            "phase = 'BLOCKED'",
            "phase_inferred = 0",
            "waiting_on = NULL",
            "waiting_for = NULL",
            "blocked_reason = ?",
          );
          values.push(normalizedInput.blocker.trim());
          const blockerId = createUlid();
          this.#sqlite
            .prepare(
              `INSERT INTO blockers(
                 id, local_no, work_item_id, severity, title, detail, status, actor,
                 version, created_at, updated_at
               ) VALUES (?, ?, ?, 'HIGH', ?, ?, 'ACTIVE', ?, 0, ?, ?)`,
            )
            .run(
              blockerId,
              this.nextNumber("blocker"),
              row.id,
              normalizedInput.blocker.trim(),
              normalizedInput.blocker.trim(),
              actor.id,
              now,
              now,
            );
        }
        values.push(row.id);
        this.#sqlite
          .prepare(`UPDATE work_items SET ${updates.join(", ")} WHERE id = ?`)
          .run(...values);
        if (normalizedInput.evidence && normalizedInput.evidence.length > 0) {
          this.advanceWorkItemEvidenceAt(row.id, now);
        }
        this.recomputeWorkItem(row.id);
        const updated = this.#sqlite
          .prepare("SELECT version FROM work_items WHERE id = ?")
          .get(row.id) as {
          version: number;
        };
        const seq = this.appendEvent(
          normalizedInput.blocker ? "work.blocked" : "work.progressed",
          actor,
          "WORK_ITEM",
          row.id,
          {
            key: normalizedInput.taskKey,
            title: row.title,
            from: row.computed_progress,
            to: bucket,
            summary: normalizedInput.summary.trim(),
            evidence: normalizedInput.evidence ?? [],
          },
        );
        this.upsertSearchDocument(
          "PROGRESS",
          progressId,
          normalizedInput.taskKey,
          normalizedInput.summary.trim(),
          normalizedInput.summary.trim(),
        );
        return {
          ok: 1,
          seq,
          key: normalizedInput.taskKey,
          v: updated.version,
          opId,
          progressId,
        };
      },
    });
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
    if (!actor.sessionId)
      throw new AtmError("SESSION_REQUIRED", { message: "结束 Session 需要 sessionId" });
    const sessionId = actor.sessionId;
    return this.mutate({
      actor,
      opId,
      operation: "session.end",
      request: input,
      immediate: true,
      action: () => {
        const now = nowIso();
        const session = this.#sqlite
          .prepare("SELECT closed_at FROM agent_sessions WHERE id = ?")
          .get(sessionId) as { closed_at: string | null } | undefined;
        const closedAt = session?.closed_at ?? now;
        const claimed =
          input.outcome === "retired" || input.releaseClaims
            ? (this.#sqlite
                .prepare(
                  `SELECT id, local_no, status, version FROM work_items
                   WHERE claimed_by_session_id = ? ORDER BY local_no`,
                )
                .all(sessionId) as Array<{
                id: string;
                local_no: number;
                status: string;
                version: number;
              }>)
            : [];
        const handoffItems =
          input.outcome === "retired"
            ? claimed.filter((task) => task.status !== "DONE" && task.status !== "CANCELLED")
            : [];
        for (const task of handoffItems) {
          this.#sqlite
            .prepare(
              `INSERT INTO handoffs(
                 id, work_item_id, from_session_id, to_agent_id, summary, next_action,
                 created_at, acknowledged_at, to_session_id, checkpoint_sequence
               ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
            )
            .run(
              createUlid(),
              task.id,
              sessionId,
              actor.id,
              input.summary,
              input.next?.[0] ?? "继续当前任务",
              now,
              this.meta.sequence,
            );
        }
        if (input.releaseClaims) {
          this.#sqlite
            .prepare(
              `UPDATE work_items SET status = CASE WHEN status = 'CLAIMED' THEN 'READY' ELSE status END,
               phase = CASE WHEN status = 'CLAIMED' THEN 'READY' ELSE phase END,
               phase_inferred = CASE WHEN status = 'CLAIMED' THEN 0 ELSE phase_inferred END,
               claimed_by_session_id = NULL, claim_lease_until = NULL,
               version = version + 1, updated_at = ? WHERE claimed_by_session_id = ?`,
            )
            .run(now, sessionId);
        }
        const releasedItems = input.releaseClaims
          ? claimed.map((task) => ({
              key: `${this.meta.code}-T-${String(task.local_no).padStart(4, "0")}`,
              version: task.version + 1,
            }))
          : [];
        this.#sqlite
          .prepare(
            `UPDATE agent_sessions SET connection_state = 'CLOSED', work_state = 'IDLE',
             heartbeat_at = ?, closed_at = COALESCE(closed_at, ?), updated_at = ?, retirement_reason = ?,
             close_reason = ?, version = version + 1 WHERE id = ?`,
          )
          .run(
            now,
            closedAt,
            now,
            input.outcome === "retired"
              ? input.retirementReason?.trim() || "context rotation"
              : null,
            input.outcome === "retired" ? "EXPLICIT_RETIRE" : "EXPLICIT_END",
            sessionId,
          );
        this.recordSessionClosedAtForHandledWorkItems(sessionId, closedAt);
        const seq = this.appendEvent("agent.left", actor, "SESSION", sessionId, {
          outcome: input.outcome,
          summary: input.summary,
          next: input.next ?? [],
        });
        return {
          ok: 1,
          seq,
          session: sessionId,
          handoffs: handoffItems.length,
          releasedItems,
        };
      },
    });
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
    const rows = this.#sqlite
      .prepare(
        `SELECT id, project_sequence, payload_json FROM outbox WHERE delivered_at IS NULL
         ORDER BY project_sequence LIMIT ?`,
      )
      .all(limit) as Array<{ id: string; project_sequence: number; payload_json: string }>;
    const eventStatement = this.#sqlite.prepare(
      `SELECT sequence, type, aggregate_type, aggregate_id, actor_type, actor_id,
              payload_json, created_at FROM events WHERE id = ?`,
    );
    return rows.map((row) => {
      const payload = json<{
        eventId?: string;
        type?: string;
        aggregateType?: string;
        aggregateId?: string;
      }>(row.payload_json, {});
      const eventId = typeof payload.eventId === "string" ? payload.eventId : null;
      const event = eventId
        ? (eventStatement.get(eventId) as
            | {
                sequence: number;
                type: string;
                aggregate_type: string;
                aggregate_id: string;
                actor_type: string;
                actor_id: string;
                payload_json: string;
                created_at: string;
              }
            | undefined)
        : undefined;
      return {
        id: row.id,
        project_sequence: row.project_sequence,
        eventId,
        eventType: event?.type ?? payload.type ?? "",
        aggregateType: event?.aggregate_type ?? payload.aggregateType ?? "",
        aggregateId: event?.aggregate_id ?? payload.aggregateId ?? "",
        actor: event?.actor_id ?? event?.actor_type ?? "SYSTEM",
        eventPayload: event ? json<Record<string, unknown>>(event.payload_json, {}) : {},
        eventSequence: event?.sequence ?? row.project_sequence,
        eventAt: event?.created_at ?? null,
      };
    });
  }

  markOutboxDelivered(ids: string[]): void {
    if (ids.length === 0) return;
    const statement = this.#sqlite.prepare(
      "UPDATE outbox SET delivered_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?",
    );
    const transaction = this.#sqlite.transaction(() => {
      const now = nowIso();
      for (const id of ids) statement.run(now, id);
    });
    transaction();
  }

  briefSnapshot(sessionId?: string | null): BriefSnapshot {
    const objective = this.#sqlite
      .prepare("SELECT * FROM objectives WHERE status = 'ACTIVE' ORDER BY updated_at DESC LIMIT 1")
      .get() as any;
    const milestone = this.#sqlite
      .prepare("SELECT * FROM milestones WHERE status = 'ACTIVE' ORDER BY sort_key LIMIT 1")
      .get() as any;
    const counts = this.#sqlite
      .prepare(
        `SELECT
           SUM(CASE WHEN status IN ('CLAIMED','IN_PROGRESS','VERIFYING') THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN status = 'BLOCKED' THEN 1 ELSE 0 END) AS blocked,
           SUM(CASE WHEN status = 'WAITING_USER' THEN 1 ELSE 0 END) AS waiting_user,
           SUM(CASE WHEN status = 'WAITING_AGENT' THEN 1 ELSE 0 END) AS waiting_agent
         FROM work_items WHERE archived_at IS NULL`,
      )
      .get() as any;
    const ready = this.listWorkItems({ readyOnly: true, limit: 3 }).map((task) => task.key);
    const own = sessionId
      ? this.#sqlite
          .prepare(
            `SELECT local_no FROM work_items WHERE claimed_by_session_id = ?
             AND status NOT IN ('DONE','CANCELLED') ORDER BY updated_at DESC LIMIT 5`,
          )
          .all(sessionId)
      : [];
    const code = this.meta.code;
    const session = sessionId
      ? (this.#sqlite.prepare("SELECT agent_id FROM agent_sessions WHERE id = ?").get(sessionId) as
          | { agent_id: string }
          | undefined)
      : undefined;
    const currentRow = sessionId
      ? (this.#sqlite
          .prepare(
            `SELECT * FROM work_items
             WHERE archived_at IS NULL AND status NOT IN ('DONE','CANCELLED')
               AND (claimed_by_session_id = ? OR assignee_agent_id = ?)
             ORDER BY CASE WHEN claimed_by_session_id = ? THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`,
          )
          .get(sessionId, session?.agent_id ?? "", sessionId) as any)
      : undefined;
    const current = currentRow
      ? this.getWorkItem(`${code}-T-${String(currentRow.local_no).padStart(4, "0")}`)
      : null;
    const handoff =
      currentRow && session
        ? (this.#sqlite
            .prepare(
              `SELECT summary, next_action, checkpoint_sequence
             FROM handoffs WHERE work_item_id = ?
               AND (to_session_id = ? OR (to_session_id IS NULL AND to_agent_id = ?))
             ORDER BY checkpoint_sequence DESC, created_at DESC LIMIT 1`,
            )
            .get(currentRow.id, sessionId ?? null, session.agent_id) as
            | { summary: string; next_action: string; checkpoint_sequence: number }
            | undefined)
        : undefined;
    const records = (
      this.#sqlite
        .prepare(
          `SELECT local_no, kind, summary, importance, source_type, source_actor_id,
                source_session_id, source_ref
         FROM records
         WHERE status = 'ACTIVE' AND (
           (kind = 'CONSTRAINT' AND source_type = 'USER') OR
           (kind IN ('DECISION','CONSTRAINT','FACT','RISK') AND importance IN ('HIGH','CRITICAL'))
         )
         ORDER BY CASE WHEN source_type = 'USER' AND kind = 'CONSTRAINT' THEN 0 ELSE 1 END,
                  CASE importance WHEN 'CRITICAL' THEN 0 ELSE 1 END,
                  updated_at DESC, local_no DESC LIMIT 8`,
        )
        .all() as Array<{
        local_no: number;
        kind: string;
        summary: string;
        importance: string;
        source_type: string;
        source_actor_id: string | null;
        source_session_id: string | null;
        source_ref: string | null;
      }>
    ).map(({ local_no, ...record }) => ({
      key: this.recordKey({ local_no, kind: record.kind }),
      ...record,
    }));
    const progress = currentRow
      ? (this.#sqlite
          .prepare(
            "SELECT summary FROM progress_updates WHERE work_item_id = ? ORDER BY created_at DESC LIMIT 1",
          )
          .get(currentRow.id) as { summary: string } | undefined)
      : undefined;
    const artifacts = currentRow
      ? (this.#sqlite
          .prepare(
            `SELECT name, COALESCE(local_path, external_ref) AS ref
             FROM artifacts WHERE work_item_id = ? ORDER BY created_at DESC LIMIT 3`,
          )
          .all(currentRow.id) as Array<{ name: string; ref: string | null }>)
      : [];
    const next = [
      ...new Set([...(handoff?.next_action ? [handoff.next_action] : []), ...ready]),
    ].slice(0, 3);
    return {
      truncated: false,
      project: code,
      seq: this.meta.sequence,
      objective: objective?.title ?? null,
      milestone: milestone?.title ?? null,
      active: Number(counts.active ?? 0),
      blocked: Number(counts.blocked ?? 0),
      waitingUser: Number(counts.waiting_user ?? 0),
      waitingAgent: Number(counts.waiting_agent ?? 0),
      own: (own as Array<{ local_no: number }>).map(
        (row) => `${code}-T-${String(row.local_no).padStart(4, "0")}`,
      ),
      next,
      records,
      currentTask: current
        ? {
            key: current.key,
            title: current.title,
            status: current.status,
            version: current.version,
            acceptance: current.acceptance,
            blockedReason: current.blockedReason,
            waitingFor: current.waitingFor,
            dependencies: current.dependencies,
            claim: current.claimedBySessionId
              ? { session: current.claimedBySessionId, leaseUntil: current.claimLeaseUntil }
              : null,
          }
        : null,
      handoff: handoff
        ? {
            summary: handoff.summary,
            nextAction: handoff.next_action,
            checkpointSequence: handoff.checkpoint_sequence,
          }
        : null,
      recentProgress: progress?.summary ?? null,
      artifacts,
    };
  }

  brief(sessionId?: string | null, maxChars = 1200): any {
    const snapshot = this.briefSnapshot(sessionId);
    const result: Record<string, any> = {
      ...snapshot,
      records: snapshot.records.map((record) => {
        const legacyRecord: Partial<BriefSnapshotRecord> = { ...record };
        delete legacyRecord.key;
        return legacyRecord;
      }),
    };
    const code = this.meta.code;
    const next = result.next as string[];
    const cap = Math.max(300, Math.min(5000, maxChars));
    if (JSON.stringify(result).length <= cap) return result;
    result.truncated = true;
    result.artifacts = [];
    result.recentProgress = null;
    while (result.records.length > 3 && JSON.stringify(result).length > cap) result.records.pop();
    if (result.currentTask && JSON.stringify(result).length > cap) {
      result.currentTask.acceptance = result.currentTask.acceptance.slice(0, 3);
    }
    if (result.handoff && JSON.stringify(result).length > cap)
      result.handoff.summary = String(result.handoff.summary).slice(0, 120);
    while (result.records.length > 1 && JSON.stringify(result).length > cap) result.records.pop();
    if (JSON.stringify(result).length <= cap) return result;
    return {
      truncated: true,
      project: code,
      seq: this.meta.sequence,
      currentTask: result.currentTask
        ? {
            key: result.currentTask.key,
            status: result.currentTask.status,
            version: result.currentTask.version,
            acceptance: result.currentTask.acceptance.slice(0, 2),
            blockedReason: result.currentTask.blockedReason,
            waitingFor: result.currentTask.waitingFor,
          }
        : null,
      next: next.slice(0, 2),
      records: result.records.slice(0, 1),
    };
  }
}
