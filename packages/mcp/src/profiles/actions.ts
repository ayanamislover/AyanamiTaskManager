import type { AyanamiTaskService } from "@ayanami-task/application";
import type { TaskPatchOperation } from "@ayanami-task/protocol";
import { mutationAck, wrap } from "../result.js";
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
        const created = await service.createReviewRequest(
          input.project,
          input.session,
          input.op_id,
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
        const submitted = await service.submitReview(input.project, input.session, input.op_id, {
          requestKey: item.requestKey,
          reviewTaskKey: item.taskKey,
          expectedReviewTaskVersion: item.expectedVersion,
          verdict: item.verdict,
          reviewedHashes: item.candidateHashes,
          evidence: item.evidence,
        });
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
        const completed = await service.verifyAndComplete(
          input.project,
          input.session,
          input.op_id,
          {
            taskKey: item.taskKey,
            expectedVersion: item.expectedVersion,
          },
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
        const updated = await service.updateChecklistBatch(
          input.project,
          input.session,
          input.op_id,
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
        const updated = await service.updateChecklist(input.project, input.session, input.op_id, {
          checklistId: checklistItem.checklistId,
          expectedVersion: item.expectedVersion,
          status: checklistItem.status,
          ...(checklistItem.evidence === undefined ? {} : { evidence: checklistItem.evidence }),
        });
        return wrap(
          mutationAck(input.project, input.session, input.op_id, "checklist.update", {
            ...(updated as unknown as Record<string, unknown>),
            taskKey: item.taskKey,
          }),
        );
      }
      const patched = await service.patchWorkItems(
        input.project,
        input.session,
        input.op_id,
        input.items.map((item) => canonicalTaskPatchItem(item) as any),
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
