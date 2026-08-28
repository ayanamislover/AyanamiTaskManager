import { AtmError } from "@ayanami-task/errors";
import {
  mutationEntityReferences,
  objectValue,
  plain,
  uniqueMutationEntityReferences,
} from "../result.js";

export function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return {
    id: record.id,
    key: record.key,
    kind: record.kind,
    title: record.title,
    summary: record.summary,
    detail: record.detail,
    importance: record.importance,
    scope: record.scope,
    work_item_key: record.workItemKey ?? null,
    supersedes: record.supersedes ?? null,
    status: record.status,
    topic: record.topic ?? null,
    subject_key: record.subjectKey ?? null,
    related_records: Array.isArray(record.relatedRecords) ? record.relatedRecords : [],
    op_id: record.opId ?? null,
    source_type: record.sourceType,
    source_actor_id: record.sourceActorId ?? null,
    source_session_id: record.sourceSessionId ?? null,
    source_ref: record.sourceRef ?? null,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

export function fitRecordPage(
  project: string,
  requestedLimit: number,
  maxChars: number,
  items: Array<Record<string, unknown>>,
  itemCursors: string[],
  sourceHasMore: boolean,
  sourceNextCursor: string | null,
  retryCursor: string,
): Record<string, unknown> {
  for (let count = items.length; count >= 0; count -= 1) {
    const returned = items.slice(0, count);
    const budgetTruncated = count < items.length;
    const hasMore = budgetTruncated || sourceHasMore;
    const nextCursor = hasMore
      ? count > 0
        ? (itemCursors[count - 1] ?? sourceNextCursor ?? retryCursor)
        : retryCursor
      : null;
    const candidate: Record<string, unknown> = {
      exact: false,
      project: project.toUpperCase(),
      list: "records",
      requested_limit: requestedLimit,
      returned_count: returned.length,
      items: returned,
      next_cursor: nextCursor,
      has_more: hasMore,
      truncated: budgetTruncated,
    };
    if (JSON.stringify(candidate).length <= maxChars) return candidate;
  }
  return {
    exact: false,
    project: project.toUpperCase(),
    list: "records",
    requested_limit: requestedLimit,
    returned_count: 0,
    items: [],
    next_cursor: retryCursor,
    has_more: items.length > 0 || sourceHasMore,
    truncated: items.length > 0,
  };
}

export function compactSessionPageItem(session: Record<string, unknown>): Record<string, unknown> {
  return compactSession(session);
}

export function fitSessionPage(
  project: string,
  requestedLimit: number,
  maxChars: number,
  items: Array<Record<string, unknown>>,
  itemCursors: string[],
  sourceHasMore: boolean,
  sourceNextCursor: string | null,
  retryCursor: string,
): Record<string, unknown> {
  for (let count = items.length; count >= 0; count -= 1) {
    const returned = items.slice(0, count);
    const budgetTruncated = count < items.length;
    const hasMore = budgetTruncated || sourceHasMore;
    const nextCursor = hasMore
      ? count > 0
        ? (itemCursors[count - 1] ?? sourceNextCursor ?? retryCursor)
        : retryCursor
      : null;
    const candidate: Record<string, unknown> = {
      exact: false,
      project: project.toUpperCase(),
      list: "sessions",
      requested_limit: requestedLimit,
      returned_count: returned.length,
      items: returned,
      next_cursor: nextCursor,
      has_more: hasMore,
      truncated: budgetTruncated,
    };
    if (JSON.stringify(candidate).length <= maxChars) return candidate;
  }
  return {
    exact: false,
    project: project.toUpperCase(),
    list: "sessions",
    requested_limit: requestedLimit,
    returned_count: 0,
    items: [],
    next_cursor: retryCursor,
    has_more: items.length > 0 || sourceHasMore,
    truncated: items.length > 0,
  };
}

export function compactProgress(progress: Record<string, unknown>): Record<string, unknown> {
  return {
    id: progress.id,
    task_key: progress.taskKey,
    percent: progress.percent,
    progress_bucket: progress.progressBucket,
    summary: progress.summary,
    completed: (Array.isArray(progress.completed) ? progress.completed : []).map((entry) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? {
            text: (entry as Record<string, unknown>).text,
            ...((entry as Record<string, unknown>).workItemKey === undefined
              ? {}
              : { work_item_key: (entry as Record<string, unknown>).workItemKey }),
          }
        : entry,
    ),
    next: Array.isArray(progress.next) ? progress.next : [],
    blocker: progress.blocker ?? null,
    actor: progress.actor,
    session_id: progress.sessionId ?? null,
    evidence: Array.isArray(progress.evidence) ? progress.evidence : [],
    op_id: progress.opId ?? null,
    created_at: progress.createdAt,
  };
}

export function compactSession(session: Record<string, unknown>): Record<string, unknown> {
  const git = plain(session.git);
  return {
    id: session.id,
    agent_id: session.agentId,
    display_name: session.displayName,
    client_kind: session.clientKind,
    capabilities: Array.isArray(session.capabilities) ? session.capabilities : [],
    parent_session_id: session.parentSessionId ?? null,
    predecessor_session_id: session.predecessorSessionId ?? null,
    thread_id: session.threadId ?? null,
    role: session.role,
    cwd: session.cwd ?? null,
    work_state: session.workState,
    connection_state: session.connectionState,
    current_task_key: session.currentTaskKey ?? null,
    heartbeat_at: session.heartbeatAt ?? null,
    last_seen_at: session.lastSeenAt ?? session.heartbeatAt ?? session.updatedAt,
    version: session.version,
    started_at: session.startedAt,
    updated_at: session.updatedAt,
    closed_at: session.closedAt ?? null,
    retirement_reason: session.retirementReason ?? null,
    close_reason: session.closeReason ?? null,
    git: {
      available: git.available === true,
      repo_root: git.repoRoot ?? null,
      worktree_root: git.worktreeRoot ?? null,
      common_dir: git.commonDir ?? null,
      is_linked_worktree: git.isLinkedWorktree ?? null,
      branch: git.branch ?? null,
      head: git.head ?? null,
      detached: git.detached ?? null,
      dirty: git.dirty ?? null,
      error: git.error ?? null,
    },
  };
}

export function scopedUlidQuery(
  query: string,
): { kind: "PROGRESS" | "SESSION"; id: string } | null {
  const match = /^(progress|session):(.*)$/iu.exec(query.trim());
  if (!match) return null;
  const id = match[2]!.trim().toUpperCase();
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(id)) {
    throw new AtmError("VALIDATION_ERROR", {
      message: `${match[1]!.toLowerCase()}: 后必须提供 ULID`,
    });
  }
  return { kind: match[1]!.toLowerCase() === "progress" ? "PROGRESS" : "SESSION", id };
}

export function compactOperationTrace(trace: Record<string, any>): Record<string, unknown> {
  const mutations = (Array.isArray(trace.mutations) ? trace.mutations : []) as Array<
    Record<string, unknown>
  >;
  const events = (Array.isArray(trace.events) ? trace.events : []) as Array<
    Record<string, unknown>
  >;
  const entities = uniqueMutationEntityReferences(
    mutations.flatMap((mutation) =>
      mutationEntityReferences(typeof mutation.operation === "string" ? mutation.operation : "", {
        ...objectValue(mutation.response),
        ...(mutation.operation === "checklist.update"
          ? {
              taskKey: events
                .map((event) => objectValue(event.payload).taskKey)
                .find((key) => typeof key === "string"),
            }
          : {}),
      }),
    ),
  );
  return {
    op_id: trace.opId,
    entities,
    mutations: mutations.map((mutation: Record<string, unknown>) => ({
      operation: mutation.operation,
      response: mutation.response,
      session_id: mutation.sessionId,
      created_at: mutation.createdAt,
    })),
    records: (Array.isArray(trace.records) ? trace.records : []).map(
      (record: Record<string, unknown>) => compactRecord(record),
    ),
    progress: (Array.isArray(trace.progress) ? trace.progress : []).map(
      (progress: Record<string, unknown>) => compactProgress(progress),
    ),
    project_updates: (Array.isArray(trace.projectUpdates) ? trace.projectUpdates : []).map(
      (update: Record<string, unknown>) => ({
        id: update.id,
        health: update.health,
        summary: update.summary,
        completed: Array.isArray(update.completed) ? update.completed : [],
        risks: Array.isArray(update.risks) ? update.risks : [],
        next: Array.isArray(update.next) ? update.next : [],
        evidence: Array.isArray(update.evidence) ? update.evidence : [],
        from_sequence: update.fromSequence,
        to_sequence: update.toSequence,
        status: update.status,
        actor: update.actor,
        published_at: update.publishedAt ?? null,
        created_at: update.createdAt,
        updated_at: update.updatedAt,
        op_id: update.opId ?? null,
        session_id: update.sessionId ?? null,
      }),
    ),
    events: events.map((event: Record<string, unknown>) => ({
      seq: event.seq,
      type: event.type,
      aggregate_type: event.aggregateType,
      aggregate_id: event.aggregateId,
      actor: event.actor,
      session_id: event.sessionId,
      payload: event.payload,
      at: event.at,
      op_id: event.opId,
    })),
  };
}
