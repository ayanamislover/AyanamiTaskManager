import {
  resolveWorkItemOperation,
  type WorkItemOperation,
  type WorkItemPhase,
  type WorkItemStatus,
} from "@ayanami-task/protocol";

export function storedWorkItemPhase(row: {
  status: WorkItemStatus;
  phase?: WorkItemPhase | null;
}): WorkItemPhase {
  return (row.phase ??
    (row.status === "WAITING_AGENT" || row.status === "WAITING_USER"
      ? "IN_PROGRESS"
      : row.status)) as WorkItemPhase;
}

export function resolveStoredWorkItemOperation(
  operation: WorkItemOperation,
  row: { status: WorkItemStatus; phase?: WorkItemPhase | null },
  options: { successorReclaim?: boolean } = {},
) {
  return resolveWorkItemOperation(operation, {
    currentStatus: row.status,
    phase: storedWorkItemPhase(row),
    ...options,
  });
}
