import type {
  RecordView,
  SessionView as ProtocolSessionView,
  WorkItemPhase,
  WorkItemStatus,
  WorkItemWaitingOn,
} from "@ayanami-task/protocol";
import type { TaskViewProjectionRow } from "./task-view-query.js";

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

export type WorkItemPageFilters = Omit<WorkItemListFilters, "offset"> & { cursor?: string };

export type TaskViewProjectionPage = {
  items: TaskViewProjectionRow[];
  itemCursors: string[];
  nextCursor: string | null;
  retryCursor: string;
  hasMore: boolean;
};

export type WorkItemProjectionPage = {
  items: WorkItemView[];
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

export type SessionView = ProtocolSessionView;
export type SessionPageFilters = { limit?: number; cursor?: string };

export type SessionProjectionPage = {
  items: SessionView[];
  itemCursors: string[];
  nextCursor: string | null;
  retryCursor: string;
  hasMore: boolean;
};
