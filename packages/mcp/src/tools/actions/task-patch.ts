import type { AyanamiTaskService } from "@ayanami-task/application";
import {
  ChecklistBatchItemInputSchema,
  externalizeObjectSchema,
  ReviewCandidateHashSchema,
  TASK_PATCH_OPERATION_NAMES,
  TaskPatchOperations,
  type TaskPatchItem,
  type TaskPatchOperation,
  WorkItemExpectedFieldsSchema,
} from "@ayanami-task/protocol";
import { z } from "zod";
import { mutationAck, wrap } from "../../result.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { opId, outputSchema, projectCode, sessionId } from "../primitives.js";

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

function canonicalTaskPatchItem(value: unknown): TaskPatchItem {
  const parsed = workItemPatch.parse(value) as Record<string, unknown> & {
    operation: TaskPatchOperation;
  };
  return taskPatchExternalAdapters[parsed.operation].parse(parsed) as TaskPatchItem;
}

const inputSchema = z
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

export function createAtmTaskPatchTool(
  service: AyanamiTaskService,
): ToolDefinition<typeof inputSchema> {
  return {
    profile: "actions",
    name: "atm_task_patch",
    description: "批量变更任务。",
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (input) => {
      const decoded = inputSchema.parse(input);
      const operation = decoded.items[0]!.operation as TaskPatchOperation;
      if (operation === "review_request") {
        const item = canonicalTaskPatchItem(decoded.items[0]) as Extract<
          ReturnType<typeof canonicalTaskPatchItem>,
          { operation: "review_request" }
        >;
        const created = await service.createReviewRequest(
          decoded.project,
          decoded.session,
          decoded.op_id,
          {
            reviewTaskKey: item.taskKey,
            expectedReviewTaskVersion: item.expectedVersion,
            parentChecklistId: item.parentChecklistId,
            expectedParentChecklistVersion: item.expectedParentChecklistVersion,
            expectedCandidateHashes: item.candidateHashes,
          },
        );
        return wrap(
          mutationAck(
            decoded.project,
            decoded.session,
            decoded.op_id,
            "review.request.create",
            created as unknown as Record<string, unknown>,
          ),
        );
      }
      if (operation === "review_submit") {
        const item = canonicalTaskPatchItem(decoded.items[0]) as Extract<
          ReturnType<typeof canonicalTaskPatchItem>,
          { operation: "review_submit" }
        >;
        const submitted = await service.submitReview(
          decoded.project,
          decoded.session,
          decoded.op_id,
          {
            requestKey: item.requestKey,
            reviewTaskKey: item.taskKey,
            expectedReviewTaskVersion: item.expectedVersion,
            verdict: item.verdict,
            reviewedHashes: item.candidateHashes,
            evidence: item.evidence,
          },
        );
        return wrap(
          mutationAck(
            decoded.project,
            decoded.session,
            decoded.op_id,
            "review.submit",
            submitted as unknown as Record<string, unknown>,
          ),
        );
      }
      if (operation === "verify_and_complete") {
        const item = canonicalTaskPatchItem(decoded.items[0]) as Extract<
          ReturnType<typeof canonicalTaskPatchItem>,
          { operation: "verify_and_complete" }
        >;
        const completed = await service.verifyAndComplete(
          decoded.project,
          decoded.session,
          decoded.op_id,
          { taskKey: item.taskKey, expectedVersion: item.expectedVersion },
        );
        return wrap(
          mutationAck(
            decoded.project,
            decoded.session,
            decoded.op_id,
            "work.verify-and-complete",
            completed as unknown as Record<string, unknown>,
          ),
        );
      }
      if (operation === "checklist_batch") {
        const item = canonicalTaskPatchItem(decoded.items[0]) as Extract<
          ReturnType<typeof canonicalTaskPatchItem>,
          { operation: "checklist_batch" }
        >;
        const updated = await service.updateChecklistBatch(
          decoded.project,
          decoded.session,
          decoded.op_id,
          {
            taskKey: item.taskKey,
            expectedVersion: item.expectedVersion,
            items: item.checklistItems.map((checklistItem) => ({
              checklistId: checklistItem.checklistId,
              status: checklistItem.status,
              ...(checklistItem.evidence === undefined ? {} : { evidence: checklistItem.evidence }),
            })),
          },
        );
        return wrap(
          mutationAck(
            decoded.project,
            decoded.session,
            decoded.op_id,
            "checklist.update.batch",
            updated as unknown as Record<string, unknown>,
          ),
        );
      }
      if (operation === "checklist_single") {
        const item = canonicalTaskPatchItem(decoded.items[0]) as Extract<
          ReturnType<typeof canonicalTaskPatchItem>,
          { operation: "checklist_single" }
        >;
        const checklistItem = item.checklistItems[0]!;
        const updated = await service.updateChecklist(
          decoded.project,
          decoded.session,
          decoded.op_id,
          {
            checklistId: checklistItem.checklistId,
            expectedVersion: item.expectedVersion,
            status: checklistItem.status,
            ...(checklistItem.evidence === undefined ? {} : { evidence: checklistItem.evidence }),
          },
        );
        return wrap(
          mutationAck(decoded.project, decoded.session, decoded.op_id, "checklist.update", {
            ...(updated as unknown as Record<string, unknown>),
            taskKey: item.taskKey,
          }),
        );
      }
      const patched = await service.patchWorkItems(
        decoded.project,
        decoded.session,
        decoded.op_id,
        decoded.items.map((item) => canonicalTaskPatchItem(item)) as Parameters<
          AyanamiTaskService["patchWorkItems"]
        >[3],
      );
      return wrap(
        mutationAck(
          decoded.project,
          decoded.session,
          decoded.op_id,
          "work.patch.batch",
          patched as unknown as Record<string, unknown>,
        ),
      );
    },
  };
}
