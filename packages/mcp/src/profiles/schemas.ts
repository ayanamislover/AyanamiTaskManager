import { z } from "zod";
import {
  BeginInputSchema,
  BeginSignalsSchema,
  ChecklistBatchItemInputSchema,
  ChecklistCreateInputSchema,
  type ExternalNameMap,
  RECORD_SUMMARY_CODE_POINT_LIMIT,
  RecordSummarySchema,
  ReviewCandidateHashSchema,
  TASK_PATCH_OPERATION_NAMES,
  TaskCreateBatchInputSchema,
  TaskPatchOperations,
  WorkItemCreateInputSchema,
  WorkItemExpectedFieldsSchema,
  externalizeObjectSchema,
  type TaskPatchItem,
  type TaskPatchOperation,
  unicodeCodePointLength,
} from "@ayanami-task/protocol";

export const outputSchema = z.object({}).catchall(z.unknown());
export const projectCode = z.string().trim().min(1).max(20);
export const taskKey = z.string().trim().min(1).max(40);
export const opId = z.string().trim().min(1).max(128);
export const sessionId = z.string().trim().min(1).max(128);
export const recordSummary = RecordSummarySchema.superRefine((value, context) => {
  const actualLength = unicodeCodePointLength(value);
  if (actualLength <= RECORD_SUMMARY_CODE_POINT_LIMIT) return;
  context.addIssue({
    code: "custom",
    message: `INVALID_ARGUMENT ${JSON.stringify({
      actual_length: actualLength,
      limit: RECORD_SUMMARY_CODE_POINT_LIMIT,
      path: "summary",
    })}`,
  });
}).meta({ maxLength: RECORD_SUMMARY_CODE_POINT_LIMIT });

const beginSignalNames = {
  expectedMinutes: "expected_minutes",
  subtaskCount: "subtask_count",
  multiSession: "multi_session",
  multiAgent: "multi_agent",
  hasDependencies: "has_dependencies",
  needsEvidence: "needs_evidence",
  hasTargetDate: "has_target_date",
} as const satisfies ExternalNameMap<typeof BeginSignalsSchema>;
const beginSignalsExternal = externalizeObjectSchema(BeginSignalsSchema, beginSignalNames);

const beginNames = {
  operationId: "op_id",
  cwd: "cwd",
  projectCode: "project_code",
  title: "title",
  mode: "mode",
  agentId: "agent_id",
  displayName: "display_name",
  clientKind: "client_kind",
  threadId: "thread_id",
  parentSessionId: "parent_session_id",
  resume: "resume",
  predecessorSessionId: "predecessor_session_id",
  maxChars: "max_chars",
  role: "role",
  signals: "signals",
  allowProjectCreate: "allow_project_create",
  creationReason: "creation_reason",
} as const satisfies ExternalNameMap<typeof BeginInputSchema>;
export const beginExternal = externalizeObjectSchema(BeginInputSchema, beginNames, {
  signals: {
    schema: beginSignalsExternal.inputSchema.default({}),
    decode: (value) => beginSignalsExternal.parse(value),
  },
});
const beginFields = beginExternal.inputSchema.shape;
export const beginToolInput = z
  .object({
    op_id: beginFields.op_id!,
    cwd: beginFields.cwd!,
    project_code: beginFields.project_code!,
    title: beginFields.title!,
    mode: beginFields.mode!,
    agent_id: beginFields.agent_id!,
    display_name: beginFields.display_name!,
    client_kind: beginFields.client_kind!,
    thread_id: beginFields.thread_id!,
    parent_session_id: beginFields.parent_session_id!,
    resume: beginFields.resume!,
    brief: z.enum(["none", "minimal", "full"]).default("full"),
    max_chars: beginFields.max_chars!,
    predecessor_session_id: beginFields.predecessor_session_id!,
    role: beginFields.role!,
    signals: beginFields.signals!,
    allow_project_create: beginFields.allow_project_create!,
    creation_reason: beginFields.creation_reason!,
  })
  .strict();

const checklistCreateNames = {
  title: "title",
  evidenceRequired: "evidence_required",
  weight: "weight",
} as const satisfies ExternalNameMap<typeof ChecklistCreateInputSchema>;
const checklistCreateExternal = externalizeObjectSchema(
  ChecklistCreateInputSchema,
  checklistCreateNames,
);

const workItemCreateNames = {
  clientRef: "client_ref",
  objectiveId: "objective_id",
  milestoneId: "milestone_id",
  parentKey: "parent_key",
  parentRef: "parent_ref",
  dependsOn: "depends_on",
  dependsOnRefs: "depends_on_refs",
  discoveredFrom: "discovered_from",
  discoveredFromRef: "discovered_from_ref",
  title: "title",
  description: "description",
  type: "type",
  priority: "priority",
  status: "status",
  acceptance: "acceptance",
  checklist: "checklist",
  weight: "weight",
  targetDate: "target_date",
  verificationRequired: "verification_required",
  assigneeAgentId: "assignee_agent_id",
} as const satisfies ExternalNameMap<typeof WorkItemCreateInputSchema>;
const workItemCreateExternal = externalizeObjectSchema(
  WorkItemCreateInputSchema,
  workItemCreateNames,
  {
    checklist: {
      schema: z.array(checklistCreateExternal.inputSchema).max(100).default([]),
      decode: (value) =>
        (value as unknown[]).map((checklistItem) => checklistCreateExternal.parse(checklistItem)),
    },
  },
);

const taskCreateNames = {
  project: "project",
  session: "session",
  opId: "op_id",
  items: "items",
} as const satisfies ExternalNameMap<typeof TaskCreateBatchInputSchema>;
export const taskCreateExternal = externalizeObjectSchema(
  TaskCreateBatchInputSchema,
  taskCreateNames,
  {
    items: {
      schema: z.array(workItemCreateExternal.inputSchema).min(1).max(50),
      decode: (value) =>
        (value as unknown[]).map((workItem) => workItemCreateExternal.parse(workItem)),
    },
  },
);

const workItemExpectedFieldsExternal = externalizeObjectSchema(WorkItemExpectedFieldsSchema, {
  title: "title",
  description: "description",
  acceptance: "acceptance",
  targetDate: "target_date",
  parentKey: "parent_key",
} as const);
const reviewCandidateHashMap = z
  .record(ReviewCandidateHashSchema.shape.name, ReviewCandidateHashSchema.shape.value)
  .superRefine((hashes, context) => {
    const count = Object.keys(hashes).length;
    if (count < 1 || count > 20) {
      context.addIssue({
        code: "custom",
        message: "candidate_hashes 需要 1 到 20 项",
      });
    }
  });
const checklistBatchItemExternal = externalizeObjectSchema(ChecklistBatchItemInputSchema, {
  checklistId: "id",
  status: "status",
  evidence: "evidence",
} as const);

const taskPatchExternalNames = {
  taskKey: "task_key",
  expectedVersion: "expected_version",
  takeoverStale: "takeover_stale",
  operation: "operation",
  expectedFields: "expected_fields",
  title: "title",
  description: "description",
  acceptance: "acceptance",
  blockedReason: "blocked_reason",
  waitingFor: "waiting_for",
  cancelReason: "cancel_reason",
  duplicateOf: "duplicate_of",
  supersededBy: "superseded_by",
  assigneeAgentId: "assignee_agent_id",
  targetDate: "target_date",
  parentKey: "parent_key",
  parentChecklistId: "parent_checklist_id",
  expectedParentChecklistVersion: "expected_parent_checklist_version",
  requestKey: "request_key",
  candidateHashes: "candidate_hashes",
  verdict: "verdict",
  evidence: "evidence",
  checklistItems: "checklist_items",
} as const;

const taskPatchFieldAdapters = {
  expectedFields: {
    schema: workItemExpectedFieldsExternal.inputSchema.optional(),
    decode: (value: unknown) => workItemExpectedFieldsExternal.parse(value),
  },
  candidateHashes: {
    schema: reviewCandidateHashMap,
    decode: (value: unknown) =>
      Object.entries(value as Record<string, string>).map(([name, hash]) => ({
        name,
        value: hash,
      })),
  },
  checklistItems: {
    schema: z.array(checklistBatchItemExternal.inputSchema).min(1).max(100),
    decode: (value: unknown) =>
      (value as unknown[]).map((item) => checklistBatchItemExternal.parse(item)),
  },
} as const;

const taskPatchExternalAdapters = Object.fromEntries(
  TASK_PATCH_OPERATION_NAMES.map((operation) => {
    const definition = TaskPatchOperations[operation];
    const fieldAdapters =
      operation === "checklist_single"
        ? {
            ...taskPatchFieldAdapters,
            checklistItems: {
              ...taskPatchFieldAdapters.checklistItems,
              schema: z.array(checklistBatchItemExternal.inputSchema).length(1),
            },
          }
        : taskPatchFieldAdapters;
    return [
      operation,
      externalizeObjectSchema(
        definition.schema as z.ZodObject<z.ZodRawShape>,
        taskPatchExternalNames as any,
        fieldAdapters as any,
      ),
    ];
  }),
) as Record<
  TaskPatchOperation,
  ReturnType<typeof externalizeObjectSchema<z.ZodObject<z.ZodRawShape>, any>>
>;

const coreTaskPatchOperations = TASK_PATCH_OPERATION_NAMES.filter(
  (operation) => TaskPatchOperations[operation].batchable,
);
const compositeTaskPatchOperations = TASK_PATCH_OPERATION_NAMES.filter(
  (operation) => !TaskPatchOperations[operation].batchable,
);
const coreWorkItemPatch = z.discriminatedUnion(
  "operation",
  coreTaskPatchOperations.map(
    (operation) => taskPatchExternalAdapters[operation].inputSchema,
  ) as any,
);
const compositeWorkItemPatch = z.discriminatedUnion(
  "operation",
  compositeTaskPatchOperations.map(
    (operation) => taskPatchExternalAdapters[operation].inputSchema,
  ) as any,
);
const workItemPatch = z.discriminatedUnion(
  "operation",
  TASK_PATCH_OPERATION_NAMES.map(
    (operation) => taskPatchExternalAdapters[operation].inputSchema,
  ) as any,
);

export function canonicalTaskPatchItem(value: unknown): TaskPatchItem {
  const parsed = workItemPatch.parse(value) as Record<string, unknown> & {
    operation: TaskPatchOperation;
  };
  return taskPatchExternalAdapters[parsed.operation].parse(parsed) as TaskPatchItem;
}

export const taskPatchToolInput = z
  .object({
    project: projectCode,
    session: sessionId,
    op_id: opId,
    items: z.union([
      z.array(coreWorkItemPatch).min(1).max(50),
      z.array(compositeWorkItemPatch).length(1),
    ]),
  })
  .strict();

export const progressCompleted = z.union([
  z.string().max(500),
  z
    .object({
      text: z.string().trim().min(1).max(500),
      work_item_key: taskKey.optional(),
    })
    .strict(),
]);
