import type {
  ProjectionFailureView,
  ProjectionStateView,
  ProjectionSummary,
  RecordInput,
  RecordView,
  SessionView,
  TaskContextView,
  TaskCoreView,
  TaskFullView,
  TaskViewName,
} from "@ayanami-task/protocol";
import type { CursorPage } from "./cursor-drain.js";

export type {
  ProjectionBatchReceipt,
  ProjectionFailureView,
  ProjectionReconcileReceipt,
  ProjectionStateView,
  ProjectionSummary,
} from "@ayanami-task/protocol";

export type AyanamiClientOptions = {
  endpoint: string;
  token: string;
  fetchImpl?: typeof fetch;
};

export type RegisteredProject = {
  id: string;
  code: string;
  name: string;
  description: string;
  lifecycle: string;
  coordinationMode: string;
  sourcePaths: string[];
  databasePath: string;
  version: number;
};

export type AgentRecordCreateInput = Omit<RecordInput, "project">;
export type UserRecordCreateInput = Omit<AgentRecordCreateInput, "session">;
export type RecordCreateReceipt = {
  ok: 1;
  seq: number;
  key: string;
  v: number;
  relatedRecords: string[];
};
export type ProjectRecord = RecordView;
export type AgentSession = SessionView;

export type SystemStatus = Record<string, unknown> & {
  ok: boolean;
  projectionSummary: ProjectionSummary;
  projectionFailures: ProjectionFailureView[];
};

export type OverviewProject = Record<string, unknown> & {
  id: string;
  code: string;
  name: string;
  lifecycle: string;
  projection: ProjectionStateView | null;
  health: string | null;
  current_milestone: string | null;
  next_target_date: string | null;
  progress: number | null;
  progress_source: string | null;
  active_count: number | null;
  blocked_count: number | null;
  waiting_user_count: number | null;
  waiting_agent_count: number | null;
  overdue_count: number | null;
  stale_claim_count: number | null;
  active_agent_count: number | null;
  last_activity_at: string | null;
  last_project_update_at: string | null;
};

export type OverviewResponse = Record<string, unknown> & {
  sequence: number;
  projects: OverviewProject[];
  projectionSummary: ProjectionSummary;
  projectionFailures: ProjectionFailureView[];
  quick: Record<string, unknown>;
  recentEvents: Array<Record<string, unknown>>;
};

export type TaskViewFor<TView extends TaskViewName> = TView extends "full"
  ? TaskFullView
  : TView extends "context"
    ? TaskContextView
    : TaskCoreView;

export type TaskListFilters<TView extends TaskViewName = TaskViewName> = Record<string, unknown> & {
  view?: TView;
  cursor?: string;
};

export type TaskPage<TView extends TaskViewName = TaskViewName> = CursorPage<TaskViewFor<TView>>;

export type ReconciliationClassification =
  | "ACTIVE"
  | "LEASE_EXPIRED_ONLINE"
  | "STALLED"
  | "POSSIBLY_COMPLETE";

export type ReconciliationResult = {
  project: { code: string; name: string; sourceRoot: string | null };
  generatedAt: string;
  attentionCount: number;
  counts: Record<ReconciliationClassification, number>;
  items: Array<{
    taskKey: string;
    title: string;
    status: string;
    classification: ReconciliationClassification;
    reason: string;
    ageSeconds: number;
    session: {
      id: string;
      agentId: string;
      displayName: string;
      connectionState: string;
      lastSeenAt: string | null;
      endedAt: string | null;
    } | null;
    suggestedAction: string;
    evidencePaths: string[];
  }>;
};
