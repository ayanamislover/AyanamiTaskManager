import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { assertParentMove, assertAcyclicDependency, computeProgress } from "@ayanami-task/domain";
import {
  assertWorkItemTransition,
  createUlid,
  EvidenceInputSchema,
  EvidenceReferenceSchema,
  legalWorkItemOperations,
  normalizeReviewCandidateHashes,
  nowIso,
  RecordSummarySchema,
  type WorkItemPhase,
  type WorkItemStatus,
  type WorkItemWaitingOn,
  type EvidenceInput,
} from "@ayanami-task/protocol";
import type { ManagedDatabase } from "./database.js";
import { presentEvent, type PresentedEvent } from "./event-presentation.js";

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

export type RecordView = {
  id: string;
  key: string;
  kind: string;
  title: string;
  summary: string;
  detail: string;
  importance: string;
  scope: string;
  workItemKey: string | null;
  supersedes: string | null;
  status: string;
  topic: string | null;
  subjectKey: string | null;
  relatedRecords: string[];
  opId: string | null;
  createdAt: string;
  updatedAt: string;
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
    if (!row) throw new Error("PROJECT_META_MISSING");
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
    if (!row) throw new Error(`COUNTER_NOT_FOUND: ${name}`);
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
          throw new Error(`IDEMPOTENCY_CONFLICT: ${key}`);
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
        if (!predecessor) throw new Error(`SESSION_NOT_FOUND: ${input.predecessorSessionId}`);
        if (predecessor.agent_id !== input.agentId)
          throw new Error("SESSION_SUCCESSOR_AGENT_MISMATCH");
        if (predecessor.connection_state !== "CLOSED" || !predecessor.retirement_reason) {
          throw new Error("SESSION_NOT_RETIRED");
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
      throw new Error("OPERATION_ID_INVALID");
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
    const row = this.#sqlite.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(id);
    if (!row) throw new Error(`SESSION_NOT_FOUND: ${id}`);
    return row;
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
    if (!normalizedOpId || normalizedOpId.length > 128) throw new Error("OPERATION_ID_INVALID");
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
          throw new Error(`IDEMPOTENCY_CONFLICT: ${candidate.id}:${normalizedOpId}`);
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
      throw new Error(`SESSION_CLOSED: ${sessionId}`);
    }
    const successors = this.#sqlite
      .prepare(
        `SELECT * FROM agent_sessions
         WHERE predecessor_session_id = ? AND connection_state = 'ONLINE'
         ORDER BY started_at DESC`,
      )
      .all(sessionId) as any[];
    if (successors.length > 1) throw new Error(`SESSION_SUCCESSOR_AMBIGUOUS: ${sessionId}`);
    let successor = successors[0];
    if (successor && !this.isMatchingRecoverySuccessor(requested, successor)) {
      throw new Error(`SESSION_SUCCESSOR_IDENTITY_MISMATCH: ${sessionId}`);
    }
    if (!successor && createRecoverySuccessor) {
      const agent = this.#sqlite
        .prepare("SELECT display_name, client_kind FROM agents WHERE id = ?")
        .get(requested.agent_id) as { display_name: string; client_kind: string } | undefined;
      if (!agent) throw new Error(`SESSION_SUCCESSOR_IDENTITY_MISMATCH: ${sessionId}`);
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
      throw new Error(`SESSION_CLOSED: ${sessionId}`);
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

  recoverStaleSessions(cutoffIso: string): number {
    return this.#sqlite.transaction(() => {
      const rows = this.#sqlite
        .prepare(
          `SELECT id, agent_id FROM agent_sessions
           WHERE connection_state = 'ONLINE' AND COALESCE(heartbeat_at, updated_at) < ?`,
        )
        .all(cutoffIso) as Array<{ id: string; agent_id: string }>;
      const now = nowIso();
      for (const row of rows) {
        this.#sqlite
          .prepare(
            `UPDATE agent_sessions SET connection_state = 'CLOSED', work_state = 'IDLE',
             closed_at = ?, updated_at = ?, retirement_reason = 'startup recovery: heartbeat expired',
             close_reason = 'HEARTBEAT_TIMEOUT', version = version + 1 WHERE id = ?`,
          )
          .run(now, now, row.id);
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
        .prepare("SELECT id, agent_id FROM agent_sessions WHERE id = ?")
        .get(sessionId) as { id: string; agent_id: string } | undefined;
      if (!session) throw new Error(`SESSION_NOT_FOUND: ${sessionId}`);
      const now = nowIso();
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
        .run(now, now, sessionId);
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

  listRecords(limit = 100): any[] {
    return (
      this.#sqlite
        .prepare(
          `SELECT id, local_no, kind, title, summary, detail, importance, scope, work_item_id,
                supersedes_id, status, source_type, source_actor_id,
                source_session_id, source_ref, topic, subject_key, op_id, created_at, updated_at
         FROM records ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(Math.min(200, Math.max(1, limit))) as any[]
    ).map((row) => ({
      ...row,
      key: this.recordKey(row),
      topic: row.topic ?? null,
      subjectKey: row.subject_key ?? null,
      opId: row.op_id ?? null,
      relatedRecords: this.relatedRecordKeys(row),
    }));
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
    if (!row) throw new Error(`RECORD_NOT_FOUND: ${reference}`);
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
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getOperationTrace(opId: string, sessionId?: string | null): any {
    const normalized = opId.trim();
    if (!normalized) throw new Error("OPERATION_ID_INVALID");
    const mutations = this.#sqlite
      .prepare(
        `SELECT operation, response_json, actor_session_id, created_at
         FROM idempotency_keys WHERE op_id = ? AND (? IS NULL OR actor_session_id = ?)
         ORDER BY created_at`,
      )
      .all(normalized, sessionId ?? null, sessionId ?? null)
      .map((row: any) => ({
        operation: row.operation,
        response: json(row.response_json, null),
        sessionId: row.actor_session_id,
        createdAt: row.created_at,
      }));
    const records = (
      this.#sqlite
        .prepare("SELECT id FROM records WHERE op_id = ? ORDER BY created_at")
        .all(normalized) as Array<{ id: string }>
    ).map((row) => this.getRecord(row.id));
    const progress = (
      this.#sqlite
        .prepare(
          `SELECT progress.*, item.local_no FROM progress_updates progress
           JOIN work_items item ON item.id = progress.work_item_id
           WHERE progress.op_id = ? ORDER BY progress.created_at`,
        )
        .all(normalized) as any[]
    ).map((row) => ({
      opId: row.op_id,
      taskKey: `${this.meta.code}-T-${String(row.local_no).padStart(4, "0")}`,
      percent: row.percent,
      summary: row.summary,
      completed: json(row.completed_json, []),
      next: json(row.next_json, []),
      evidence: json(row.evidence_json, []),
      blocker: row.blocker_text,
      sessionId: row.session_id,
      createdAt: row.created_at,
    }));
    const projectUpdates = (
      this.#sqlite
        .prepare("SELECT * FROM project_updates WHERE op_id = ? ORDER BY created_at")
        .all(normalized) as any[]
    ).map((row) => this.projectUpdateView(row));
    const events = (
      this.#sqlite
        .prepare(
          `SELECT sequence, type, aggregate_type, aggregate_id, actor_id, session_id,
                  payload_json, created_at, op_id
           FROM events WHERE op_id = ? ORDER BY sequence`,
        )
        .all(normalized) as any[]
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
      throw new Error(`OPERATION_NOT_FOUND: ${normalized}`);
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
    };
  }

  getProjectUpdate(id: string): any {
    const normalized = id.trim();
    const row = this.#sqlite.prepare("SELECT * FROM project_updates WHERE id = ?").get(normalized);
    if (!row) throw new Error(`PROJECT_UPDATE_NOT_FOUND: ${normalized}`);
    return this.projectUpdateView(row);
  }

  listProjectUpdates(limit = 50): any[] {
    return (
      this.#sqlite
        .prepare(
          `SELECT id, health, summary, completed_json, risks_json, next_json, evidence_json,
                from_sequence, to_sequence, status, actor, published_at, created_at, updated_at,
                op_id
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
               op_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, NULL, ?, ?, ?)`,
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
          throw new Error(`PROJECT_UPDATE_DRAFT_NOT_FOUND: ${normalizedInput.draftId}`);
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
               updated_at = ?, op_id = ? WHERE id = ?`,
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
              id,
            );
        } else {
          this.#sqlite
            .prepare(
              `INSERT INTO project_updates(
                 id, health, summary, completed_json, risks_json, next_json, evidence_json,
                 from_sequence, to_sequence, status, actor, published_at, created_at, updated_at,
                 op_id
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PUBLISHED', ?, ?, ?, ?, ?)`,
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
        const openWorkItems = this.listWorkItems({ limit: 100 })
          .filter(
            (item) => !["DONE", "CANCELLED"].includes(item.status) && !linkedKeys.has(item.key),
          )
          .slice(0, 5)
          .map((item) => item.key);
        return {
          ...this.listProjectUpdates(100).find((update) => update.id === id),
          seq,
          opId,
          unlinked: completed.length > 0 && openWorkItems.length > 0,
          openWorkItems: completed.length > 0 ? openWorkItems : [],
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
        if (!objective) throw new Error(`OBJECTIVE_NOT_FOUND: ${input.objectiveId}`);
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
    if (!Number.isSafeInteger(localNo)) throw new Error(`WORK_ITEM_NOT_FOUND: ${taskKey}`);
    const row = this.#sqlite.prepare("SELECT * FROM work_items WHERE local_no = ?").get(localNo);
    if (!row) throw new Error(`WORK_ITEM_NOT_FOUND: ${taskKey}`);
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
        throw new Error(`VALIDATION_ERROR: ${String(reference.kind)} evidence value required`);
      }
      if (reference.kind === "atm_record") {
        const normalized = reference.value.trim();
        const publicPrefix = `${this.meta.code}-`;
        const publicSuffix = normalized.startsWith(publicPrefix)
          ? normalized.slice(publicPrefix.length)
          : "";
        if (!/^(?:D|R)-\d{3,}$/u.test(publicSuffix)) {
          throw new Error(`RECORD_NOT_FOUND: ${reference.value}`);
        }
        return { ...reference, value: this.getRecord(normalized).key };
      }
      const row = this.rowForTaskKey(reference.value);
      const taskKey = this.taskKeyForId(row.id);
      if (!taskKey) throw new Error(`WORK_ITEM_NOT_FOUND: ${reference.value}`);
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
    if (!/^\d+$/u.test(suffix)) throw new Error(`REVIEW_REQUEST_NOT_FOUND: ${requestKey}`);
    const row = this.#sqlite
      .prepare("SELECT * FROM review_requests WHERE local_no = ?")
      .get(Number(suffix));
    if (!row) throw new Error(`REVIEW_REQUEST_NOT_FOUND: ${requestKey}`);
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
    if (!reviewTaskKey || !parentTaskKey) throw new Error("INTERNAL_ERROR: review binding invalid");
    const submission = this.#sqlite
      .prepare("SELECT * FROM review_submissions WHERE request_id = ?")
      .get(request.id) as any;
    let submissionView: ReviewSubmissionView | null = null;
    if (submission) {
      const record = this.#sqlite
        .prepare("SELECT local_no, kind FROM records WHERE id = ?")
        .get(submission.record_id) as { local_no: number; kind: string } | undefined;
      if (!record) throw new Error("INTERNAL_ERROR: review submission record missing");
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
        if (!actor.sessionId) throw new Error("REVIEW_REQUEST_REQUIRES_SESSION");
        const reviewTask = this.rowForTaskKey(normalizedInput.reviewTaskKey);
        if (reviewTask.type !== "REVIEW") {
          throw new Error(`REVIEW_TASK_INVALID: ${normalizedInput.reviewTaskKey}`);
        }
        if (reviewTask.version !== normalizedInput.expectedReviewTaskVersion) {
          throw new Error(
            `VERSION_CONFLICT: ${normalizedInput.reviewTaskKey}:${reviewTask.version}`,
          );
        }
        if (reviewTask.status === "DONE" || reviewTask.status === "CANCELLED") {
          throw new Error(`REVIEW_TASK_CLOSED: ${normalizedInput.reviewTaskKey}`);
        }
        const checklist = this.#sqlite
          .prepare("SELECT * FROM checklist_items WHERE id = ?")
          .get(normalizedInput.parentChecklistId) as any;
        if (!checklist)
          throw new Error(`CHECKLIST_NOT_FOUND: ${normalizedInput.parentChecklistId}`);
        if (checklist.version !== normalizedInput.expectedParentChecklistVersion) {
          throw new Error(`VERSION_CONFLICT: ${checklist.version}`);
        }
        if (!reviewTask.parent_id || reviewTask.parent_id !== checklist.work_item_id) {
          throw new Error(`REVIEW_BINDING_MISMATCH: ${normalizedInput.reviewTaskKey}`);
        }
        if (checklist.status === "DONE" || checklist.status === "SKIPPED") {
          throw new Error(`REVIEW_CHECKLIST_CLOSED: ${normalizedInput.parentChecklistId}`);
        }
        const existing = this.#sqlite
          .prepare("SELECT id FROM review_requests WHERE review_work_item_id = ?")
          .get(reviewTask.id);
        if (existing) throw new Error(`REVIEW_REQUEST_CONFLICT: ${normalizedInput.reviewTaskKey}`);
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
        if (!actor.sessionId) throw new Error("REVIEWER_SESSION_REQUIRED");
        const session = this.getSession(actor.sessionId);
        if (
          session.role !== "REVIEWER" ||
          session.agent_id !== actor.id ||
          session.connection_state !== "ONLINE"
        ) {
          throw new Error(`REVIEWER_REQUIRED: ${actor.sessionId}`);
        }
        const request = this.reviewRequestRow(normalizedInput.requestKey);
        const existing = this.#sqlite
          .prepare("SELECT id FROM review_submissions WHERE request_id = ?")
          .get(request.id);
        if (existing) throw new Error(`REVIEW_ALREADY_SUBMITTED: ${normalizedInput.requestKey}`);
        const reviewTask = this.#sqlite
          .prepare("SELECT * FROM work_items WHERE id = ?")
          .get(request.review_work_item_id) as any;
        if (!reviewTask || reviewTask.type !== "REVIEW") {
          throw new Error("INTERNAL_ERROR: review request points to invalid task");
        }
        const reviewTaskKey = this.taskKeyForId(reviewTask.id);
        if (!reviewTaskKey) throw new Error("INTERNAL_ERROR: review task key missing");
        if (reviewTask.version !== normalizedInput.expectedReviewTaskVersion) {
          throw new Error(`VERSION_CONFLICT: ${reviewTaskKey}:${reviewTask.version}`);
        }
        if (
          reviewTask.assignee_agent_id !== actor.id ||
          reviewTask.claimed_by_session_id !== actor.sessionId
        ) {
          throw new Error(`REVIEW_IDENTITY_MISMATCH: ${reviewTaskKey}`);
        }
        const expectedHashes = json<ReviewCandidateHash[]>(
          request.expected_candidate_hashes_json,
          [],
        );
        if (JSON.stringify(expectedHashes) !== JSON.stringify(normalizedInput.reviewedHashes)) {
          throw new Error(`CANDIDATE_HASH_MISMATCH: ${normalizedInput.requestKey}`);
        }
        const parentChecklist = this.#sqlite
          .prepare("SELECT * FROM checklist_items WHERE id = ?")
          .get(request.parent_checklist_id) as any;
        if (
          !parentChecklist ||
          parentChecklist.work_item_id !== request.parent_work_item_id ||
          reviewTask.parent_id !== request.parent_work_item_id
        ) {
          throw new Error("INTERNAL_ERROR: stored review binding invalid");
        }
        if (parentChecklist.version !== request.parent_checklist_version) {
          throw new Error(`VERSION_CONFLICT: ${parentChecklist.version}`);
        }
        this.assertCompletionGate(reviewTask);
        assertWorkItemTransition(reviewTask.status as WorkItemStatus, "DONE");

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
        if (!parentTaskKey) throw new Error("INTERNAL_ERROR: parent task key missing");
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

  listWorkItems(
    filters: {
      status?: string;
      assigneeAgentId?: string;
      parentId?: string;
      parentKey?: string;
      milestoneId?: string;
      readyOnly?: boolean;
      query?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): WorkItemView[] {
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

  createWorkItems(
    actor: ProjectActor,
    opId: string,
    items: Array<{
      clientRef: string;
      objectiveId: string;
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
    }>,
  ): { items: WorkItemView[]; sequence: number } {
    if (items.length === 0 || items.length > 50) throw new Error("VALIDATION_ERROR: items 1..50");
    if (new Set(items.map((item) => item.clientRef)).size !== items.length) {
      throw new Error("VALIDATION_ERROR: duplicate clientRef");
    }
    return this.mutate({
      actor,
      opId,
      operation: "work.create.batch",
      request: items,
      action: () => {
        const code = this.meta.code;
        const references = new Map<string, { id: string; key: string }>();
        const pendingEvents: Array<{
          id: string;
          key: string;
          title: string;
          status: WorkItemStatus;
          discoveredFrom?: string;
          discoveredFromRef?: string;
          createdAt: string;
        }> = [];
        const result: WorkItemView[] = [];
        let sequence = this.meta.sequence;
        for (const item of items) {
          const objective = this.#sqlite
            .prepare("SELECT id FROM objectives WHERE id = ?")
            .get(item.objectiveId);
          if (!objective) throw new Error(`OBJECTIVE_NOT_FOUND: ${item.objectiveId}`);
          const parentId = item.parentRef
            ? references.get(item.parentRef)?.id
            : item.parentKey
              ? this.rowForTaskKey(item.parentKey).id
              : null;
          if (item.parentRef && !parentId)
            throw new Error(`PARENT_REF_NOT_FOUND: ${item.parentRef}`);
          const parents = new Map(
            (this.#sqlite.prepare("SELECT id, parent_id FROM work_items").all() as any[]).map(
              (row) => [row.id, row.parent_id],
            ),
          );
          const id = createUlid();
          parents.set(id, null);
          assertParentMove(id, parentId, parents);
          const localNo = this.nextNumber("work_item");
          const key = `${code}-T-${String(localNo).padStart(4, "0")}`;
          const now = nowIso();
          const status = item.status ?? "BACKLOG";
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
              id,
              localNo,
              parentId,
              item.objectiveId,
              item.milestoneId ?? null,
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
              now,
              now,
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
                id,
                checklist.title,
                checklist.weight ?? 1,
                checklist.evidenceRequired ? 1 : 0,
                now,
                now,
              );
          }
          const dependencyKeys = [
            ...(item.dependsOn ?? []),
            ...(item.dependsOnRefs ?? []).map((reference) => references.get(reference)?.key ?? ""),
          ].filter(Boolean);
          const dependencyMap = new Map<string, string[]>();
          for (const row of this.#sqlite
            .prepare(
              "SELECT source_id, target_id FROM work_item_relations WHERE relation_type = 'BLOCKS'",
            )
            .all() as any[]) {
            dependencyMap.set(row.target_id, [
              ...(dependencyMap.get(row.target_id) ?? []),
              row.source_id,
            ]);
          }
          for (const dependencyKey of dependencyKeys) {
            const dependency = this.rowForTaskKey(dependencyKey);
            assertAcyclicDependency(id, dependency.id, dependencyMap);
            this.#sqlite
              .prepare(
                `INSERT INTO work_item_relations(source_id, target_id, relation_type, created_at)
                 VALUES (?, ?, 'BLOCKS', ?)`,
              )
              .run(dependency.id, id, now);
          }
          references.set(item.clientRef, { id, key });
          this.upsertSearchDocument("WORK_ITEM", id, key, item.title, item.description ?? "");
          this.recomputeWorkItem(id);
          pendingEvents.push({
            id,
            key,
            title: item.title,
            status,
            ...(item.discoveredFrom === undefined ? {} : { discoveredFrom: item.discoveredFrom }),
            ...(item.discoveredFromRef === undefined
              ? {}
              : { discoveredFromRef: item.discoveredFromRef }),
            createdAt: now,
          });
          result.push(
            this.workItemViewFromRow(
              this.#sqlite.prepare("SELECT * FROM work_items WHERE id = ?").get(id),
            ),
          );
        }
        for (const pending of pendingEvents) {
          const discoveredFrom = pending.discoveredFromRef
            ? references.get(pending.discoveredFromRef)
            : pending.discoveredFrom
              ? (() => {
                  const row = this.rowForTaskKey(pending.discoveredFrom);
                  return { id: row.id as string, key: pending.discoveredFrom };
                })()
              : undefined;
          if (pending.discoveredFromRef && !discoveredFrom) {
            throw new Error(`DISCOVERED_FROM_REF_NOT_FOUND: ${pending.discoveredFromRef}`);
          }
          if (discoveredFrom) {
            if (discoveredFrom.id === pending.id) {
              throw new Error("VALIDATION_ERROR: task cannot discover itself");
            }
            this.#sqlite
              .prepare(
                `INSERT INTO work_item_relations(source_id, target_id, relation_type, created_at)
                 VALUES (?, ?, 'DISCOVERED_FROM', ?)`,
              )
              .run(pending.id, discoveredFrom.id, pending.createdAt);
            this.refreshWorkItemSearchDocument(pending.id);
            this.refreshWorkItemSearchDocument(discoveredFrom.id);
          }
          sequence = this.appendEvent("work.created", actor, "WORK_ITEM", pending.id, {
            key: pending.key,
            title: pending.title,
            status: pending.status,
            ...(discoveredFrom ? { discoveredFrom: discoveredFrom.key } : {}),
          });
        }
        return { items: result, sequence };
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
        targetDate?: string | null;
        parentKey?: string | null;
      };
      operation: string;
      title?: string;
      description?: string;
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
      throw new Error("VALIDATION_ERROR: patches 1..50");
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
              ["title", "description", "targetDate", "parentKey"] as const
            ).filter((field) => patch[field] !== undefined);
            const currentFields = {
              title: row.title as string,
              description: row.description as string,
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
              Object.entries(expectedFields).every(
                ([field, expected]) =>
                  currentFields[field as keyof typeof currentFields] === expected,
              );
            if (!safeMerge) {
              throw new Error(`VERSION_CONFLICT: ${patch.taskKey}:${row.version}`);
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
          let targetStatus: WorkItemStatus = row.status;
          let targetPhase = (row.phase ??
            (row.status === "WAITING_AGENT" || row.status === "WAITING_USER"
              ? "IN_PROGRESS"
              : row.status)) as WorkItemPhase;
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
            if (dependency) throw new Error(`DEPENDENCY_NOT_READY: ${dependency.local_no}`);
            if (row.claimed_by_session_id && row.claimed_by_session_id !== actor.sessionId) {
              const stale =
                row.claim_lease_until && Date.parse(row.claim_lease_until) <= Date.now();
              if (!stale || !patch.takeoverStale) throw new Error("TASK_ALREADY_CLAIMED");
            }
            const successorReclaim =
              patch.operation === "claim" &&
              row.status === "IN_PROGRESS" &&
              row.assignee_agent_id === actor.id;
            targetStatus =
              patch.operation === "start" || successorReclaim ? "IN_PROGRESS" : "CLAIMED";
            targetPhase = targetStatus;
            // 来源状态只认转移表。自带白名单会让「表说可以、接口不给」重新出现，
            // 也会把 start 一个已在 IN_PROGRESS 的任务误判成非法转移。
            assertWorkItemTransition(row.status, targetStatus);
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
              throw new Error("CLAIM_OWNER_REQUIRED");
            }
            targetStatus = "READY";
            targetPhase = "READY";
            assertWorkItemTransition(row.status, targetStatus);
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
            if (!patch.blockedReason?.trim()) throw new Error("BLOCKED_REASON_REQUIRED");
            assertWorkItemTransition(row.status, "BLOCKED");
            targetStatus = "BLOCKED";
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
            if (!patch.waitingFor?.trim()) throw new Error("WAITING_FOR_REQUIRED");
            targetStatus = patch.operation === "wait_user" ? "WAITING_USER" : "WAITING_AGENT";
            assertWorkItemTransition(row.status, targetStatus);
            updates.push("status = ?", "waiting_on = ?", "waiting_for = ?");
            values.push(
              targetStatus,
              patch.operation === "wait_user" ? "USER" : "AGENT",
              patch.waitingFor.trim(),
            );
            eventType = "work.waiting";
          } else if (patch.operation === "verify") {
            assertWorkItemTransition(row.status, "VERIFYING");
            targetStatus = "VERIFYING";
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
            this.assertCompletionGate(row);
            assertWorkItemTransition(row.status, "DONE");
            targetStatus = "DONE";
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
            assertWorkItemTransition(row.status, "CANCELLED");
            const duplicateOf = patch.duplicateOf ? this.rowForTaskKey(patch.duplicateOf) : null;
            const supersededBy = patch.supersededBy ? this.rowForTaskKey(patch.supersededBy) : null;
            if (duplicateOf?.id === row.id || supersededBy?.id === row.id) {
              throw new Error("VALIDATION_ERROR: cancelled task cannot reference itself");
            }
            targetStatus = "CANCELLED";
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
            // reopen 的语义是「把停住的任务拉回来继续做」：界面在 BLOCKED /
            // WAITING_USER / WAITING_AGENT 上把它叫「重新打开」、在 VERIFYING 上叫
            // 「退回」，四处都指望回到 IN_PROGRESS。只有 CANCELLED 才该退回 BACKLOG
            // 重新排期。原先一律指向 BACKLOG，那四个按钮点下去必然 INVALID_TRANSITION。
            targetStatus =
              row.status === "CANCELLED"
                ? "BACKLOG"
                : row.status === "WAITING_AGENT" || row.status === "WAITING_USER"
                  ? targetPhase
                  : "IN_PROGRESS";
            targetPhase = targetStatus;
            assertWorkItemTransition(row.status, targetStatus);
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
            throw new Error(`VALIDATION_ERROR: unknown operation ${patch.operation}`);
          }
          if (updates.length === 0) throw new Error("VALIDATION_ERROR: empty patch");
          updates.push("version = version + 1", "updated_at = ?");
          values.push(now, row.id);
          this.#sqlite
            .prepare(`UPDATE work_items SET ${updates.join(", ")} WHERE id = ?`)
            .run(...values);
          if (actor.sessionId) {
            if (["claim", "start", "verify", "reopen"].includes(patch.operation)) {
              this.#sqlite
                .prepare(
                  `UPDATE agent_sessions SET current_work_item_id = ?, work_state = 'WORKING',
                   heartbeat_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
                )
                .run(row.id, now, now, actor.sessionId);
            } else if (["block", "wait_user", "wait_agent"].includes(patch.operation)) {
              this.#sqlite
                .prepare(
                  `UPDATE agent_sessions SET current_work_item_id = ?, work_state = 'WAITING',
                   heartbeat_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
                )
                .run(row.id, now, now, actor.sessionId);
            } else if (["release", "complete", "cancel"].includes(patch.operation)) {
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
          throw new Error(`VERSION_CONFLICT: ${input.taskKey}:${initial.version}`);
        }
        const fromStatus = initial.status as WorkItemStatus;
        const fromVersion = Number(initial.version);
        const transitions: Array<"VERIFYING" | "DONE"> = [];
        const now = nowIso();
        let sequence = this.meta.sequence;
        let verificationSequence: number | null = null;
        let verifying = initial;

        if (fromStatus !== "VERIFYING") {
          assertWorkItemTransition(fromStatus, "VERIFYING");
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

        this.assertCompletionGate(verifying);
        assertWorkItemTransition(verifying.status as WorkItemStatus, "DONE");
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
        if (!row) throw new Error(`NOT_FOUND: ${input.checklistId}`);
        if (row.version !== input.expectedVersion)
          throw new Error(`VERSION_CONFLICT: ${row.version}`);
        const evidence = normalizedInput.evidence ?? json(row.evidence_json, []);
        if (
          input.status === "DONE" &&
          Number(row.evidence_required) === 1 &&
          evidence.length === 0
        ) {
          throw new Error("COMPLETION_GATE_FAILED: evidence required");
        }
        this.#sqlite
          .prepare(
            `UPDATE checklist_items SET status = ?, evidence_json = ?, version = version + 1,
             updated_at = ? WHERE id = ?`,
          )
          .run(input.status, JSON.stringify(evidence), nowIso(), row.id);
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
      throw new Error("VALIDATION_ERROR: items 1..100");
    }
    if (new Set(input.items.map((item) => item.checklistId)).size !== input.items.length) {
      throw new Error("VALIDATION_ERROR: duplicate checklistId");
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
        if (task.version !== input.expectedVersion) {
          throw new Error(`VERSION_CONFLICT: ${input.taskKey}:${task.version}`);
        }
        const rows = normalizedInput.items.map((item) => {
          const row = this.#sqlite
            .prepare("SELECT * FROM checklist_items WHERE id = ?")
            .get(item.checklistId) as any;
          if (!row) throw new Error(`NOT_FOUND: ${item.checklistId}`);
          if (row.work_item_id !== task.id) {
            throw new Error(`CHECKLIST_TASK_MISMATCH: ${item.checklistId}`);
          }
          const evidence = item.evidence ?? json(row.evidence_json, []);
          if (
            item.status === "DONE" &&
            Number(row.evidence_required) === 1 &&
            evidence.length === 0
          ) {
            throw new Error(`COMPLETION_GATE_FAILED: evidence required (${item.checklistId})`);
          }
          return { row, item, evidence };
        });

        const now = nowIso();
        for (const { row, item, evidence } of rows) {
          this.#sqlite
            .prepare(
              `UPDATE checklist_items SET status = ?, evidence_json = ?, version = version + 1,
               updated_at = ? WHERE id = ?`,
            )
            .run(item.status, JSON.stringify(evidence), now, row.id);
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

  private assertCompletionGate(row: any): void {
    const failures: string[] = [];
    const checklistFailure = this.#sqlite
      .prepare(
        `SELECT id FROM checklist_items WHERE work_item_id = ? AND kind <> 'OPTIONAL'
         AND status NOT IN ('DONE','SKIPPED') LIMIT 1`,
      )
      .get(row.id);
    if (checklistFailure) failures.push("checklist incomplete");
    const evidenceFailure = this.#sqlite
      .prepare(
        `SELECT id FROM checklist_items WHERE work_item_id = ? AND evidence_required = 1
         AND status <> 'SKIPPED' AND (status <> 'DONE' OR evidence_json = '[]') LIMIT 1`,
      )
      .get(row.id);
    if (evidenceFailure) failures.push("evidence missing");
    const childFailure = this.#sqlite
      .prepare(
        `SELECT id FROM work_items WHERE parent_id = ? AND archived_at IS NULL
         AND status NOT IN ('DONE','CANCELLED') LIMIT 1`,
      )
      .get(row.id);
    if (childFailure) failures.push("child incomplete");
    const blocker = this.#sqlite
      .prepare("SELECT id FROM blockers WHERE work_item_id = ? AND status = 'ACTIVE' LIMIT 1")
      .get(row.id);
    if (blocker) failures.push("blocker active");
    const dependency = this.#sqlite
      .prepare(
        `SELECT source.id FROM work_item_relations relation
         JOIN work_items source ON source.id = relation.source_id
         WHERE relation.target_id = ? AND relation.relation_type = 'BLOCKS'
           AND source.status <> 'DONE' LIMIT 1`,
      )
      .get(row.id);
    if (dependency) failures.push("dependency incomplete");
    if (Number(row.verification_required) === 1 && row.status !== "VERIFYING") {
      failures.push("verification required");
    }
    if (!(row.status === "DONE" || row.status === "IN_PROGRESS" || row.status === "VERIFYING")) {
      const legal = legalWorkItemOperations(row.status as WorkItemStatus)
        .map((entry) => `${entry.operation} -> ${entry.target}`)
        .join(", ");
      failures.push(
        `current-state ${row.status} cannot complete (legal operations: ${legal || "none"})`,
      );
    }
    if (failures.length > 0) throw new Error(`COMPLETION_GATE_FAILED: ${failures.join("; ")}`);
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
  ): { ok: 1; noop?: true; seq: number; key: string; v: number; opId: string } {
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
        const bucket =
          normalizedInput.percent === undefined
            ? null
            : Math.round(Math.max(0, Math.min(100, normalizedInput.percent)) / 10) * 10;
        const hash = createHash("sha256").update(normalizedInput.summary.trim()).digest("hex");
        const last = this.#sqlite
          .prepare(
            `SELECT progress_bucket, summary_hash FROM progress_updates
             WHERE work_item_id = ? ORDER BY created_at DESC LIMIT 1`,
          )
          .get(row.id) as { progress_bucket: number | null; summary_hash: string } | undefined;
        if (
          last &&
          last.progress_bucket === bucket &&
          last.summary_hash === hash &&
          !normalizedInput.blocker
        ) {
          return {
            ok: 1,
            noop: true,
            seq: this.meta.sequence,
            key: normalizedInput.taskKey,
            v: row.version,
            opId,
          };
        }
        const now = nowIso();
        this.#sqlite
          .prepare(
            `INSERT INTO progress_updates(
               id, work_item_id, percent, progress_bucket, summary, summary_hash,
               completed_json, next_json, blocker_text, actor, session_id, created_at,
               evidence_json, op_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            createUlid(),
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
          createUlid(),
          normalizedInput.taskKey,
          normalizedInput.summary.trim(),
          normalizedInput.summary.trim(),
        );
        return { ok: 1, seq, key: normalizedInput.taskKey, v: updated.version, opId };
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
          throw new Error("VALIDATION_ERROR: summary max 300");
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
            throw new Error(`IMMUTABLE_RECORD: ${this.recordKey(superseded)}`);
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

  search(
    query: string,
    limit = 20,
  ): Array<{
    entityType: string;
    entityKey: string;
    title: string;
    snippet: string;
    updatedAt: string;
  }> {
    const bounded = Math.max(1, Math.min(30, limit));
    const normalized = query.trim();
    if (!normalized) return [];
    let rows: any[];
    if ([...normalized].length < 3) {
      const escaped = normalized.replace(/[\\%_]/gu, "\\$&");
      rows = this.#sqlite
        .prepare(
          `SELECT entity_type, entity_key, title, body, updated_at FROM search_documents
           WHERE title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\'
           ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(`%${escaped}%`, `%${escaped}%`, bounded) as any[];
    } else {
      const phrase = `"${normalized.replaceAll('"', '""')}"`;
      rows = this.#sqlite
        .prepare(
          `SELECT documents.entity_type, documents.entity_key, documents.title, documents.body,
             documents.updated_at
           FROM search_documents_fts fts
           JOIN search_documents documents
             ON documents.entity_type = fts.entity_type AND documents.entity_id = fts.entity_id
           WHERE search_documents_fts MATCH ? LIMIT ?`,
        )
        .all(phrase, bounded) as any[];
    }
    return rows.map((row) => ({
      entityType: row.entity_type,
      entityKey: row.entity_key,
      title: row.title,
      snippet: String(row.body).slice(0, 240),
      updatedAt: row.updated_at,
    }));
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
    if (!row) throw new Error(`NOT_FOUND: ${checklistId}`);
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
  ): { ok: 1; seq: number; session: string; handoffs: number } {
    if (!actor.sessionId) throw new Error("SESSION_REQUIRED");
    const sessionId = actor.sessionId;
    return this.mutate({
      actor,
      opId,
      operation: "session.end",
      request: input,
      action: () => {
        const now = nowIso();
        const claimed =
          input.outcome === "retired"
            ? (this.#sqlite
                .prepare(
                  `SELECT id FROM work_items WHERE claimed_by_session_id = ?
                 AND status NOT IN ('DONE','CANCELLED') ORDER BY updated_at DESC`,
                )
                .all(sessionId) as Array<{ id: string }>)
            : [];
        for (const task of claimed) {
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
        this.#sqlite
          .prepare(
            `UPDATE agent_sessions SET connection_state = 'CLOSED', work_state = 'IDLE',
             heartbeat_at = ?, closed_at = ?, updated_at = ?, retirement_reason = ?,
             close_reason = ?, version = version + 1 WHERE id = ?`,
          )
          .run(
            now,
            now,
            now,
            input.outcome === "retired"
              ? input.retirementReason?.trim() || "context rotation"
              : null,
            input.outcome === "retired" ? "EXPLICIT_RETIRE" : "EXPLICIT_END",
            sessionId,
          );
        const seq = this.appendEvent("agent.left", actor, "SESSION", sessionId, {
          outcome: input.outcome,
          summary: input.summary,
          next: input.next ?? [],
        });
        return { ok: 1, seq, session: sessionId, handoffs: claimed.length };
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
             PARTITION BY entity_type, entity_key ORDER BY updated_at DESC, entity_id DESC
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
       ORDER BY updated_at DESC, entity_id DESC LIMIT 1`,
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

  brief(sessionId?: string | null, maxChars = 1200): any {
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
    const records = this.#sqlite
      .prepare(
        `SELECT kind, summary, importance, source_type, source_actor_id, source_session_id, source_ref
         FROM records
         WHERE status = 'ACTIVE' AND (
           (kind = 'CONSTRAINT' AND source_type = 'USER') OR
           (kind IN ('DECISION','CONSTRAINT','FACT','RISK') AND importance IN ('HIGH','CRITICAL'))
         )
         ORDER BY CASE WHEN source_type = 'USER' AND kind = 'CONSTRAINT' THEN 0 ELSE 1 END,
                  CASE importance WHEN 'CRITICAL' THEN 0 ELSE 1 END,
                  updated_at DESC LIMIT 8`,
      )
      .all() as Array<Record<string, unknown>>;
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
    const result: Record<string, any> = {
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
