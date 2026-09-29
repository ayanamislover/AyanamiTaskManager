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
  /** true 只要已结束（DONE / CANCELLED），false 只要未结束；省略表示不分组。 */
  closed?: boolean;
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

export type RecentClosedWorkItemPage = {
  items: WorkItemView[];
  nextCursor: string | null;
  hasMore: boolean;
  /** 已结束任务的总数，界面用来显示「还有多少没加载」。 */
  total: number;
};

/**
 * 项目进度条的四段计数。
 *
 * 「已完成」只算 since 之后完成的任务（本次 ATM 启动以来），历史完成不计，
 * 否则老项目的已完成段会越堆越长，把其余三段挤成细线。完成时间只认 completed_at：
 * updated_at 会随普通编辑变化，不能当完成时间；早年直接登记为已完成、没有 completed_at
 * 的历史任务完成时间未知，一律不算本次。
 */
export type ProgressStripCounts = {
  since: string;
  done: number;
  /** 待整理、已领取、进行中、验收中、等待 Agent。 */
  active: number;
  /** 等待用户与受阻：都卡在人这边。 */
  waiting: number;
  ready: number;
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
export type SessionPageFilters = { limit?: number; cursor?: string; taskKey?: string };

export type SessionProjectionPage = {
  items: SessionView[];
  itemCursors: string[];
  nextCursor: string | null;
  retryCursor: string;
  hasMore: boolean;
};
