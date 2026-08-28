import type { RecordView } from "@ayanami-task/protocol";
import type {
  ProgressUpdateView,
  SessionView,
  WorkItemProgressBreakdown,
  WorkItemView,
} from "./read-model-types.js";

export function readJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function taskKey(projectCode: string, localNo: number): string {
  return `${projectCode}-T-${String(localNo).padStart(4, "0")}`;
}

export function recordKey(projectCode: string, row: { local_no: number; kind: string }): string {
  return `${projectCode}-${row.kind === "DECISION" ? "D" : "R"}-${String(row.local_no).padStart(3, "0")}`;
}

export function workItemFromRow(
  row: any,
  projectCode: string,
  progressBreakdown: WorkItemProgressBreakdown,
): WorkItemView {
  const status = row.status as WorkItemView["status"];
  const phase = (row.phase ??
    (status === "WAITING_AGENT" || status === "WAITING_USER"
      ? "IN_PROGRESS"
      : status)) as WorkItemView["phase"];
  return {
    id: row.id,
    key: taskKey(projectCode, Number(row.local_no)),
    localNo: row.local_no,
    parentId: row.parent_id,
    parentKey: row.parent_key ?? null,
    objectiveId: row.objective_id,
    milestoneId: row.milestone_id,
    type: row.type,
    title: row.title,
    description: row.description,
    acceptance: readJson(row.acceptance_json, []),
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
        ? taskKey(projectCode, row.discovered_from_local_no)
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

export function progressBreakdownFromHydratedRow(row: any): WorkItemProgressBreakdown {
  const childStages = Number(row.child_total_stages ?? 0);
  const useChildren = childStages > 0;
  return {
    computed: Number(row.computed_progress),
    reported: row.reported_progress === null ? null : Number(row.reported_progress),
    source: String(row.progress_source),
    doneWeight: Number(useChildren ? row.child_done_weight : row.checklist_done_weight),
    totalWeight: Number(useChildren ? row.child_total_weight : row.checklist_total_weight),
    doneStages: Number(useChildren ? row.child_done_stages : row.checklist_done_stages),
    totalStages: Number(useChildren ? row.child_total_stages : row.checklist_total_stages),
    blocker: row.blocked_reason ?? row.active_blocker_reason ?? null,
  };
}

export function sessionViewFromRow(
  row: any,
  projectCode: string,
  currentTaskKeyFallback: string | null = null,
): SessionView {
  const nullableBoolean = (value: unknown): boolean | null =>
    value == null ? null : Boolean(value);
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    displayName: String(row.display_name),
    clientKind: String(row.client_kind),
    capabilities: readJson(row.capabilities_json, []),
    parentSessionId: row.parent_session_id ?? null,
    predecessorSessionId: row.predecessor_session_id ?? null,
    threadId: row.thread_id ?? null,
    role: row.role as SessionView["role"],
    cwd: row.cwd ?? null,
    workState: String(row.work_state),
    connectionState: String(row.connection_state),
    currentTaskKey:
      typeof row.current_task_local_no === "number"
        ? taskKey(projectCode, row.current_task_local_no)
        : currentTaskKeyFallback,
    heartbeatAt: row.heartbeat_at ?? null,
    lastSeenAt: String(row.heartbeat_at ?? row.updated_at),
    version: Number(row.version),
    startedAt: String(row.started_at),
    updatedAt: String(row.updated_at),
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

export function recordViewFromProjectedRow(row: any, projectCode: string): RecordView {
  return {
    id: String(row.id),
    key: recordKey(projectCode, row),
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
    relatedRecords: readJson<string[]>(row.related_records_json, []),
    opId: row.op_id === null ? null : String(row.op_id),
    sourceType: row.source_type as RecordView["sourceType"],
    sourceActorId: row.source_actor_id === null ? null : String(row.source_actor_id),
    sourceSessionId: row.source_session_id === null ? null : String(row.source_session_id),
    sourceRef: row.source_ref === null ? null : String(row.source_ref),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function progressUpdateViewFromRow(row: any, projectCode: string): ProgressUpdateView {
  return {
    id: row.id,
    taskKey: taskKey(projectCode, Number(row.local_no)),
    percent: row.percent,
    progressBucket: row.progress_bucket,
    summary: row.summary,
    completed: readJson(row.completed_json, []),
    next: readJson(row.next_json, []),
    blocker: row.blocker_text,
    actor: row.actor,
    sessionId: row.session_id,
    evidence: readJson(row.evidence_json, []),
    opId: row.op_id ?? null,
    createdAt: row.created_at,
  };
}
