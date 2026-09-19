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

/** 接回候选：判定身份是否全等所需的全部字段，别的一律不取。 */
type ResumeCandidate = {
  id: string;
  agent_id: string;
  connection_state: string;
  retirement_reason: string | null;
  cwd: string | null;
  thread_id: string | null;
  role: string;
};

type ResumeHandoffCandidate = {
  from_session_id: string;
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
            `SELECT id, agent_id, connection_state, retirement_reason, cwd, thread_id, role
             FROM agent_sessions WHERE id = ?`,
          )
          .get(input.predecessorSessionId) as ResumeCandidate | undefined;
        if (!predecessor)
          throw new AtmError("SESSION_NOT_FOUND", {
            message: `Session 不存在：${input.predecessorSessionId}`,
            details: { entity: "SESSION", reference: input.predecessorSessionId },
          });
        if (predecessor.agent_id !== input.agentId)
          throw new AtmError("SESSION_SUCCESSOR_AGENT_MISMATCH", {
            message: "Session successor Agent 不匹配",
          });
        if (predecessor.connection_state !== "CLOSED") {
          // 指名的是自己那条还开着的会话，这是自接回，不是换代交接，不该要求前任已退休。
          //
          // 否则「多候选时请显式传 predecessor」那条提示就是不可执行的：照着传任意一条
          // 候选都会立刻撞上 SESSION_NOT_RETIRED，而候选按定义就是还开着的，永远退不了休，
          // Agent 只能反复试一条不可能成功的调用。
          //
          // 身份仍须全等：指名一条别人的活会话同样是接错，这里 fail closed。
          this.#requireResumableIdentity(predecessor, input);
          this.#upsertAgent(input, now);
          return this.#resumeSession(predecessor.id, input, now);
        }
        const hasPendingHandoff = this.#hasPendingResumeHandoff(predecessor.id, input.agentId);
        if (hasPendingHandoff) this.#requireResumableIdentity(predecessor, input);
        if (!predecessor.retirement_reason && !hasPendingHandoff) {
          throw new AtmError("SESSION_NOT_RETIRED", { message: "前序 Session 尚未退休" });
        }
      }
      this.#upsertAgent(input, now);
      if (input.resume && !input.predecessorSessionId) {
        const resumed = this.#resumeOpenSession(input, now);
        if (resumed) return resumed;
      }
      const resumeHandoffPredecessorId = input.resume
        ? (input.predecessorSessionId ?? this.#findUniqueResumeHandoffPredecessor(input))
        : null;
      const sessionPredecessorId = input.predecessorSessionId ?? resumeHandoffPredecessorId;
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
          sessionPredecessorId,
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
        this.#acknowledgeResumeHandoffs(id, input, resumeHandoffPredecessorId, now);
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
          predecessorSessionId: sessionPredecessorId,
          git: input.gitContext ?? null,
        },
      );
      return { id, sequence };
    });
  }

  /**
   * resume:true 不带 predecessor 时，接回同一身份自己那条还开着的 Session。
   *
   * 原来这里只有 `if (input.resume && input.predecessorSessionId)`，条件不成立就静默
   * 新建。而上下文压缩之后，predecessorSessionId 恰恰是 agent 丢掉的那个东西——调用方
   * 传了 resume:true 却拿到一条全新 Session，还看不出区别。后果是一段连续工作散成好几条
   * Session，归属、交接和统计跟着碎。
   *
   * 身份按 (agent_id, cwd, thread_id, role) 四项全等匹配，NULL 与 NULL 也算相等。只按
   * agent_id 匹配不够：同一个 agent_id 在一个项目里并发开多条会话是实际发生过的
   * （实测 codex-root 历史上同时开着 3 条），那时「最近一条未关闭的」很可能是别人的活
   * 会话，接上去就是两个 agent 往同一条 Session 里写。
   *
   * 候选多于一条时 fail closed，不猜，与既有 successor rebind 的处理一致。
   *
   * 残余风险说明白：cwd 与 thread_id 都缺省时，这一层退化成只按 agent_id 匹配。同一个
   * agent_id 在同一个 cwd 下并行开两条都不带 thread_id 的会话，仍可能接错。要彻底堵住
   * 得让调用方带上 thread_id。
   */
  #resumeOpenSession(
    input: CreateSessionCommandInput,
    now: string,
  ): { id: string; sequence: number } | null {
    const candidates = this.#sqlite
      .prepare(
        `SELECT id, agent_id, connection_state, retirement_reason, cwd, thread_id, role
         FROM agent_sessions
         WHERE agent_id = ? AND connection_state <> 'CLOSED'
           AND cwd IS ? AND thread_id IS ? AND role = ?
         ORDER BY started_at DESC, id DESC LIMIT 2`,
      )
      .all(
        input.agentId,
        input.cwd ?? null,
        input.threadId ?? null,
        input.role,
      ) as ResumeCandidate[];
    if (candidates.length === 0) return null;
    if (candidates.length > 1)
      throw new AtmError("SESSION_SUCCESSOR_AMBIGUOUS", {
        message:
          "同一身份存在多条未关闭 Session。把其中一条的 id 作为 predecessor_session_id 再调一次即可接回那一条；" +
          "要另起一条就把 resume 去掉。",
        details: {
          agent_id: input.agentId,
          candidates: candidates.map((row) => row.id),
          resolution: "predecessor_session_id",
        },
      });
    return this.#resumeSession(candidates[0]!.id, input, now);
  }

  /**
   * 只在交接的来源 Session 唯一且身份完全相同时，才把它绑定给无 predecessor 的 resume。
   * 多个前驱或 thread/cwd/role 不一致都保留为未确认，交给调用方显式指名，不能猜。
   */
  #findUniqueResumeHandoffPredecessor(input: CreateSessionCommandInput): string | null {
    const candidates = this.#sqlite
      .prepare(
        `SELECT DISTINCT handoff.from_session_id
         FROM handoffs AS handoff
         JOIN agent_sessions AS source ON source.id = handoff.from_session_id
         WHERE handoff.to_agent_id = ? AND handoff.to_session_id IS NULL
           AND source.agent_id = ? AND source.connection_state = 'CLOSED'
           AND source.cwd IS ? AND source.thread_id IS ? AND source.role = ?
         ORDER BY source.started_at DESC, source.id DESC LIMIT 2`,
      )
      .all(
        input.agentId,
        input.agentId,
        input.cwd ?? null,
        input.threadId ?? null,
        input.role,
      ) as ResumeHandoffCandidate[];
    if (candidates.length > 1)
      throw new AtmError("SESSION_SUCCESSOR_AMBIGUOUS", {
        message:
          "同一身份存在多个待确认交接。请显式传 predecessor_session_id 选择一个前序 Session；" +
          "未绑定的 handoff 和 claim 保持不变。",
        details: {
          agent_id: input.agentId,
          candidates: candidates.map((row) => row.from_session_id),
          resolution: "predecessor_session_id",
          pending_handoff: true,
        },
      });
    return candidates.length === 1 ? candidates[0]!.from_session_id : null;
  }

  #hasPendingResumeHandoff(sessionId: string, agentId: string): boolean {
    const row = this.#sqlite
      .prepare(
        `SELECT 1 AS present FROM handoffs
         WHERE from_session_id = ? AND to_agent_id = ? AND to_session_id IS NULL LIMIT 1`,
      )
      .get(sessionId, agentId) as { present: number } | undefined;
    return row?.present === 1;
  }

  #acknowledgeResumeHandoffs(
    sessionId: string,
    input: CreateSessionCommandInput,
    predecessorSessionId: string | null,
    now: string,
  ): void {
    if (!predecessorSessionId) return;
    this.#sqlite
      .prepare(
        `UPDATE handoffs SET to_session_id = ?, acknowledged_at = ?
         WHERE to_agent_id = ? AND to_session_id IS NULL AND from_session_id = ?`,
      )
      .run(sessionId, now, input.agentId, predecessorSessionId);
  }

  /**
   * 身份要全等才能接回，role 也算身份的一部分。
   *
   * 少了这一条会出现「回执说接回成功、事件里记着 REVIEWER，而返回的那条 Session 实际
   * 还是 PRIMARY」——随后 submitReview 报 REVIEWER_REQUIRED，调用方对着一条自称
   * REVIEWER 的会话查不出原因。要换角色就该另起一条，不能靠接回悄悄改。
   */
  #requireResumableIdentity(candidate: ResumeCandidate, input: CreateSessionCommandInput): void {
    const mismatch =
      candidate.cwd !== (input.cwd ?? null) ||
      candidate.thread_id !== (input.threadId ?? null) ||
      candidate.role !== input.role;
    if (!mismatch) return;
    throw new AtmError("SESSION_SUCCESSOR_IDENTITY_MISMATCH", {
      message: "指名的 Session 身份与本次请求不一致，无法接回；去掉 resume 另起一条。",
      details: {
        session_id: candidate.id,
        expected: { cwd: candidate.cwd, thread_id: candidate.thread_id, role: candidate.role },
        requested: { cwd: input.cwd ?? null, thread_id: input.threadId ?? null, role: input.role },
      },
    });
  }

  #upsertAgent(input: CreateSessionCommandInput, now: string): void {
    this.#sqlite
      .prepare(
        `INSERT INTO agents(id, display_name, client_kind, capabilities_json, created_at, updated_at)
         VALUES (?, ?, ?, '[]', ?, ?)
         ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name,
           client_kind = excluded.client_kind, updated_at = excluded.updated_at`,
      )
      .run(input.agentId, input.displayName, input.clientKind, now, now);
  }

  #resumeSession(
    id: string,
    input: CreateSessionCommandInput,
    now: string,
  ): { id: string; sequence: number } {
    this.#sqlite
      .prepare(
        `UPDATE agent_sessions SET heartbeat_at = ?, updated_at = ?, connection_state = 'ONLINE'
         WHERE id = ?`,
      )
      .run(now, now, id);
    this.#sqlite
      .prepare(
        `UPDATE handoffs SET to_session_id = ?, acknowledged_at = ?
         WHERE to_agent_id = ? AND to_session_id IS NULL AND from_session_id = ?`,
      )
      .run(id, now, input.agentId, id);
    // 从库里回读，不取请求里的那份。
    //
    // 这一步目前够不到，变异实测过：两条接回路径都先校验过身份全等，所以此刻
    // stored 与 input 必然相同，改成用 input 也全绿。留着是因为「事件必须记这条
    // Session 的真实身份」不该依赖于上游恰好校验过——peer 打回的正是这个形状：
    // 角色没进匹配条件时，事件记着 REVIEWER 而库里还是 PRIMARY。匹配条件哪天被
    // 放宽，这里仍然说实话。
    const stored = this.#sqlite
      .prepare("SELECT role, cwd, thread_id FROM agent_sessions WHERE id = ?")
      .get(id) as { role: string; cwd: string | null; thread_id: string | null };
    const sequence = this.#mutation.appendEvent(
      "agent.resumed",
      { type: "AGENT", id: input.agentId, sessionId: id },
      "SESSION",
      id,
      {
        agentId: input.agentId,
        displayName: input.displayName,
        role: stored.role,
        cwd: stored.cwd,
        threadId: stored.thread_id,
      },
    );
    return { id, sequence };
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
    compatibleRequests: readonly unknown[] = [],
  ): SessionMutationResult<T> {
    return this.#mutation.transaction(() => {
      const resolution = this.#resolveMutationActorInternal(
        sessionId,
        opId,
        operation,
        request,
        true,
        compatibleRequests,
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
    compatibleRequests: readonly unknown[] = [],
  ): SessionActorResolution {
    const normalizedOpId = opId.trim();
    if (!normalizedOpId || normalizedOpId.length > 128)
      throw new AtmError("OPERATION_ID_INVALID", { message: "operationId 无效" });
    const fingerprint = requestFingerprint(this.#requestNormalizer.normalize(operation, request));
    const compatibleFingerprints = new Set(
      compatibleRequests.map((compatibleRequest) =>
        requestFingerprint(this.#requestNormalizer.normalize(operation, compatibleRequest)),
      ),
    );
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
        if (
          cached.operation !== operation ||
          (cached.request_fingerprint !== fingerprint &&
            !compatibleFingerprints.has(cached.request_fingerprint))
        ) {
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
        // paused 保留 claim 但仍是一次可恢复的 checkpoint；不写 handoff 会让下一轮
        // resume 只能看到旧 claim，拿不到 summary/next。其他显式结束结果不自动制造交接。
        const shouldCaptureHandoff = input.outcome === "retired" || input.outcome === "paused";
        const claimed =
          shouldCaptureHandoff || input.releaseClaims
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
        const handoffItems = shouldCaptureHandoff
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
