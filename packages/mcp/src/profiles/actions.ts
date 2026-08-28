import type { AyanamiTaskService } from "@ayanami-task/application";
import { AtmError } from "@ayanami-task/errors";
import type { TaskPatchOperation } from "@ayanami-task/protocol";
import { mutationAck, withMcpErrorDetails, wrap } from "../result.js";
import type { DefineProfileTool } from "./registrar.js";
import { canonicalTaskPatchItem, outputSchema, taskPatchToolInput } from "./schemas.js";

export function registerActionTools(
  service: AyanamiTaskService,
  defineTool: DefineProfileTool,
): void {
  defineTool(
    "actions",
    "atm_task_patch",
    {
      description: "批量变更任务。",
      inputSchema: taskPatchToolInput,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (input) => {
      const operation = input.items[0]!.operation as TaskPatchOperation;
      if (operation === "review_request") {
        const item = canonicalTaskPatchItem(input.items[0]) as Extract<
          ReturnType<typeof canonicalTaskPatchItem>,
          { operation: "review_request" }
        >;
        const created = await withMcpErrorDetails(
          service,
          {
            project: input.project,
            taskKey: item.taskKey,
            checklistId: item.parentChecklistId,
            expectedVersion: item.expectedParentChecklistVersion,
            expectedVersions: { [item.taskKey]: item.expectedVersion },
          },
          () =>
            service.createReviewRequest(input.project, input.session, input.op_id, {
              reviewTaskKey: item.taskKey,
              expectedReviewTaskVersion: item.expectedVersion,
              parentChecklistId: item.parentChecklistId,
              expectedParentChecklistVersion: item.expectedParentChecklistVersion,
              expectedCandidateHashes: item.candidateHashes,
            }),
        );
        return wrap(
          mutationAck(
            input.project,
            input.session,
            input.op_id,
            "review.request.create",
            created as unknown as Record<string, unknown>,
          ),
        );
      }
      if (operation === "review_submit") {
        const item = canonicalTaskPatchItem(input.items[0]) as Extract<
          ReturnType<typeof canonicalTaskPatchItem>,
          { operation: "review_submit" }
        >;
        const request = await service.getReviewRequest(input.project, item.requestKey);
        if (request.reviewTaskKey !== item.taskKey) {
          throw new AtmError("REVIEW_BINDING_MISMATCH", {
            message: `Review 绑定不匹配：${item.taskKey}`,
            details: { task_key: item.taskKey },
          });
        }
        const submitted = await withMcpErrorDetails(
          service,
          {
            project: input.project,
            taskKey: item.taskKey,
            checklistId: request.parentChecklistId,
            expectedVersion: request.parentChecklistVersion,
            expectedVersions: { [item.taskKey]: item.expectedVersion },
          },
          () =>
            service.submitReview(input.project, input.session, input.op_id, {
              requestKey: item.requestKey,
              expectedReviewTaskVersion: item.expectedVersion,
              verdict: item.verdict,
              reviewedHashes: item.candidateHashes,
              evidence: item.evidence,
            }),
        );
        return wrap(
          mutationAck(
            input.project,
            input.session,
            input.op_id,
            "review.submit",
            submitted as unknown as Record<string, unknown>,
          ),
        );
      }
      if (operation === "verify_and_complete") {
        const item = canonicalTaskPatchItem(input.items[0]) as Extract<
          ReturnType<typeof canonicalTaskPatchItem>,
          { operation: "verify_and_complete" }
        >;
        const completed = await withMcpErrorDetails(
          service,
          {
            project: input.project,
            taskKey: item.taskKey,
            expectedVersion: item.expectedVersion,
          },
          () =>
            service.verifyAndComplete(input.project, input.session, input.op_id, {
              taskKey: item.taskKey,
              expectedVersion: item.expectedVersion,
            }),
        );
        return wrap(
          mutationAck(
            input.project,
            input.session,
            input.op_id,
            "work.verify-and-complete",
            completed as unknown as Record<string, unknown>,
          ),
        );
      }
      if (operation === "checklist_batch") {
        const item = canonicalTaskPatchItem(input.items[0]) as Extract<
          ReturnType<typeof canonicalTaskPatchItem>,
          { operation: "checklist_batch" }
        >;
        const updated = await withMcpErrorDetails(
          service,
          {
            project: input.project,
            taskKey: item.taskKey,
            expectedVersion: item.expectedVersion,
          },
          () =>
            service.updateChecklistBatch(input.project, input.session, input.op_id, {
              taskKey: item.taskKey,
              expectedVersion: item.expectedVersion,
              items: item.checklistItems.map((checklistItem) => ({
                checklistId: checklistItem.checklistId,
                status: checklistItem.status,
                ...(checklistItem.evidence === undefined
                  ? {}
                  : { evidence: checklistItem.evidence }),
              })),
            }),
        );
        return wrap(
          mutationAck(
            input.project,
            input.session,
            input.op_id,
            "checklist.update.batch",
            updated as unknown as Record<string, unknown>,
          ),
        );
      }
      if (operation === "checklist_single") {
        const item = canonicalTaskPatchItem(input.items[0]) as Extract<
          ReturnType<typeof canonicalTaskPatchItem>,
          { operation: "checklist_single" }
        >;
        const checklistItem = item.checklistItems[0]!;
        const updated = await withMcpErrorDetails(
          service,
          {
            project: input.project,
            checklistId: checklistItem.checklistId,
            expectedVersion: item.expectedVersion,
          },
          () =>
            service.updateChecklist(input.project, input.session, input.op_id, {
              checklistId: checklistItem.checklistId,
              expectedVersion: item.expectedVersion,
              status: checklistItem.status,
              ...(checklistItem.evidence === undefined ? {} : { evidence: checklistItem.evidence }),
            }),
        );
        return wrap(
          mutationAck(input.project, input.session, input.op_id, "checklist.update", {
            ...(updated as unknown as Record<string, unknown>),
            taskKey: item.taskKey,
          }),
        );
      }
      const conflictItem = input.items[0];
      const patched = await withMcpErrorDetails(
        service,
        {
          project: input.project,
          ...(conflictItem === undefined
            ? {}
            : {
                taskKey: conflictItem.task_key,
                expectedVersion: conflictItem.expected_version,
                expectedVersions: Object.fromEntries(
                  input.items.map((item) => [item.task_key, item.expected_version]),
                ),
              }),
        },
        () =>
          service.patchWorkItems(
            input.project,
            input.session,
            input.op_id,
            input.items.map((item) => canonicalTaskPatchItem(item) as any),
          ),
      );
      return wrap(
        mutationAck(
          input.project,
          input.session,
          input.op_id,
          "work.patch.batch",
          patched as unknown as Record<string, unknown>,
        ),
      );
    },
  );
}
