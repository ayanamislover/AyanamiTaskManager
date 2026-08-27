import {
  WorkItemOperations,
  type WorkItemOperation,
  type WorkItemOperationDefinition,
  type WorkItemStatus,
} from "@ayanami-task/protocol";

export type WorkItemUiActionContext = {
  readonly status: WorkItemStatus;
  readonly actor: string;
  readonly claimOwner: string | null;
  readonly claimStale: boolean;
};

export type WorkItemUiAction = {
  readonly operation: WorkItemOperation;
  readonly label: string;
};

/**
 * UI action availability is a projection of the canonical operation registry.
 * Actor and claim state are explicit so a renderer cannot accidentally make a
 * stale/foreign claim action visible merely from the WorkItem status.
 */
export function workItemUiActions(context: WorkItemUiActionContext): WorkItemUiAction[] {
  return (
    Object.entries(WorkItemOperations) as Array<[WorkItemOperation, WorkItemOperationDefinition]>
  ).flatMap(([operation, definition]) => {
    if (!definition.allowedFrom.includes(context.status)) return [];
    if (!definition.ui.visibleFrom.includes(context.status)) return [];
    if (definition.ui.requiresStaleClaim && !context.claimStale) return [];
    if (
      definition.preconditions.includes("CLAIM_OWNER") &&
      context.actor !== "USER" &&
      context.claimOwner !== context.actor &&
      !context.claimStale
    ) {
      return [];
    }
    return [
      {
        operation,
        label: definition.ui.labelByStatus?.[context.status] ?? definition.ui.label,
      },
    ];
  });
}
