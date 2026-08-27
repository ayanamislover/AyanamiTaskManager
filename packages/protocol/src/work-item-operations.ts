import { AtmError } from "@ayanami-task/errors";
import type { WorkItemPhase, WorkItemStatus } from "./index.js";

export type WorkItemOperationPrecondition =
  | "DEPENDENCIES_READY"
  | "CLAIM_AVAILABLE"
  | "SAME_ASSIGNEE_WHEN_RUNNING"
  | "CLAIM_OWNER"
  | "BLOCKED_REASON"
  | "WAITING_FOR"
  | "COMPLETION_GATE"
  | "CANCEL_REFERENCES";

export type WorkItemOperationEffect =
  | "ASSIGN_CLAIM"
  | "CLEAR_CLAIM"
  | "CLEAR_WAITING"
  | "RESOLVE_BLOCKERS"
  | "SET_BLOCKER"
  | "SET_WAITING"
  | "REFRESH_GIT_CONTEXT"
  | "ESTABLISH_ENGINEERING_BASELINE"
  | "CAPTURE_ENGINEERING_METRICS"
  | "SESSION_WORKING"
  | "SESSION_WAITING"
  | "SESSION_IDLE";

export type WorkItemOperationContext = {
  readonly currentStatus: WorkItemStatus;
  readonly phase: WorkItemPhase;
  readonly successorReclaim?: boolean;
};

export type WorkItemOperationDefinition = {
  readonly allowedFrom: readonly WorkItemStatus[];
  readonly homomorphicFrom: readonly WorkItemStatus[];
  readonly resolveTarget: (context: WorkItemOperationContext) => WorkItemStatus;
  readonly preconditions: readonly WorkItemOperationPrecondition[];
  readonly effects: readonly WorkItemOperationEffect[];
};

const fixedTarget =
  (target: WorkItemStatus) =>
  (_context: WorkItemOperationContext): WorkItemStatus =>
    target;

/** The sole source of truth for WorkItem operation semantics. */
export const WorkItemOperations = {
  claim: {
    allowedFrom: ["BACKLOG", "READY", "CLAIMED", "IN_PROGRESS"],
    homomorphicFrom: ["CLAIMED", "IN_PROGRESS"],
    resolveTarget: ({ currentStatus }) =>
      currentStatus === "IN_PROGRESS" ? "IN_PROGRESS" : "CLAIMED",
    preconditions: ["DEPENDENCIES_READY", "CLAIM_AVAILABLE", "SAME_ASSIGNEE_WHEN_RUNNING"],
    effects: ["ASSIGN_CLAIM", "ESTABLISH_ENGINEERING_BASELINE", "SESSION_WORKING"],
  },
  start: {
    allowedFrom: [
      "BACKLOG",
      "READY",
      "CLAIMED",
      "IN_PROGRESS",
      "BLOCKED",
      "WAITING_AGENT",
      "WAITING_USER",
      "VERIFYING",
    ],
    homomorphicFrom: ["IN_PROGRESS"],
    resolveTarget: fixedTarget("IN_PROGRESS"),
    preconditions: ["DEPENDENCIES_READY", "CLAIM_AVAILABLE"],
    effects: [
      "ASSIGN_CLAIM",
      "CLEAR_WAITING",
      "RESOLVE_BLOCKERS",
      "ESTABLISH_ENGINEERING_BASELINE",
      "SESSION_WORKING",
    ],
  },
  release: {
    allowedFrom: [
      "CLAIMED",
      "IN_PROGRESS",
      "BLOCKED",
      "WAITING_AGENT",
      "WAITING_USER",
      "VERIFYING",
    ],
    homomorphicFrom: [],
    resolveTarget: fixedTarget("READY"),
    preconditions: ["CLAIM_OWNER"],
    effects: ["CLEAR_CLAIM", "CLEAR_WAITING", "SESSION_IDLE"],
  },
  block: {
    allowedFrom: [
      "CLAIMED",
      "IN_PROGRESS",
      "BLOCKED",
      "WAITING_AGENT",
      "WAITING_USER",
      "VERIFYING",
    ],
    homomorphicFrom: ["BLOCKED"],
    resolveTarget: fixedTarget("BLOCKED"),
    preconditions: ["BLOCKED_REASON"],
    effects: ["SET_BLOCKER", "CLEAR_WAITING", "SESSION_WAITING"],
  },
  wait_agent: {
    allowedFrom: ["IN_PROGRESS", "VERIFYING", "WAITING_AGENT"],
    homomorphicFrom: ["WAITING_AGENT"],
    resolveTarget: fixedTarget("WAITING_AGENT"),
    preconditions: ["WAITING_FOR"],
    effects: ["SET_WAITING", "SESSION_WAITING"],
  },
  wait_user: {
    allowedFrom: ["IN_PROGRESS", "VERIFYING", "WAITING_USER"],
    homomorphicFrom: ["WAITING_USER"],
    resolveTarget: fixedTarget("WAITING_USER"),
    preconditions: ["WAITING_FOR"],
    effects: ["SET_WAITING", "SESSION_WAITING"],
  },
  verify: {
    allowedFrom: ["IN_PROGRESS", "WAITING_AGENT", "WAITING_USER", "VERIFYING"],
    homomorphicFrom: ["VERIFYING"],
    resolveTarget: fixedTarget("VERIFYING"),
    preconditions: [],
    effects: ["CLEAR_WAITING", "REFRESH_GIT_CONTEXT", "SESSION_WORKING"],
  },
  complete: {
    allowedFrom: [
      "BACKLOG",
      "READY",
      "CLAIMED",
      "IN_PROGRESS",
      "BLOCKED",
      "WAITING_AGENT",
      "WAITING_USER",
      "VERIFYING",
    ],
    homomorphicFrom: [],
    resolveTarget: fixedTarget("DONE"),
    preconditions: ["COMPLETION_GATE"],
    effects: [
      "CLEAR_WAITING",
      "REFRESH_GIT_CONTEXT",
      "CAPTURE_ENGINEERING_METRICS",
      "SESSION_IDLE",
    ],
  },
  cancel: {
    allowedFrom: [
      "BACKLOG",
      "READY",
      "CLAIMED",
      "IN_PROGRESS",
      "BLOCKED",
      "WAITING_AGENT",
      "WAITING_USER",
      "VERIFYING",
    ],
    homomorphicFrom: [],
    resolveTarget: fixedTarget("CANCELLED"),
    preconditions: ["CANCEL_REFERENCES"],
    effects: ["CLEAR_WAITING", "CAPTURE_ENGINEERING_METRICS", "SESSION_IDLE"],
  },
  reopen: {
    allowedFrom: ["BLOCKED", "WAITING_AGENT", "WAITING_USER", "VERIFYING", "DONE", "CANCELLED"],
    homomorphicFrom: [],
    resolveTarget: ({ currentStatus, phase }) => {
      if (currentStatus === "CANCELLED") return "BACKLOG";
      if (currentStatus === "WAITING_AGENT" || currentStatus === "WAITING_USER") {
        return phase === "VERIFYING" ? "VERIFYING" : "IN_PROGRESS";
      }
      return "IN_PROGRESS";
    },
    preconditions: [],
    effects: ["CLEAR_WAITING", "RESOLVE_BLOCKERS", "SESSION_WORKING"],
  },
  edit: {
    allowedFrom: [
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
    ],
    homomorphicFrom: [
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
    ],
    resolveTarget: ({ currentStatus }) => currentStatus,
    preconditions: [],
    effects: [],
  },
} as const satisfies Record<string, WorkItemOperationDefinition>;

export type WorkItemOperation = keyof typeof WorkItemOperations;
export const WORK_ITEM_OPERATION_NAMES = Object.keys(WorkItemOperations) as [
  WorkItemOperation,
  ...WorkItemOperation[],
];

export type ResolvedWorkItemOperation = {
  readonly operation: WorkItemOperation;
  readonly target: WorkItemStatus;
  readonly definition: WorkItemOperationDefinition;
};

export function resolveWorkItemOperation(
  operation: WorkItemOperation,
  context: WorkItemOperationContext,
): ResolvedWorkItemOperation {
  const definition: WorkItemOperationDefinition = WorkItemOperations[operation];
  const target = definition.resolveTarget(context);
  const allowed =
    definition.allowedFrom.includes(context.currentStatus) &&
    !(
      operation === "claim" &&
      context.currentStatus === "IN_PROGRESS" &&
      !context.successorReclaim
    );
  const homomorphic = target === context.currentStatus;
  if (!allowed || (homomorphic && !definition.homomorphicFrom.includes(context.currentStatus))) {
    throw new AtmError("INVALID_TRANSITION", {
      message: `操作 ${operation} 不能用于状态 ${context.currentStatus}`,
      details: {
        operation,
        current_status: context.currentStatus,
        requested_status: target,
        legal_operations: legalWorkItemOperations(context.currentStatus, context.phase).map(
          (entry) => entry.operation,
        ),
      },
    });
  }
  return { operation, target, definition };
}

export function legalWorkItemOperations(
  status: WorkItemStatus,
  phase: WorkItemPhase = status === "WAITING_AGENT" || status === "WAITING_USER"
    ? "IN_PROGRESS"
    : status,
): ReadonlyArray<{ operation: WorkItemOperation; target: WorkItemStatus }> {
  const context = { currentStatus: status, phase };
  return (
    Object.entries(WorkItemOperations) as Array<[WorkItemOperation, WorkItemOperationDefinition]>
  ).flatMap(([operation, definition]) => {
    if (!definition.allowedFrom.includes(status)) return [];
    if (operation === "claim" && status === "IN_PROGRESS") return [];
    const target = definition.resolveTarget(context);
    if (target === status && !definition.homomorphicFrom.includes(status)) return [];
    return [{ operation, target }];
  });
}

export function workItemOperationHasEffect(
  operation: WorkItemOperation,
  effect: WorkItemOperationEffect,
): boolean {
  const effects: readonly WorkItemOperationEffect[] = WorkItemOperations[operation].effects;
  return effects.includes(effect);
}
