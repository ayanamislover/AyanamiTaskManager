import { z } from "zod";

export const WORK_ITEM_STATUSES = [
  "BACKLOG",
  "READY",
  "CLAIMED",
  "IN_PROGRESS",
  "BLOCKED",
  "WAITING_AGENT",
  "WAITING_USER",
  "VERIFYING",
  "DONE",
  "CANCELLED",
] as const;

export const WorkItemStatusSchema = z.enum(WORK_ITEM_STATUSES);
export type WorkItemStatus = z.infer<typeof WorkItemStatusSchema>;

export const WORK_ITEM_STATUS_LABELS: Record<WorkItemStatus, string> = {
  BACKLOG: "待整理",
  READY: "可开始",
  CLAIMED: "已认领",
  IN_PROGRESS: "进行中",
  BLOCKED: "受阻",
  WAITING_AGENT: "等待其他 Agent",
  WAITING_USER: "等待用户",
  VERIFYING: "待验收",
  DONE: "已完成",
  CANCELLED: "已取消",
};

export const WORK_ITEM_TRANSITIONS: Record<WorkItemStatus, readonly WorkItemStatus[]> = {
  BACKLOG: ["READY", "CANCELLED"],
  READY: ["CLAIMED", "IN_PROGRESS", "CANCELLED"],
  CLAIMED: ["IN_PROGRESS", "READY", "CANCELLED"],
  IN_PROGRESS: ["BLOCKED", "WAITING_AGENT", "WAITING_USER", "VERIFYING", "DONE", "CANCELLED"],
  BLOCKED: ["IN_PROGRESS", "READY", "CANCELLED"],
  WAITING_AGENT: ["IN_PROGRESS", "VERIFYING", "CANCELLED"],
  WAITING_USER: ["IN_PROGRESS", "VERIFYING", "CANCELLED"],
  VERIFYING: ["DONE", "IN_PROGRESS", "CANCELLED"],
  DONE: ["IN_PROGRESS"],
  CANCELLED: ["BACKLOG"],
};

export function workItemStatusLabel(status: WorkItemStatus): string {
  return WORK_ITEM_STATUS_LABELS[status];
}

export function assertWorkItemTransition(from: WorkItemStatus, to: WorkItemStatus): void {
  if (from === to) return;
  if (!WORK_ITEM_TRANSITIONS[from].includes(to)) {
    throw new Error(`INVALID_TRANSITION: ${from} -> ${to}`);
  }
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function createUlid(time = Date.now(), entropy?: Uint8Array): string {
  if (!Number.isSafeInteger(time) || time < 0 || time > 0xffffffffffff) {
    throw new Error("ULID_TIME_OUT_OF_RANGE");
  }
  const random = entropy ?? crypto.getRandomValues(new Uint8Array(10));
  if (random.length !== 10) throw new Error("ULID_ENTROPY_LENGTH");
  let randomness = 0n;
  for (const byte of random) randomness = (randomness << 8n) | BigInt(byte);
  let value = (BigInt(time) << 80n) | randomness;
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = CROCKFORD[Number(value & 31n)]! + encoded;
    value >>= 5n;
  }
  return encoded;
}

export function nowIso(date = new Date()): string {
  return date.toISOString();
}

export const PROJECT_LIFECYCLES = [
  "CREATING",
  "ACTIVE",
  "ARCHIVED",
  "RESTORING",
  "MIGRATION_FAILED",
  "TRASHED",
] as const;
export const ProjectLifecycleSchema = z.enum(PROJECT_LIFECYCLES);
export type ProjectLifecycle = z.infer<typeof ProjectLifecycleSchema>;

export const COORDINATION_MODES = ["SOLO", "AUTO", "MULTI"] as const;
export const CoordinationModeSchema = z.enum(COORDINATION_MODES);
export type CoordinationMode = z.infer<typeof CoordinationModeSchema>;

export const PROJECT_HEALTH = ["ON_TRACK", "AT_RISK", "OFF_TRACK", "UNKNOWN"] as const;
export const ProjectHealthSchema = z.enum(PROJECT_HEALTH);
export type ProjectHealth = z.infer<typeof ProjectHealthSchema>;

export const WORK_ITEM_TYPES = ["EPIC", "TASK", "SUBTASK", "BUG", "RESEARCH", "REVIEW"] as const;
export const WorkItemTypeSchema = z.enum(WORK_ITEM_TYPES);
export type WorkItemType = z.infer<typeof WorkItemTypeSchema>;

export const PRIORITIES = ["LOW", "NORMAL", "HIGH", "CRITICAL"] as const;
export const PrioritySchema = z.enum(PRIORITIES);
export type Priority = z.infer<typeof PrioritySchema>;

export const RECORD_KINDS = [
  "DECISION",
  "CONSTRAINT",
  "FACT",
  "RISK",
  "REFERENCE",
  "LESSON",
] as const;
export const RecordKindSchema = z.enum(RECORD_KINDS);
export type RecordKind = z.infer<typeof RecordKindSchema>;

export const PROJECT_HEALTH_LABELS: Record<ProjectHealth, string> = {
  ON_TRACK: "进展正常",
  AT_RISK: "存在风险",
  OFF_TRACK: "偏离计划",
  UNKNOWN: "尚未判断",
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  LOW: "低",
  NORMAL: "普通",
  HIGH: "高",
  CRITICAL: "紧急",
};

export const WORK_ITEM_TYPE_LABELS: Record<WorkItemType, string> = {
  EPIC: "大型事项",
  TASK: "任务",
  SUBTASK: "子任务",
  BUG: "缺陷",
  RESEARCH: "研究",
  REVIEW: "评审",
};

const DateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const NullableDateOnlySchema = DateOnlySchema.nullable().optional();
const NonEmptyTextSchema = z.string().trim().min(1);
const OpIdSchema = z.string().trim().min(1).max(128);

export const CreateProjectInputSchema = z.object({
  name: NonEmptyTextSchema.max(200),
  sourcePath: z.string().min(1).nullable(),
  code: z
    .string()
    .regex(/^[A-Z][A-Z0-9-]{1,11}$/u)
    .optional(),
  description: z.string().max(10_000).default(""),
  coordinationMode: CoordinationModeSchema.default("AUTO"),
  creationReason: z.string().max(500).optional(),
  creationSignals: z.record(z.string(), z.unknown()).default({}),
});

export const BeginInputSchema = z.object({
  cwd: z.string().min(1).optional(),
  projectCode: z.string().optional(),
  title: z.string().max(400).optional(),
  mode: z.enum(["auto", "quick", "project"]).default("auto"),
  agentId: NonEmptyTextSchema.max(128),
  displayName: z.string().max(200).optional(),
  clientKind: z.string().max(100).default("generic"),
  threadId: z.string().max(256).nullable().optional(),
  parentSessionId: z.string().max(128).nullable().optional(),
  resume: z.boolean().default(false),
  predecessorSessionId: z.string().max(128).nullable().optional(),
  maxChars: z.number().int().min(300).max(5000).default(1200),
  role: z.enum(["PRIMARY", "SUBAGENT", "REVIEWER", "OBSERVER"]).default("PRIMARY"),
  signals: z
    .object({
      expectedMinutes: z.number().int().nonnegative().optional(),
      subtaskCount: z.number().int().nonnegative().optional(),
      multiSession: z.boolean().optional(),
      multiAgent: z.boolean().optional(),
      hasDependencies: z.boolean().optional(),
      needsEvidence: z.boolean().optional(),
      hasTargetDate: z.boolean().optional(),
    })
    .default({}),
  allowProjectCreate: z.boolean().default(false),
  creationReason: z.string().max(500).optional(),
});

export const CreateObjectiveInputSchema = z.object({
  title: NonEmptyTextSchema.max(400),
  description: z.string().max(20_000).default(""),
  definitionOfDone: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
});

export const CreateMilestoneInputSchema = z.object({
  objectiveId: NonEmptyTextSchema,
  title: NonEmptyTextSchema.max(400),
  description: z.string().max(20_000).default(""),
  targetDate: NullableDateOnlySchema,
});

export const ChecklistCreateInputSchema = z.object({
  title: NonEmptyTextSchema.max(400),
  evidenceRequired: z.boolean().default(false),
  weight: z.number().positive().max(1000).default(1),
});

export const WorkItemCreateInputSchema = z.object({
  clientRef: NonEmptyTextSchema.max(100),
  objectiveId: NonEmptyTextSchema,
  milestoneId: z.string().nullable().optional(),
  parentKey: z.string().nullable().optional(),
  parentRef: z.string().nullable().optional(),
  dependsOn: z.array(z.string()).max(50).default([]),
  dependsOnRefs: z.array(z.string()).max(50).default([]),
  title: NonEmptyTextSchema.max(400),
  description: z.string().max(50_000).default(""),
  type: WorkItemTypeSchema.default("TASK"),
  priority: PrioritySchema.default("NORMAL"),
  status: WorkItemStatusSchema.default("BACKLOG"),
  acceptance: z.array(z.string().trim().min(1).max(1000)).max(100).default([]),
  checklist: z.array(ChecklistCreateInputSchema).max(100).default([]),
  weight: z.number().positive().max(1000).default(1),
  targetDate: NullableDateOnlySchema,
  verificationRequired: z.boolean().default(false),
});

export const TaskCreateBatchInputSchema = z.object({
  project: NonEmptyTextSchema,
  session: NonEmptyTextSchema,
  opId: OpIdSchema,
  items: z.array(WorkItemCreateInputSchema).min(1).max(50),
});

export const WorkItemPatchInputSchema = z.object({
  taskKey: NonEmptyTextSchema,
  expectedVersion: z.number().int().nonnegative(),
  operation: z.enum([
    "claim",
    "start",
    "release",
    "block",
    "wait_user",
    "wait_agent",
    "verify",
    "complete",
    "cancel",
    "reopen",
    "edit",
  ]),
  title: z.string().trim().min(1).max(400).optional(),
  description: z.string().max(50_000).optional(),
  blockedReason: z.string().trim().min(1).max(2000).optional(),
  waitingFor: z.string().trim().min(1).max(1000).optional(),
  assigneeAgentId: z.string().nullable().optional(),
  targetDate: NullableDateOnlySchema,
  parentKey: z.string().nullable().optional(),
  takeoverStale: z.boolean().default(false),
});

export const TaskPatchBatchInputSchema = z.object({
  project: NonEmptyTextSchema,
  session: NonEmptyTextSchema,
  opId: OpIdSchema,
  items: z.array(WorkItemPatchInputSchema).min(1).max(50),
});

export const ChecklistUpdateInputSchema = z.object({
  checklistId: NonEmptyTextSchema,
  expectedVersion: z.number().int().nonnegative(),
  status: z.enum(["TODO", "DOING", "DONE", "SKIPPED"]),
  evidence: z.array(z.unknown()).max(100).optional(),
});

export const ProgressAddInputSchema = z.object({
  project: NonEmptyTextSchema,
  session: NonEmptyTextSchema,
  opId: OpIdSchema,
  scope: z.enum(["task", "project"]),
  taskKey: z.string().optional(),
  percent: z.number().min(0).max(100).optional(),
  summary: NonEmptyTextSchema.max(120),
  completed: z.array(z.string().max(500)).max(20).default([]),
  next: z.array(z.string().max(500)).max(20).default([]),
  blocker: z.string().max(1000).nullable().optional(),
  health: ProjectHealthSchema.nullable().optional(),
  evidence: z.array(z.unknown()).max(20).default([]),
});

export const RecordInputSchema = z.object({
  project: NonEmptyTextSchema,
  session: NonEmptyTextSchema,
  opId: OpIdSchema,
  kind: RecordKindSchema,
  title: NonEmptyTextSchema.max(400),
  summary: NonEmptyTextSchema.max(300),
  detail: z.string().max(100_000).default(""),
  importance: z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]).default("NORMAL"),
  scope: z.string().max(100).default("PROJECT"),
  workItemKey: z.string().nullable().optional(),
  supersedes: z.string().nullable().optional(),
});

export const SearchInputSchema = z.object({
  project: z.string().optional(),
  query: NonEmptyTextSchema.max(500),
  limit: z.number().int().min(1).max(30).default(20),
});

export const DeltaInputSchema = z.object({
  project: NonEmptyTextSchema,
  sinceSeq: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100).default(50),
  types: z.array(z.string()).max(50).default([]),
});

export const EndInputSchema = z.object({
  session: NonEmptyTextSchema,
  project: NonEmptyTextSchema,
  opId: OpIdSchema,
  outcome: z.enum(["completed", "paused", "blocked", "cancelled", "error", "retired"]),
  summary: NonEmptyTextSchema.max(500),
  next: z.array(z.string().max(500)).max(20).default([]),
  releaseClaims: z.boolean().default(true),
  retirementReason: z.string().max(500).nullable().optional(),
});

export const QuickTaskCreateInputSchema = z.object({
  title: NonEmptyTextSchema.max(400),
  note: z.string().max(5000).default(""),
  dueDate: NullableDateOnlySchema,
  sourceCwd: z.string().nullable().optional(),
  actor: z.string().default("USER"),
});

export type BeginInput = z.infer<typeof BeginInputSchema>;
export type WorkItemCreateInput = z.infer<typeof WorkItemCreateInputSchema>;
export type WorkItemPatchInput = z.infer<typeof WorkItemPatchInputSchema>;
