import type Database from "better-sqlite3";
import { AtmError } from "@ayanami-task/errors";
import { createUlid, nowIso } from "@ayanami-task/protocol";
import {
  ProjectMutationKernel,
  requestFingerprint,
  type MutationActor,
} from "./project-mutation-kernel.js";
import { MutationRequestNormalizer } from "./mutation-request-normalizer.js";

export type SessionGitContextCommand = {
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

export type CreateSessionCommandInput = {
  agentId: string;
  displayName: string;
  clientKind: string;
  parentSessionId?: string | null;
  threadId?: string | null;
  role: "PRIMARY" | "SUBAGENT" | "REVIEWER" | "OBSERVER";
  cwd?: string | null;
  gitBranch?: string | null;
  gitHead?: string | null;
  gitContext?: SessionGitContextCommand | null;
  resume?: boolean;
  predecessorSessionId?: string | null;
};

export type SessionActorResolution = {
  actor: MutationActor;
  disposition: "CURRENT" | "REPLAY" | "REBOUND";
  requestedSessionId: string;
};

export type SessionMutationResult<T> = {
  result: T;
  resolution: SessionActorResolution;
};

type SessionCommandDependencies = {
  sqlite: Database.Database;
  mutation: ProjectMutationKernel;
  schemaVersion: () => number;
  meta: () => { code: string; sequence: number };
  getSession: (id: string) => any;
  createSession: (input: CreateSessionCommandInput) => { id: string; sequence: number };
  requestNormalizer: MutationRequestNormalizer;
};

export class SessionCommands {
  readonly #sqlite: Database.Database;
  readonly #mutation: ProjectMutationKernel;
  readonly #schemaVersion: () => number;
  readonly #meta: () => { code: string; sequence: number };
  readonly #getSession: (id: string) => any;
  readonly #createSession: SessionCommandDependencies["createSession"];
  readonly #requestNormalizer: MutationRequestNormalizer;

  constructor(dependencies: SessionCommandDependencies) {
    this.#sqlite = dependencies.sqlite;
    this.#mutation = dependencies.mutation;
    this.#schemaVersion = dependencies.schemaVersion;
    this.#meta = dependencies.meta;
    this.#getSession = dependencies.getSession;
    this.#createSession = dependencies.createSession;
    this.#requestNormalizer = dependencies.requestNormalizer;
  }

  createSession(input: CreateSessionCommandInput): { id: string; sequence: number } {
    return this.#mutation.transaction(() => {
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
      const sequence = this.#mutation.appendEvent(
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
    });
  }

  recoverOrCreateSession(
    operationId: string,
    request: unknown,
    input: CreateSessionCommandInput,
  ): { id: string; sequence: number; disposition: "CREATED" | "RECOVERED" } {
    const normalizedOperationId = operationId.trim();
    if (!normalizedOperationId || normalizedOperationId.length > 128) {
      throw new AtmError("OPERATION_ID_INVALID", { message: "operationId 无效" });
    }
    const mutation = this.#mutation.mutateWithReplay({
      actor: { type: "SYSTEM", id: "session-begin", sessionId: null },
      opId: normalizedOperationId,
      operation: "session.recover-or-begin",
      request,
      idempotencyKey: `session-begin:${normalizedOperationId}`,
      immediate: true,
      action: () => this.#createSession(input),
    });
    return {
      ...mutation.value,
      disposition: mutation.replayed ? "RECOVERED" : "CREATED",
    };
  }

  resolveMutationActor(
    sessionId: string,
    opId: string,
    operation: string,
    request: unknown,
  ): SessionActorResolution {
    return this.#resolveMutationActorInternal(sessionId, opId, operation, request, false);
  }

  executeSessionMutation<T>(
    sessionId: string,
    opId: string,
    operation: string,
    request: unknown,
    action: (actor: MutationActor) => T,
  ): SessionMutationResult<T> {
    return this.#mutation.transaction(() => {
      const resolution = this.#resolveMutationActorInternal(
        sessionId,
        opId,
        operation,
        request,
        true,
      );
      return { result: action(resolution.actor), resolution };
    }, true);
  }

  #resolveMutationActorInternal(
    sessionId: string,
    opId: string,
    operation: string,
    request: unknown,
    createRecoverySuccessor: boolean,
  ): SessionActorResolution {
    const normalizedOpId = opId.trim();
    if (!normalizedOpId || normalizedOpId.length > 128)
      throw new AtmError("OPERATION_ID_INVALID", { message: "operationId 无效" });
    const fingerprint = requestFingerprint(this.#requestNormalizer.normalize(operation, request));
    const requested = this.#getSession(sessionId);
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
    if (successor && !this.#isMatchingRecoverySuccessor(requested, successor)) {
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
      const created = this.#createSession({
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
      successor = this.#getSession(created.id);
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

  #isMatchingRecoverySuccessor(predecessor: any, successor: any): boolean {
    return (
      successor.agent_id === predecessor.agent_id &&
      successor.thread_id === predecessor.thread_id &&
      successor.parent_session_id === predecessor.parent_session_id &&
      successor.role === predecessor.role
    );
  }

  updateSessionGitContext(
    id: string,
    context: SessionGitContextCommand,
  ): { updated: boolean; sequence: number } {
    return this.#mutation.transaction(() => {
      const current = this.#getSession(id);
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
        return { updated: false, sequence: this.#meta().sequence };
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
      const sequence = this.#mutation.appendEvent(
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
    });
  }

  recoverStaleSessions(cutoffIso: string): number {
    return this.#mutation.transaction(() => {
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
        this.#recordSessionClosedAtForHandledWorkItems(row.id, closedAt);
        this.#mutation.appendEvent(
          "agent.recovered_stale",
          { type: "SYSTEM", id: "SYSTEM", sessionId: null },
          "SESSION",
          row.id,
          { agentId: row.agent_id, claimDisposition: "STALE_TAKEOVER_REQUIRED" },
        );
      }
      return rows.length;
    });
  }

  forceCloseSession(
    sessionId: string,
    releaseClaims: boolean,
  ): { ok: 1; session: string; released: number; seq: number } {
    return this.#mutation.transaction(() => {
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
      this.#recordSessionClosedAtForHandledWorkItems(sessionId, closedAt);
      const seq = this.#mutation.appendEvent(
        "agent.force_closed",
        { type: "USER", id: "USER", sessionId: null },
        "SESSION",
        sessionId,
        { agentId: session.agent_id, releasedClaims: released },
      );
      return { ok: 1 as const, session: sessionId, released, seq };
    });
  }

  endSession(
    actor: MutationActor,
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
    return this.#mutation.mutate({
      actor,
      opId,
      operation: "session.end",
      request: input,
      immediate: true,
      action: () => {
        const now = nowIso();
        const projectMeta = this.#meta();
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
              projectMeta.sequence,
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
              key: `${projectMeta.code}-T-${String(task.local_no).padStart(4, "0")}`,
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
        this.#recordSessionClosedAtForHandledWorkItems(sessionId, closedAt);
        const seq = this.#mutation.appendEvent("agent.left", actor, "SESSION", sessionId, {
          outcome: input.outcome,
          summary: input.summary,
          next: input.next ?? [],
        });
        return {
          ok: 1 as const,
          seq,
          session: sessionId,
          handoffs: handoffItems.length,
          releasedItems,
        };
      },
    });
  }

  #recordSessionClosedAtForHandledWorkItems(sessionId: string, closedAt: string): void {
    if (this.#schemaVersion() < 15) return;
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
}
