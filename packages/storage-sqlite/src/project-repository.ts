import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { assertParentMove, assertAcyclicDependency, computeProgress } from "@ayanami-task/domain";
import {
  assertWorkItemTransition,
  createUlid,
  nowIso,
  type WorkItemStatus,
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

export type WorkItemView = {
  id: string;
  key: string;
  localNo: number;
  parentId: string | null;
  objectiveId: string;
  milestoneId: string | null;
  type: string;
  title: string;
  description: string;
  acceptance: string[];
  status: WorkItemStatus;
  priority: string;
  assigneeAgentId: string | null;
  claimedBySessionId: string | null;
  claimLeaseUntil: string | null;
  progress: number;
  reportedProgress: number | null;
  progressSource: string;
  weight: number;
  blockedReason: string | null;
  waitingFor: string | null;
  targetDate: string | null;
  discoveredFrom: string | null;
  discoveredCount: number;
  version: number;
  updatedAt: string;
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

function workItemFromRow(row: any, projectCode: string): WorkItemView {
  return {
    id: row.id,
    key: `${projectCode}-T-${String(row.local_no).padStart(4, "0")}`,
    localNo: row.local_no,
    parentId: row.parent_id,
    objectiveId: row.objective_id,
    milestoneId: row.milestone_id,
    type: row.type,
    title: row.title,
    description: row.description,
    acceptance: json(row.acceptance_json, []),
    status: row.status,
    priority: row.priority,
    assigneeAgentId: row.assignee_agent_id,
    claimedBySessionId: row.claimed_by_session_id,
    claimLeaseUntil: row.claim_lease_until,
    progress: row.computed_progress,
    reportedProgress: row.reported_progress,
    progressSource: row.progress_source,
    weight: row.weight,
    blockedReason: row.blocked_reason,
    waitingFor: row.waiting_for,
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
           causation_id, correlation_id, payload_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
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

  private mutate<T>(input: {
    actor: ProjectActor;
    opId: string;
    operation: string;
    request: unknown;
    action: () => T;
  }): T {
    const key = `${input.actor.sessionId ?? input.actor.id}:${input.opId}`;
    const fingerprint = requestFingerprint(input.request);
    const transaction = this.#sqlite.transaction(() => {
      const cached = this.#sqlite
        .prepare("SELECT * FROM idempotency_keys WHERE key = ?")
        .get(key) as any;
      if (cached) {
        if (cached.operation !== input.operation || cached.request_fingerprint !== fingerprint) {
          throw new Error(`IDEMPOTENCY_CONFLICT: ${key}`);
        }
        return JSON.parse(cached.response_json) as T;
      }
      const result = input.action();
      this.#sqlite
        .prepare(
          `INSERT INTO idempotency_keys(
             key, operation, request_fingerprint, response_json, created_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(key, input.operation, fingerprint, JSON.stringify(result), nowIso());
      return result;
    });
    return transaction();
  }

  createSession(input: {
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
  }): { id: string; sequence: number } {
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

  getSession(id: string): any {
    const row = this.#sqlite.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(id);
    if (!row) throw new Error(`SESSION_NOT_FOUND: ${id}`);
    return row;
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
             version = version + 1 WHERE id = ?`,
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
           retirement_reason = COALESCE(retirement_reason, 'closed by user'),
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
    return this.#sqlite
      .prepare(
        `SELECT id, kind, title, summary, detail, importance, scope, work_item_id,
                supersedes_id, status, source_type, source_actor_id,
                source_session_id, source_ref, created_at, updated_at
         FROM records ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(Math.min(200, Math.max(1, limit))) as any[];
  }

  listProjectUpdates(limit = 50): any[] {
    return (
      this.#sqlite
        .prepare(
          `SELECT id, health, summary, completed_json, risks_json, next_json,
                from_sequence, to_sequence, status, actor, published_at, created_at, updated_at
         FROM project_updates ORDER BY created_at DESC LIMIT ?`,
        )
        .all(Math.min(100, Math.max(1, limit))) as any[]
    ).map((row) => ({
      id: row.id,
      health: row.health,
      summary: row.summary,
      completed: json(row.completed_json, []),
      risks: json(row.risks_json, []),
      next: json(row.next_json, []),
      fromSequence: row.from_sequence,
      toSequence: row.to_sequence,
      status: row.status,
      actor: row.actor,
      publishedAt: row.published_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
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
               from_sequence, to_sequence, status, actor, published_at, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, NULL, ?, ?)`,
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
      completed?: string[];
      risks?: string[];
      next?: string[];
    },
  ): any {
    return this.mutate({
      actor,
      opId,
      operation: "project-update.publish",
      request: input,
      action: () => {
        const draft = input.draftId
          ? (this.#sqlite
              .prepare("SELECT * FROM project_updates WHERE id = ? AND status = 'DRAFT'")
              .get(input.draftId) as any)
          : null;
        if (input.draftId && !draft)
          throw new Error(`PROJECT_UPDATE_DRAFT_NOT_FOUND: ${input.draftId}`);
        const id = draft?.id ?? createUlid();
        const now = nowIso();
        const meta = this.meta;
        const completed = input.completed ?? json(draft?.completed_json, []);
        const risks = input.risks ?? json(draft?.risks_json, []);
        const next = input.next ?? json(draft?.next_json, []);
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
               next_json = ?, status = 'PUBLISHED', actor = ?, published_at = ?, updated_at = ? WHERE id = ?`,
            )
            .run(
              input.health,
              input.summary.trim(),
              JSON.stringify(completed),
              JSON.stringify(risks),
              JSON.stringify(next),
              actor.id,
              now,
              now,
              id,
            );
        } else {
          this.#sqlite
            .prepare(
              `INSERT INTO project_updates(
                 id, health, summary, completed_json, risks_json, next_json,
                 from_sequence, to_sequence, status, actor, published_at, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PUBLISHED', ?, ?, ?, ?)`,
            )
            .run(
              id,
              input.health,
              input.summary.trim(),
              JSON.stringify(completed),
              JSON.stringify(risks),
              JSON.stringify(next),
              fromSequence,
              toSequence,
              actor.id,
              now,
              now,
              now,
            );
        }
        this.#sqlite
          .prepare(
            "UPDATE project_meta SET health = ?, version = version + 1, updated_at = ? WHERE singleton = 1",
          )
          .run(input.health, now);
        const seq = this.appendEvent("project.update.published", actor, "PROJECT_UPDATE", id, {
          health: input.health,
          summary: input.summary.trim(),
        });
        return { ...this.listProjectUpdates(100).find((update) => update.id === id), seq };
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
    const localNo = Number(taskKey.match(/-T-(\d+)$/u)?.[1]);
    if (!Number.isSafeInteger(localNo)) throw new Error(`WORK_ITEM_KEY_INVALID: ${taskKey}`);
    const row = this.#sqlite.prepare("SELECT * FROM work_items WHERE local_no = ?").get(localNo);
    if (!row) throw new Error(`NOT_FOUND: ${taskKey}`);
    return row;
  }

  private taskKeyForId(workItemId: string): string | null {
    const row = this.#sqlite
      .prepare("SELECT local_no FROM work_items WHERE id = ?")
      .get(workItemId) as { local_no: number } | undefined;
    return row ? `${this.meta.code}-T-${String(row.local_no).padStart(4, "0")}` : null;
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
      ...workItemFromRow(row, code),
      checklist,
      dependencies,
      discoveredFrom,
      discovered,
      executionSession,
    };
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
      workItemFromRow({ ...row, ...(relationStatement.get(row.id) as object) }, this.meta.code),
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
          const sortKey = localNo * 1000;
          this.#sqlite
            .prepare(
              `INSERT INTO work_items(
                 id, local_no, parent_id, objective_id, milestone_id, type, title, description,
                 acceptance_json, status, priority, sort_key, target_date, reported_progress,
                 computed_progress, progress_source, weight, verification_required, version,
                 created_by_agent_id, created_by_session_id, created_at, updated_at, source_quick_id
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 'NONE', ?, ?, 0, ?, ?, ?, ?, ?)`,
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
            workItemFromRow(
              this.#sqlite.prepare("SELECT * FROM work_items WHERE id = ?").get(id),
              code,
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
      operation: string;
      title?: string;
      description?: string;
      blockedReason?: string;
      waitingFor?: string;
      assigneeAgentId?: string | null;
      targetDate?: string | null;
      parentKey?: string | null;
      takeoverStale?: boolean;
    }>,
  ): { items: WorkItemView[]; sequence: number } {
    if (patches.length === 0 || patches.length > 50)
      throw new Error("VALIDATION_ERROR: patches 1..50");
    return this.mutate({
      actor,
      opId,
      operation: "work.patch.batch",
      request: patches,
      action: () => {
        const result: WorkItemView[] = [];
        let sequence = this.meta.sequence;
        for (const patch of patches) {
          const row = this.rowForTaskKey(patch.taskKey);
          if (row.version !== patch.expectedVersion) {
            throw new Error(`VERSION_CONFLICT: ${patch.taskKey}:${row.version}`);
          }
          const updates: string[] = [];
          const values: unknown[] = [];
          let eventType = "work.updated";
          let targetStatus: WorkItemStatus = row.status;
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
            if (!successorReclaim && !["READY", "BACKLOG", "CLAIMED"].includes(row.status)) {
              throw new Error(`INVALID_TRANSITION: ${row.status} -> ${targetStatus}`);
            }
            updates.push(
              "status = ?",
              "assignee_agent_id = ?",
              "claimed_by_session_id = ?",
              "claim_lease_until = ?",
            );
            values.push(
              targetStatus,
              actor.id,
              actor.sessionId,
              actor.sessionId ? new Date(Date.now() + 10 * 60_000).toISOString() : null,
            );
            if (targetStatus === "IN_PROGRESS" && !row.started_at) {
              updates.push("started_at = ?");
              values.push(now);
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
            updates.push(
              "status = 'READY'",
              "assignee_agent_id = NULL",
              "claimed_by_session_id = NULL",
              "claim_lease_until = NULL",
            );
            eventType = "work.released";
          } else if (patch.operation === "block") {
            if (!patch.blockedReason?.trim()) throw new Error("BLOCKED_REASON_REQUIRED");
            assertWorkItemTransition(row.status, "BLOCKED");
            targetStatus = "BLOCKED";
            updates.push("status = 'BLOCKED'", "blocked_reason = ?");
            values.push(patch.blockedReason.trim());
            eventType = "work.blocked";
          } else if (patch.operation === "wait_user" || patch.operation === "wait_agent") {
            if (!patch.waitingFor?.trim()) throw new Error("WAITING_FOR_REQUIRED");
            targetStatus = patch.operation === "wait_user" ? "WAITING_USER" : "WAITING_AGENT";
            assertWorkItemTransition(row.status, targetStatus);
            updates.push("status = ?", "waiting_for = ?");
            values.push(targetStatus, patch.waitingFor.trim());
            eventType = "work.waiting";
          } else if (patch.operation === "verify") {
            assertWorkItemTransition(row.status, "VERIFYING");
            targetStatus = "VERIFYING";
            updates.push("status = 'VERIFYING'");
            eventType = "work.verification_requested";
          } else if (patch.operation === "complete") {
            this.assertCompletionGate(row);
            assertWorkItemTransition(row.status, "DONE");
            targetStatus = "DONE";
            updates.push(
              "status = 'DONE'",
              "completed_at = ?",
              "computed_progress = 100",
              "reported_progress = 100",
            );
            values.push(now);
            eventType = "work.completed";
          } else if (patch.operation === "cancel") {
            assertWorkItemTransition(row.status, "CANCELLED");
            targetStatus = "CANCELLED";
            updates.push("status = 'CANCELLED'");
            eventType = "work.cancelled";
          } else if (patch.operation === "reopen") {
            assertWorkItemTransition(row.status, row.status === "DONE" ? "IN_PROGRESS" : "BACKLOG");
            targetStatus = row.status === "DONE" ? "IN_PROGRESS" : "BACKLOG";
            updates.push("status = ?", "completed_at = NULL");
            values.push(targetStatus);
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
            if (["claim", "start", "verify"].includes(patch.operation)) {
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
          });
          if (row.parent_id) this.recomputeWorkItem(row.parent_id);
          const updated = this.#sqlite.prepare("SELECT * FROM work_items WHERE id = ?").get(row.id);
          result.push(workItemFromRow(updated, this.meta.code));
        }
        return { items: result, sequence };
      },
    });
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
    return this.mutate({
      actor,
      opId,
      operation: "checklist.update",
      request: input,
      action: () => {
        const row = this.#sqlite
          .prepare("SELECT * FROM checklist_items WHERE id = ?")
          .get(input.checklistId) as any;
        if (!row) throw new Error(`NOT_FOUND: ${input.checklistId}`);
        if (row.version !== input.expectedVersion)
          throw new Error(`VERSION_CONFLICT: ${row.version}`);
        const evidence = input.evidence ?? json(row.evidence_json, []);
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
    const checklistFailure = this.#sqlite
      .prepare(
        `SELECT id FROM checklist_items WHERE work_item_id = ? AND kind <> 'OPTIONAL'
         AND status NOT IN ('DONE','SKIPPED') LIMIT 1`,
      )
      .get(row.id);
    if (checklistFailure) throw new Error("COMPLETION_GATE_FAILED: checklist incomplete");
    const evidenceFailure = this.#sqlite
      .prepare(
        `SELECT id FROM checklist_items WHERE work_item_id = ? AND evidence_required = 1
         AND (status <> 'DONE' OR evidence_json = '[]') LIMIT 1`,
      )
      .get(row.id);
    if (evidenceFailure) throw new Error("COMPLETION_GATE_FAILED: evidence missing");
    const childFailure = this.#sqlite
      .prepare(
        `SELECT id FROM work_items WHERE parent_id = ? AND archived_at IS NULL
         AND status NOT IN ('DONE','CANCELLED') LIMIT 1`,
      )
      .get(row.id);
    if (childFailure) throw new Error("COMPLETION_GATE_FAILED: child incomplete");
    const blocker = this.#sqlite
      .prepare("SELECT id FROM blockers WHERE work_item_id = ? AND status = 'ACTIVE' LIMIT 1")
      .get(row.id);
    if (blocker) throw new Error("COMPLETION_GATE_FAILED: blocker active");
    const dependency = this.#sqlite
      .prepare(
        `SELECT source.id FROM work_item_relations relation
         JOIN work_items source ON source.id = relation.source_id
         WHERE relation.target_id = ? AND relation.relation_type = 'BLOCKS'
           AND source.status <> 'DONE' LIMIT 1`,
      )
      .get(row.id);
    if (dependency) throw new Error("COMPLETION_GATE_FAILED: dependency incomplete");
    if (Number(row.verification_required) === 1 && row.status !== "VERIFYING") {
      throw new Error("COMPLETION_GATE_FAILED: verification required");
    }
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
      completed?: string[];
      next?: string[];
      blocker?: string | null;
      evidence?: unknown[];
    },
  ): { ok: 1; noop?: true; seq: number; key: string; v: number } {
    return this.mutate({
      actor,
      opId,
      operation: "work.progress",
      request: input,
      action: () => {
        const row = this.rowForTaskKey(input.taskKey);
        const bucket =
          input.percent === undefined
            ? null
            : Math.round(Math.max(0, Math.min(100, input.percent)) / 10) * 10;
        const hash = createHash("sha256").update(input.summary.trim()).digest("hex");
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
          !input.blocker
        ) {
          return { ok: 1, noop: true, seq: this.meta.sequence, key: input.taskKey, v: row.version };
        }
        const now = nowIso();
        this.#sqlite
          .prepare(
            `INSERT INTO progress_updates(
               id, work_item_id, percent, progress_bucket, summary, summary_hash,
               completed_json, next_json, blocker_text, actor, session_id, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            createUlid(),
            row.id,
            input.percent ?? null,
            bucket,
            input.summary.trim(),
            hash,
            JSON.stringify(input.completed ?? []),
            JSON.stringify(input.next ?? []),
            input.blocker ?? null,
            actor.id,
            actor.sessionId,
            now,
          );
        const updates = ["reported_progress = ?", "version = version + 1", "updated_at = ?"];
        const values: unknown[] = [bucket, now];
        if (input.blocker?.trim()) {
          updates.push("status = 'BLOCKED'", "blocked_reason = ?");
          values.push(input.blocker.trim());
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
              input.blocker.trim(),
              input.blocker.trim(),
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
          input.blocker ? "work.blocked" : "work.progressed",
          actor,
          "WORK_ITEM",
          row.id,
          {
            key: input.taskKey,
            title: row.title,
            from: row.computed_progress,
            to: bucket,
            summary: input.summary.trim(),
          },
        );
        this.upsertSearchDocument(
          "PROGRESS",
          createUlid(),
          input.taskKey,
          input.summary.trim(),
          input.summary.trim(),
        );
        return { ok: 1, seq, key: input.taskKey, v: updated.version };
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
      sourceType?: "USER" | "AGENT" | "SYSTEM" | "IMPORT";
      sourceActorId?: string | null;
      sourceSessionId?: string | null;
      sourceRef?: string | null;
    },
  ): { ok: 1; seq: number; key: string; v: number } {
    return this.mutate({
      actor,
      opId,
      operation: "record.create",
      request: input,
      action: () => {
        if (input.summary.length > 300) throw new Error("VALIDATION_ERROR: summary max 300");
        const id = createUlid();
        const localNo = this.nextNumber("record");
        const code = this.meta.code;
        const key = `${code}-${input.kind === "DECISION" ? "D" : "R"}-${String(localNo).padStart(3, "0")}`;
        const workItemId = input.workItemKey ? this.rowForTaskKey(input.workItemKey).id : null;
        const now = nowIso();
        if (input.supersedes) {
          this.#sqlite
            .prepare(
              `UPDATE records SET status = 'SUPERSEDED', version = version + 1,
               updated_at = ? WHERE id = ?`,
            )
            .run(now, input.supersedes);
        }
        this.#sqlite
          .prepare(
            `INSERT INTO records(
               id, local_no, kind, title, summary, detail, importance, status,
               supersedes_id, scope, work_item_id, actor, version, created_at, updated_at,
               source_type, source_actor_id, source_session_id, source_ref
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            localNo,
            input.kind,
            input.title,
            input.summary,
            input.detail ?? "",
            input.importance ?? "NORMAL",
            input.supersedes ?? null,
            input.scope ?? "PROJECT",
            workItemId,
            actor.id,
            now,
            now,
            input.sourceType ?? actor.type,
            input.sourceActorId ?? actor.id,
            input.sourceSessionId ?? actor.sessionId,
            input.sourceRef ?? null,
          );
        const seq = this.appendEvent("record.created", actor, "RECORD", id, {
          key,
          kind: input.kind,
          title: input.title,
          summary: input.summary,
        });
        this.upsertSearchDocument(
          "RECORD",
          id,
          key,
          input.title,
          `${input.summary}\n${input.detail ?? ""}`,
        );
        return { ok: 1, seq, key, v: 0 };
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
                payload_json, created_at FROM events
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
          at: row.created_at,
        };
      }),
      currentSequence: this.meta.sequence,
      hasMore,
    };
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
               claimed_by_session_id = NULL, claim_lease_until = NULL,
               version = version + 1, updated_at = ? WHERE claimed_by_session_id = ?`,
            )
            .run(now, sessionId);
        }
        this.#sqlite
          .prepare(
            `UPDATE agent_sessions SET connection_state = 'CLOSED', work_state = 'IDLE',
             heartbeat_at = ?, closed_at = ?, updated_at = ?, retirement_reason = ?,
             version = version + 1 WHERE id = ?`,
          )
          .run(
            now,
            now,
            now,
            input.outcome === "retired"
              ? input.retirementReason?.trim() || "context rotation"
              : null,
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
