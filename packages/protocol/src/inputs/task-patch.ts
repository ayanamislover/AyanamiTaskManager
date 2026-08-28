import { AtmError } from "@ayanami-task/errors";
import { z } from "zod";
import { WORK_ITEM_OPERATION_NAMES } from "../work-item-operations.js";
import { NonEmptyTextSchema, NullableDateOnlySchema, OpIdSchema } from "../schema-primitives.js";
import {
  EvidenceInputSchema,
  ReviewCandidateHashesSchema,
  ReviewRequestCreateInputSchema,
  ReviewSubmitInputSchema,
} from "./planning.js";

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
    .object({ ...workItemPatchIdentityShape, operation: z.literal(operation), ...fields })
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
  block: coreWorkItemPatchSchema("block", { blockedReason: z.string().trim().min(1).max(2000) }),
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
    .object({ ...compositeWorkItemPatchIdentityShape, operation: z.literal("verify_and_complete") })
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
      if (reason.code === "EVIDENCE_REQUIRED") return `evidence required (${reason.checklist_id})`;
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
export type ChecklistBatchUpdateInput = z.infer<typeof ChecklistBatchUpdateInputSchema>;
export type VerifyAndCompleteInput = z.infer<typeof VerifyAndCompleteInputSchema>;
