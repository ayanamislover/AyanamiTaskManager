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

export const WORK_ITEM_PHASES = [
  "BACKLOG",
  "READY",
  "CLAIMED",
  "IN_PROGRESS",
  "BLOCKED",
  "VERIFYING",
  "DONE",
  "CANCELLED",
] as const;
export const WorkItemPhaseSchema = z.enum(WORK_ITEM_PHASES);
export type WorkItemPhase = z.infer<typeof WorkItemPhaseSchema>;

export const WORK_ITEM_WAITING_ON = ["USER", "AGENT"] as const;
export const WorkItemWaitingOnSchema = z.enum(WORK_ITEM_WAITING_ON);
export type WorkItemWaitingOn = z.infer<typeof WorkItemWaitingOnSchema>;

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

// 这张表是状态机的唯一事实源，两条方向都必须成立：仓储层每个操作都要 assert 它，
// 而它声明的每一条转移都必须真有操作能执行。一旦仓储层另写一份来源状态白名单，
// 就会出现「表说可以、接口不给」的死结——界面照着表把出口画出来，点下去必然报错。
// 守卫见 packages/application/test/work-item-transitions.test.ts。
export const WORK_ITEM_TRANSITIONS: Record<WorkItemStatus, readonly WorkItemStatus[]> = {
  // BACKLOG 不直接进 READY：产品给的路径是「开始」(start) 或先 claim 再 release。
  BACKLOG: ["CLAIMED", "IN_PROGRESS", "CANCELLED"],
  READY: ["CLAIMED", "IN_PROGRESS", "CANCELLED"],
  CLAIMED: ["IN_PROGRESS", "READY", "CANCELLED"],
  // READY 来自 release：放弃领取后回到可开始队列。下面几个状态同理。
  IN_PROGRESS: [
    "BLOCKED",
    "WAITING_AGENT",
    "WAITING_USER",
    "VERIFYING",
    "DONE",
    "READY",
    "CANCELLED",
  ],
  BLOCKED: ["IN_PROGRESS", "READY", "CANCELLED"],
  WAITING_AGENT: ["IN_PROGRESS", "READY", "VERIFYING", "CANCELLED"],
  WAITING_USER: ["IN_PROGRESS", "READY", "VERIFYING", "CANCELLED"],
  VERIFYING: ["WAITING_AGENT", "WAITING_USER", "DONE", "IN_PROGRESS", "READY", "CANCELLED"],
  DONE: ["IN_PROGRESS"],
  CANCELLED: ["BACKLOG"],
};

export type WorkItemOperation =
  | "claim"
  | "start"
  | "release"
  | "block"
  | "wait_agent"
  | "wait_user"
  | "verify"
  | "complete"
  | "cancel"
  | "reopen";

const WORK_ITEM_LEGAL_OPERATIONS: Record<
  WorkItemStatus,
  ReadonlyArray<{ operation: WorkItemOperation; target: WorkItemStatus }>
> = {
  BACKLOG: [
    { operation: "claim", target: "CLAIMED" },
    { operation: "start", target: "IN_PROGRESS" },
    { operation: "cancel", target: "CANCELLED" },
  ],
  READY: [
    { operation: "claim", target: "CLAIMED" },
    { operation: "start", target: "IN_PROGRESS" },
    { operation: "cancel", target: "CANCELLED" },
  ],
  CLAIMED: [
    { operation: "start", target: "IN_PROGRESS" },
    { operation: "release", target: "READY" },
    { operation: "cancel", target: "CANCELLED" },
  ],
  IN_PROGRESS: [
    { operation: "block", target: "BLOCKED" },
    { operation: "wait_agent", target: "WAITING_AGENT" },
    { operation: "wait_user", target: "WAITING_USER" },
    { operation: "verify", target: "VERIFYING" },
    { operation: "complete", target: "DONE" },
    { operation: "release", target: "READY" },
    { operation: "cancel", target: "CANCELLED" },
  ],
  BLOCKED: [
    { operation: "reopen", target: "IN_PROGRESS" },
    { operation: "release", target: "READY" },
    { operation: "cancel", target: "CANCELLED" },
  ],
  WAITING_AGENT: [
    { operation: "reopen", target: "IN_PROGRESS" },
    { operation: "release", target: "READY" },
    { operation: "verify", target: "VERIFYING" },
    { operation: "cancel", target: "CANCELLED" },
  ],
  WAITING_USER: [
    { operation: "reopen", target: "IN_PROGRESS" },
    { operation: "release", target: "READY" },
    { operation: "verify", target: "VERIFYING" },
    { operation: "cancel", target: "CANCELLED" },
  ],
  VERIFYING: [
    { operation: "wait_agent", target: "WAITING_AGENT" },
    { operation: "wait_user", target: "WAITING_USER" },
    { operation: "complete", target: "DONE" },
    { operation: "reopen", target: "IN_PROGRESS" },
    { operation: "release", target: "READY" },
    { operation: "cancel", target: "CANCELLED" },
  ],
  DONE: [{ operation: "reopen", target: "IN_PROGRESS" }],
  CANCELLED: [{ operation: "reopen", target: "BACKLOG" }],
};

export function legalWorkItemOperations(
  status: WorkItemStatus,
): ReadonlyArray<{ operation: WorkItemOperation; target: WorkItemStatus }> {
  return WORK_ITEM_LEGAL_OPERATIONS[status];
}

export function workItemStatusLabel(status: WorkItemStatus): string {
  return WORK_ITEM_STATUS_LABELS[status];
}

export function assertWorkItemTransition(from: WorkItemStatus, to: WorkItemStatus): void {
  if (from === to) return;
  if (!WORK_ITEM_TRANSITIONS[from].includes(to)) {
    const legal = legalWorkItemOperations(from)
      .map((entry) => `${entry.operation} -> ${entry.target}`)
      .join(", ");
    throw new Error(
      `INVALID_TRANSITION: ${from} -> ${to} (legal operations from ${from}: ${legal || "none"})`,
    );
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
  operationId: OpIdSchema.optional(),
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

export const EvidenceReferenceSchema = z.object({
  kind: z.enum(["git_sha", "atm_record", "atm_task", "test_result", "url", "file"]),
  value: NonEmptyTextSchema.max(2000),
  note: z.string().trim().max(500).optional(),
});

export const EvidenceInputSchema = z.union([NonEmptyTextSchema.max(2000), EvidenceReferenceSchema]);

export const ReviewCandidateHashSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_.:-]*$/iu),
  value: z
    .string()
    .trim()
    .regex(/^[a-f0-9]{7,128}$/iu),
});

export const ReviewCandidateHashesSchema = z
  .array(ReviewCandidateHashSchema)
  .min(1)
  .max(20)
  .superRefine((hashes, context) => {
    const names = new Set<string>();
    for (const [index, hash] of hashes.entries()) {
      const normalized = hash.name.toLowerCase();
      if (names.has(normalized)) {
        context.addIssue({
          code: "custom",
          path: [index, "name"],
          message: `重复候选 hash 名称: ${normalized}`,
        });
      }
      names.add(normalized);
    }
  });

export function normalizeReviewCandidateHashes(
  hashes: ReadonlyArray<{ name: string; value: string }>,
): Array<{ name: string; value: string }> {
  return ReviewCandidateHashesSchema.parse(hashes)
    .map((hash) => ({
      name: hash.name.trim().toLowerCase(),
      value: hash.value.trim().toLowerCase(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export const ReviewRequestCreateInputSchema = z.object({
  project: NonEmptyTextSchema,
  session: NonEmptyTextSchema,
  opId: OpIdSchema,
  reviewTaskKey: NonEmptyTextSchema.max(100),
  expectedReviewTaskVersion: z.number().int().nonnegative(),
  parentChecklistId: NonEmptyTextSchema.max(128),
  expectedParentChecklistVersion: z.number().int().nonnegative(),
  expectedCandidateHashes: ReviewCandidateHashesSchema,
});

export const ReviewSubmitInputSchema = z.object({
  project: NonEmptyTextSchema,
  session: NonEmptyTextSchema,
  opId: OpIdSchema,
  requestKey: NonEmptyTextSchema.max(128),
  expectedReviewTaskVersion: z.number().int().nonnegative(),
  verdict: z.enum(["APPROVED", "CHANGES_REQUESTED"]),
  reviewedHashes: ReviewCandidateHashesSchema,
  evidence: z.array(EvidenceReferenceSchema).min(1).max(100),
});

export const ProgressCompletedInputSchema = z.union([
  z.string().max(500),
  z.object({
    text: NonEmptyTextSchema.max(500),
    workItemKey: NonEmptyTextSchema.max(100).optional(),
  }),
]);

export const WorkItemCreateInputSchema = z
  .object({
    clientRef: NonEmptyTextSchema.max(100),
    objectiveId: NonEmptyTextSchema,
    milestoneId: z.string().nullable().optional(),
    parentKey: z.string().nullable().optional(),
    parentRef: z.string().nullable().optional(),
    dependsOn: z.array(z.string()).max(50).default([]),
    dependsOnRefs: z.array(z.string()).max(50).default([]),
    discoveredFrom: NonEmptyTextSchema.max(100).optional(),
    discoveredFromRef: NonEmptyTextSchema.max(100).optional(),
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
    assigneeAgentId: z.string().trim().min(1).max(128).nullable().optional(),
  })
  .refine((value) => !(value.discoveredFrom && value.discoveredFromRef), {
    message: "discoveredFrom 与 discoveredFromRef 只能指定一个",
    path: ["discoveredFromRef"],
  });

export const TaskCreateBatchInputSchema = z.object({
  project: NonEmptyTextSchema,
  session: NonEmptyTextSchema,
  opId: OpIdSchema,
  items: z.array(WorkItemCreateInputSchema).min(1).max(50),
});

export const WorkItemExpectedFieldsSchema = z
  .object({
    title: z.string().trim().min(1).max(400).optional(),
    description: z.string().max(50_000).optional(),
    targetDate: NullableDateOnlySchema,
    parentKey: z.string().trim().min(1).max(100).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "expectedFields 至少包含一个字段");

export const WorkItemPatchInputSchema = z
  .object({
    taskKey: NonEmptyTextSchema,
    expectedVersion: z.number().int().nonnegative(),
    expectedFields: WorkItemExpectedFieldsSchema.optional(),
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
    cancelReason: z.string().trim().min(1).max(2000).optional(),
    duplicateOf: z.string().trim().min(1).max(100).nullable().optional(),
    supersededBy: z.string().trim().min(1).max(100).nullable().optional(),
    assigneeAgentId: z.string().nullable().optional(),
    targetDate: NullableDateOnlySchema,
    parentKey: z.string().nullable().optional(),
    takeoverStale: z.boolean().default(false),
  })
  .superRefine((value, context) => {
    if (!value.expectedFields) return;
    if (value.operation !== "edit") {
      context.addIssue({
        code: "custom",
        path: ["expectedFields"],
        message: "expectedFields 仅适用于 edit",
      });
      return;
    }
    if (value.assigneeAgentId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["assigneeAgentId"],
        message: "assigneeAgentId 必须使用严格 expectedVersion",
      });
    }
    const changedFields = (["title", "description", "targetDate", "parentKey"] as const).filter(
      (field) => value[field] !== undefined,
    );
    if (changedFields.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["expectedFields"],
        message: "expectedFields 要求至少编辑一个白名单字段",
      });
    }
    for (const field of changedFields) {
      if (!Object.prototype.hasOwnProperty.call(value.expectedFields, field)) {
        context.addIssue({
          code: "custom",
          path: ["expectedFields", field],
          message: `缺少被修改字段 ${field} 的 compare value`,
        });
      }
    }
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
  evidence: z.array(EvidenceInputSchema).max(100).optional(),
});

export const ChecklistBatchItemInputSchema = z.object({
  checklistId: NonEmptyTextSchema,
  status: z.enum(["TODO", "DOING", "DONE", "SKIPPED"]),
  evidence: z.array(EvidenceInputSchema).max(100).optional(),
});

export const ChecklistBatchUpdateInputSchema = z.object({
  project: NonEmptyTextSchema,
  session: NonEmptyTextSchema,
  opId: OpIdSchema,
  taskKey: NonEmptyTextSchema,
  expectedVersion: z.number().int().nonnegative(),
  items: z.array(ChecklistBatchItemInputSchema).min(1).max(100),
});

export const VerifyAndCompleteInputSchema = z.object({
  project: NonEmptyTextSchema,
  session: NonEmptyTextSchema,
  opId: OpIdSchema,
  taskKey: NonEmptyTextSchema,
  expectedVersion: z.number().int().nonnegative(),
});

export const ProgressAddInputSchema = z.object({
  project: NonEmptyTextSchema,
  session: NonEmptyTextSchema,
  opId: OpIdSchema,
  scope: z.enum(["task", "project"]),
  taskKey: z.string().optional(),
  percent: z.number().min(0).max(100).optional(),
  summary: NonEmptyTextSchema.max(500),
  completed: z.array(ProgressCompletedInputSchema).max(20).default([]),
  next: z.array(z.string().max(500)).max(20).default([]),
  blocker: z.string().max(1000).nullable().optional(),
  health: ProjectHealthSchema.nullable().optional(),
  evidence: z.array(EvidenceInputSchema).max(20).default([]),
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
export type ChecklistBatchUpdateInput = z.infer<typeof ChecklistBatchUpdateInputSchema>;
export type VerifyAndCompleteInput = z.infer<typeof VerifyAndCompleteInputSchema>;
export type ReviewRequestCreateInput = z.infer<typeof ReviewRequestCreateInputSchema>;
export type ReviewSubmitInput = z.infer<typeof ReviewSubmitInputSchema>;
