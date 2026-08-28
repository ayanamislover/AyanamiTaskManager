import type { AyanamiTaskService } from "@ayanami-task/application";
import { AtmError } from "@ayanami-task/errors";
import type { WorkItemPatchInput } from "@ayanami-task/protocol";

type RepositoryPatchInput = Parameters<AyanamiTaskService["patchWorkItems"]>[3][number];
type OptionalPatchFields = Partial<{
  expectedFields: {
    title?: string;
    description?: string;
    acceptance?: string[];
    targetDate?: string | null;
    parentKey?: string | null;
  };
  title: string;
  description: string;
  acceptance: string[];
  blockedReason: string;
  waitingFor: string;
  cancelReason: string;
  duplicateOf: string;
  supersededBy: string;
  assigneeAgentId: string;
  targetDate: string | null;
  parentKey: string | null;
}>;

export function repositoryPatchInput(item: WorkItemPatchInput): RepositoryPatchInput {
  const fields = item as WorkItemPatchInput & OptionalPatchFields;
  return {
    taskKey: item.taskKey,
    expectedVersion: item.expectedVersion,
    ...(fields.expectedFields === undefined ? {} : { expectedFields: fields.expectedFields }),
    operation: item.operation,
    takeoverStale: item.takeoverStale,
    ...(fields.title === undefined ? {} : { title: fields.title }),
    ...(fields.description === undefined ? {} : { description: fields.description }),
    ...(fields.acceptance === undefined ? {} : { acceptance: fields.acceptance }),
    ...(fields.blockedReason === undefined ? {} : { blockedReason: fields.blockedReason }),
    ...(fields.waitingFor === undefined ? {} : { waitingFor: fields.waitingFor }),
    ...(fields.cancelReason === undefined ? {} : { cancelReason: fields.cancelReason }),
    ...(fields.duplicateOf === undefined ? {} : { duplicateOf: fields.duplicateOf }),
    ...(fields.supersededBy === undefined ? {} : { supersededBy: fields.supersededBy }),
    ...(fields.assigneeAgentId === undefined ? {} : { assigneeAgentId: fields.assigneeAgentId }),
    ...(fields.targetDate === undefined ? {} : { targetDate: fields.targetDate }),
    ...(fields.parentKey === undefined ? {} : { parentKey: fields.parentKey }),
  };
}

export function completedEntryText(entry: string | { text: string }): string {
  return typeof entry === "string" ? entry : entry.text;
}

export function completedEntryForProject(
  entry: string | { text: string; workItemKey?: string | undefined },
): string | { text: string; workItemKey?: string } {
  if (typeof entry === "string") return entry;
  return {
    text: entry.text,
    ...(entry.workItemKey === undefined ? {} : { workItemKey: entry.workItemKey }),
  };
}

export function requestOpId(body: Record<string, unknown>): string {
  if (typeof body.opId !== "string" || !body.opId.trim() || body.opId.length > 128) {
    throw new AtmError("VALIDATION_ERROR", { message: "opId 必填且不超过 128 字符" });
  }
  return body.opId.trim();
}
