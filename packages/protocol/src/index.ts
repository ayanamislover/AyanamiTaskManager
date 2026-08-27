import { z } from "zod";
import { AtmError } from "@ayanami-task/errors";
import { WORK_ITEM_OPERATION_NAMES } from "./work-item-operations.js";

export * from "./views/task.js";
export * from "./views/record.js";
export * from "./work-item-operations.js";

export const SESSION_CLOSE_REASONS = [
  "HEARTBEAT_TIMEOUT",
  "EXPLICIT_END",
  "EXPLICIT_RETIRE",
  "FORCE_CLOSE",
] as const;
export const SessionCloseReasonSchema = z.enum(SESSION_CLOSE_REASONS);
export type SessionCloseReason = z.infer<typeof SessionCloseReasonSchema>;

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

export function workItemStatusLabel(status: WorkItemStatus): string {
  return WORK_ITEM_STATUS_LABELS[status];
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
  "VERIFICATION",
  "WAIVER",
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

export const RECORD_SUMMARY_CODE_POINT_LIMIT = 300;

export function unicodeCodePointLength(value: string): number {
  return Array.from(value).length;
}

export const RecordSummarySchema = NonEmptyTextSchema.superRefine((value, context) => {
  if (unicodeCodePointLength(value) <= RECORD_SUMMARY_CODE_POINT_LIMIT) return;
  context.addIssue({
    code: "too_big",
    origin: "string",
    maximum: RECORD_SUMMARY_CODE_POINT_LIMIT,
    inclusive: true,
    message: `摘要不能超过 ${RECORD_SUMMARY_CODE_POINT_LIMIT} 个 Unicode code point`,
  });
}).meta({ maxLength: RECORD_SUMMARY_CODE_POINT_LIMIT });

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

export const BeginSignalsSchema = z.object({
  expectedMinutes: z.number().int().nonnegative().optional(),
  subtaskCount: z.number().int().nonnegative().optional(),
  multiSession: z.boolean().optional(),
  multiAgent: z.boolean().optional(),
  hasDependencies: z.boolean().optional(),
  needsEvidence: z.boolean().optional(),
  hasTargetDate: z.boolean().optional(),
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
  signals: BeginSignalsSchema.default({}),
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
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;
export type EvidenceInput = z.infer<typeof EvidenceInputSchema>;

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
    objectiveId: NonEmptyTextSchema.optional(),
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
    acceptance: z.array(z.string().trim().min(1).max(1000)).max(100).optional(),
    targetDate: NullableDateOnlySchema,
    parentKey: z.string().trim().min(1).max(100).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "expectedFields 至少包含一个字段");

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

const workItemPatchIdentityShape = {
  taskKey: NonEmptyTextSchema,
  expectedVersion: z.number().int().nonnegative(),
  takeoverStale: z.boolean().default(false),
};

function coreWorkItemPatchSchema<
  Operation extends (typeof WORK_ITEM_OPERATION_NAMES)[number],
  const Fields extends z.ZodRawShape,
>(operation: Operation, fields: Fields) {
  return z
    .object({
      ...workItemPatchIdentityShape,
      operation: z.literal(operation),
      ...fields,
    })
    .strict();
}

const editPatchFields = {
  expectedFields: WorkItemExpectedFieldsSchema.optional(),
  title: z.string().trim().min(1).max(400).optional(),
  description: z.string().max(50_000).optional(),
  acceptance: z.array(z.string().trim().min(1).max(1000)).max(100).optional(),
  assigneeAgentId: z.string().nullable().optional(),
  targetDate: NullableDateOnlySchema,
  parentKey: z.string().nullable().optional(),
};

const editWorkItemPatchSchema = coreWorkItemPatchSchema("edit", editPatchFields).superRefine(
  (value, context) => {
    if (!value.expectedFields) return;
    if (value.assigneeAgentId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["assigneeAgentId"],
        message: "assigneeAgentId 必须使用严格 expectedVersion",
      });
    }
    const changedFields = (
      ["title", "description", "acceptance", "targetDate", "parentKey"] as const
    ).filter((field) => value[field] !== undefined);
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
  },
);

export const CoreWorkItemPatchSchemas = {
  claim: coreWorkItemPatchSchema("claim", {}),
  start: coreWorkItemPatchSchema("start", {}),
  release: coreWorkItemPatchSchema("release", {}),
  block: coreWorkItemPatchSchema("block", {
    blockedReason: z.string().trim().min(1).max(2000),
  }),
  wait_user: coreWorkItemPatchSchema("wait_user", {
    waitingFor: z.string().trim().min(1).max(1000),
  }),
  wait_agent: coreWorkItemPatchSchema("wait_agent", {
    waitingFor: z.string().trim().min(1).max(1000),
  }),
  verify: coreWorkItemPatchSchema("verify", {}),
  complete: coreWorkItemPatchSchema("complete", {}),
  cancel: coreWorkItemPatchSchema("cancel", {
    cancelReason: z.string().trim().min(1).max(2000).optional(),
    duplicateOf: z.string().trim().min(1).max(100).nullable().optional(),
    supersededBy: z.string().trim().min(1).max(100).nullable().optional(),
  }),
  reopen: coreWorkItemPatchSchema("reopen", {}),
  edit: editWorkItemPatchSchema,
} as const satisfies Record<(typeof WORK_ITEM_OPERATION_NAMES)[number], z.ZodType>;

export type WorkItemPatchInput = z.output<
  (typeof CoreWorkItemPatchSchemas)[keyof typeof CoreWorkItemPatchSchemas]
>;

export const WorkItemPatchInputSchema: z.ZodType<WorkItemPatchInput> = z.discriminatedUnion(
  "operation",
  Object.values(CoreWorkItemPatchSchemas) as any,
);

const compositeWorkItemPatchIdentityShape = {
  ...workItemPatchIdentityShape,
  takeoverStale: z.literal(false).default(false),
};

export const CompositeTaskPatchSchemas = {
  verify_and_complete: z
    .object({
      ...compositeWorkItemPatchIdentityShape,
      operation: z.literal("verify_and_complete"),
    })
    .strict(),
  review_request: z
    .object({
      ...compositeWorkItemPatchIdentityShape,
      operation: z.literal("review_request"),
      parentChecklistId: ReviewRequestCreateInputSchema.shape.parentChecklistId,
      expectedParentChecklistVersion:
        ReviewRequestCreateInputSchema.shape.expectedParentChecklistVersion,
      candidateHashes: ReviewCandidateHashesSchema,
    })
    .strict(),
  review_submit: z
    .object({
      ...compositeWorkItemPatchIdentityShape,
      operation: z.literal("review_submit"),
      requestKey: ReviewSubmitInputSchema.shape.requestKey,
      verdict: ReviewSubmitInputSchema.shape.verdict,
      candidateHashes: ReviewCandidateHashesSchema,
      evidence: ReviewSubmitInputSchema.shape.evidence,
    })
    .strict(),
  checklist_single: z
    .object({
      ...compositeWorkItemPatchIdentityShape,
      operation: z.literal("checklist_single"),
      checklistItems: z.array(ChecklistBatchItemInputSchema).length(1),
    })
    .strict(),
  checklist_batch: z
    .object({
      ...compositeWorkItemPatchIdentityShape,
      operation: z.literal("checklist_batch"),
      checklistItems: z.array(ChecklistBatchItemInputSchema).min(1).max(100),
    })
    .strict(),
} as const;

type CoreTaskPatchOperationDefinition = {
  readonly kind: "core";
  readonly batchable: true;
  readonly schema: (typeof CoreWorkItemPatchSchemas)[keyof typeof CoreWorkItemPatchSchemas];
};

const CoreTaskPatchOperations = Object.fromEntries(
  WORK_ITEM_OPERATION_NAMES.map((operation) => [
    operation,
    { kind: "core", batchable: true, schema: CoreWorkItemPatchSchemas[operation] },
  ]),
) as {
  readonly [Operation in keyof typeof CoreWorkItemPatchSchemas]: CoreTaskPatchOperationDefinition;
};

export const TaskPatchOperations = {
  ...CoreTaskPatchOperations,
  verify_and_complete: {
    kind: "verify_and_complete",
    batchable: false,
    schema: CompositeTaskPatchSchemas.verify_and_complete,
  },
  review_request: {
    kind: "review_request",
    batchable: false,
    schema: CompositeTaskPatchSchemas.review_request,
  },
  review_submit: {
    kind: "review_submit",
    batchable: false,
    schema: CompositeTaskPatchSchemas.review_submit,
  },
  checklist_single: {
    kind: "checklist_single",
    batchable: false,
    schema: CompositeTaskPatchSchemas.checklist_single,
  },
  checklist_batch: {
    kind: "checklist_batch",
    batchable: false,
    schema: CompositeTaskPatchSchemas.checklist_batch,
  },
} as const;

export type TaskPatchOperation = keyof typeof TaskPatchOperations;
export const TASK_PATCH_OPERATION_NAMES = Object.keys(TaskPatchOperations) as [
  TaskPatchOperation,
  ...TaskPatchOperation[],
];

export type TaskPatchItem = z.output<(typeof TaskPatchOperations)[TaskPatchOperation]["schema"]>;

export const TaskPatchItemSchema: z.ZodType<TaskPatchItem> = z.discriminatedUnion(
  "operation",
  TASK_PATCH_OPERATION_NAMES.map((operation) => TaskPatchOperations[operation].schema) as any,
);

export const TaskPatchBatchInputSchema = z.object({
  project: NonEmptyTextSchema,
  session: NonEmptyTextSchema,
  opId: OpIdSchema,
  items: z.array(WorkItemPatchInputSchema).min(1).max(50),
});

export const ChecklistBatchUpdateInputSchema = z.object({
  project: NonEmptyTextSchema,
  session: NonEmptyTextSchema,
  opId: OpIdSchema,
  taskKey: NonEmptyTextSchema,
  expectedVersion: z.number().int().nonnegative(),
  items: z.array(ChecklistBatchItemInputSchema).min(1).max(100),
});

export const ChecklistBatchFailureReasonSchema = z.discriminatedUnion("code", [
  z
    .object({
      task_key: NonEmptyTextSchema.max(100),
      code: z.literal("VERSION_CONFLICT"),
      expected: z.number().int().nonnegative(),
      actual: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      checklist_id: NonEmptyTextSchema.max(128),
      code: z.enum(["NOT_FOUND", "TASK_MISMATCH", "EVIDENCE_REQUIRED"]),
    })
    .strict(),
]);

export const ChecklistBatchFailureDetailsSchema = z
  .object({ reasons: z.array(ChecklistBatchFailureReasonSchema).min(1).max(101) })
  .strict();

export type ChecklistBatchFailureReason = z.infer<typeof ChecklistBatchFailureReasonSchema>;
export type ChecklistBatchFailureDetails = z.infer<typeof ChecklistBatchFailureDetailsSchema>;

function checklistBatchFailureMessage(reasons: readonly ChecklistBatchFailureReason[]): string {
  return reasons
    .map((reason) => {
      if (reason.code === "VERSION_CONFLICT") {
        return `version conflict (${reason.task_key}: expected ${reason.expected}, actual ${reason.actual})`;
      }
      if (reason.code === "EVIDENCE_REQUIRED") {
        return `evidence required (${reason.checklist_id})`;
      }
      if (reason.code === "TASK_MISMATCH") {
        return `checklist task mismatch (${reason.checklist_id})`;
      }
      return `checklist not found (${reason.checklist_id})`;
    })
    .join("; ");
}

/** A preflight failure for an atomic checklist batch. No mutation has been applied. */
export class ChecklistBatchFailureError extends AtmError<"COMPLETION_GATE_FAILED"> {
  constructor(reasons: readonly ChecklistBatchFailureReason[]) {
    const details = ChecklistBatchFailureDetailsSchema.parse({ reasons });
    super("COMPLETION_GATE_FAILED", {
      message: checklistBatchFailureMessage(details.reasons),
      details,
    });
    this.name = "ChecklistBatchFailureError";
  }
}

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

export const RecordTopicSchema = z.string().trim().min(1).max(200);
export const RecordSubjectKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u, "subjectKey 必须是稳定、无空白的主题标识");

export const RecordInputSchema = z.object({
  project: NonEmptyTextSchema,
  session: NonEmptyTextSchema,
  opId: OpIdSchema,
  kind: RecordKindSchema,
  title: NonEmptyTextSchema.max(400),
  summary: RecordSummarySchema,
  detail: z.string().max(100_000).default(""),
  importance: z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]).default("NORMAL"),
  scope: z.string().max(100).default("PROJECT"),
  workItemKey: z.string().nullable().optional(),
  supersedes: z.string().nullable().optional(),
  topic: RecordTopicSchema.nullable().optional(),
  subjectKey: RecordSubjectKeySchema.nullable().optional(),
});

export const SearchInputSchema = z.object({
  project: z.string().optional(),
  query: NonEmptyTextSchema.max(500),
  limit: z.number().int().min(1).max(30).default(20),
  cursor: z.string().min(1).max(4000).optional(),
});

export const SearchHitSchema = z.object({
  entityType: z.string(),
  entityKey: z.string(),
  title: z.string(),
  snippet: z.string(),
  updatedAt: z.string(),
  project: z.string().nullable().optional(),
});

export const SearchPageSchema = z.object({
  hits: z.array(SearchHitSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
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

type ExternalizableObjectSchema = z.ZodObject<z.ZodRawShape>;

export type ExternalNameMap<Schema extends ExternalizableObjectSchema> = {
  readonly [Key in Extract<keyof z.input<Schema>, string>]: string;
};

export type ExternalFieldAdapter = {
  readonly schema: z.ZodType;
  readonly decode: (value: unknown) => unknown;
};

/**
 * Derive a strict wire object from one canonical camelCase Zod object.
 *
 * The public field schemas are the canonical schema's actual child schemas, not
 * copies.  Object-level refinements are also delegated back to the canonical
 * schema and their issue paths are translated to the wire names.  A nested
 * object/array that needs its own naming boundary can supply a field adapter;
 * its decoder runs before the canonical object is parsed.
 */
export function externalizeObjectSchema<
  Schema extends ExternalizableObjectSchema,
  Names extends ExternalNameMap<Schema>,
>(
  canonicalSchema: Schema,
  names: Names,
  fieldAdapters: Partial<Record<Extract<keyof z.input<Schema>, string>, ExternalFieldAdapter>> = {},
): {
  readonly inputSchema: z.ZodObject<z.ZodRawShape>;
  readonly parse: (value: unknown) => z.output<Schema>;
  readonly toCanonical: (value: Record<string, unknown>) => Record<string, unknown>;
} {
  const canonicalShape = canonicalSchema.shape;
  const externalShape: Record<string, any> = {};
  const canonicalKeys = Object.keys(canonicalShape);
  for (const canonicalKey of canonicalKeys) {
    const externalName = names[canonicalKey as keyof Names];
    if (typeof externalName !== "string" || externalName.length === 0) {
      throw new AtmError("EXTERNAL_NAME_MISSING", {
        message: `外部字段名缺失：${canonicalKey}`,
        details: { canonical_key: canonicalKey },
      });
    }
    const fieldAdapter = fieldAdapters[canonicalKey as keyof typeof fieldAdapters];
    externalShape[externalName] = fieldAdapter?.schema ?? canonicalShape[canonicalKey]!;
  }

  const toCanonical = (value: Record<string, unknown>): Record<string, unknown> => {
    const canonical: Record<string, unknown> = {};
    for (const canonicalKey of canonicalKeys) {
      const externalName = names[canonicalKey as keyof Names] as string;
      if (!Object.prototype.hasOwnProperty.call(value, externalName)) continue;
      const fieldAdapter = fieldAdapters[canonicalKey as keyof typeof fieldAdapters];
      canonical[canonicalKey] = fieldAdapter
        ? fieldAdapter.decode(value[externalName])
        : value[externalName];
    }
    return canonical;
  };

  const inputSchema = z
    .object(externalShape)
    .strict()
    .superRefine((value, context) => {
      const parsed = canonicalSchema.safeParse(toCanonical(value));
      if (parsed.success) return;
      for (const issue of parsed.error.issues) {
        const [first, ...rest] = issue.path;
        const externalFirst =
          typeof first === "string" && Object.prototype.hasOwnProperty.call(names, first)
            ? names[first as keyof Names]
            : first;
        context.addIssue({
          ...issue,
          path: first === undefined ? [] : [externalFirst as PropertyKey, ...rest],
        } as Parameters<typeof context.addIssue>[0]);
      }
    });

  return {
    inputSchema,
    parse: (value) => canonicalSchema.parse(toCanonical(inputSchema.parse(value))),
    toCanonical,
  };
}

export type BeginInput = z.infer<typeof BeginInputSchema>;
export type WorkItemCreateInput = z.infer<typeof WorkItemCreateInputSchema>;
export type ChecklistBatchUpdateInput = z.infer<typeof ChecklistBatchUpdateInputSchema>;
export type VerifyAndCompleteInput = z.infer<typeof VerifyAndCompleteInputSchema>;
export type ReviewRequestCreateInput = z.infer<typeof ReviewRequestCreateInputSchema>;
export type ReviewSubmitInput = z.infer<typeof ReviewSubmitInputSchema>;
export type RecordInput = z.input<typeof RecordInputSchema>;
export type ProgressAddInput = z.infer<typeof ProgressAddInputSchema>;
export type SearchInput = z.infer<typeof SearchInputSchema>;
export type SearchHit = z.infer<typeof SearchHitSchema>;
export type SearchPage = z.infer<typeof SearchPageSchema>;
