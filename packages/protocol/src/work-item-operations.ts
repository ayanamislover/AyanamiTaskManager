import { AtmError } from "@ayanami-task/errors";
import type { WorkItemPhase, WorkItemStatus } from "./work-item.js";

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
  readonly ui: {
    readonly label: string;
    readonly labelByStatus?: Partial<Record<WorkItemStatus, string>>;
    readonly visibleFrom: readonly WorkItemStatus[];
    readonly requiresStaleClaim?: boolean;
  };
};

export const WORK_ITEM_STATUS_LABELS = {
  BACKLOG: "待整理",
  READY: "可开始",
  CLAIMED: "已领取",
  IN_PROGRESS: "进行中",
  BLOCKED: "已阻塞",
  WAITING_USER: "等待用户",
  WAITING_AGENT: "等待 Agent",
  VERIFYING: "验收中",
  DONE: "已完成",
  CANCELLED: "已取消",
} as const satisfies Record<WorkItemStatus, string>;

export const WORK_ITEM_OPERATION_TABLE_BEGIN = "<!-- WORK_ITEM_OPERATIONS:BEGIN -->";
export const WORK_ITEM_OPERATION_TABLE_END = "<!-- WORK_ITEM_OPERATIONS:END -->";

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
    ui: { label: "领取", visibleFrom: [] },
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
    ui: { label: "开始", visibleFrom: ["BACKLOG", "READY"] },
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
    ui: {
      label: "释放过期领取",
      visibleFrom: ["CLAIMED", "IN_PROGRESS"],
      requiresStaleClaim: true,
    },
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
    ui: { label: "阻塞", visibleFrom: ["IN_PROGRESS"] },
  },
  wait_agent: {
    allowedFrom: ["IN_PROGRESS", "VERIFYING", "WAITING_AGENT"],
    homomorphicFrom: ["WAITING_AGENT"],
    resolveTarget: fixedTarget("WAITING_AGENT"),
    preconditions: ["WAITING_FOR"],
    effects: ["SET_WAITING", "SESSION_WAITING"],
    ui: { label: "等待 Agent", visibleFrom: ["IN_PROGRESS"] },
  },
  wait_user: {
    allowedFrom: ["IN_PROGRESS", "VERIFYING", "WAITING_USER"],
    homomorphicFrom: ["WAITING_USER"],
    resolveTarget: fixedTarget("WAITING_USER"),
    preconditions: ["WAITING_FOR"],
    effects: ["SET_WAITING", "SESSION_WAITING"],
    ui: { label: "等待用户", visibleFrom: ["IN_PROGRESS"] },
  },
  verify: {
    allowedFrom: ["IN_PROGRESS", "WAITING_AGENT", "WAITING_USER", "VERIFYING"],
    homomorphicFrom: ["VERIFYING"],
    resolveTarget: fixedTarget("VERIFYING"),
    preconditions: [],
    effects: ["CLEAR_WAITING", "REFRESH_GIT_CONTEXT", "SESSION_WORKING"],
    ui: { label: "提交验收", visibleFrom: ["IN_PROGRESS"] },
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
    ui: { label: "完成", visibleFrom: ["VERIFYING"] },
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
    ui: {
      label: "取消",
      visibleFrom: [
        "BACKLOG",
        "READY",
        "CLAIMED",
        "IN_PROGRESS",
        "BLOCKED",
        "WAITING_AGENT",
        "WAITING_USER",
      ],
    },
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
    ui: {
      label: "重新打开",
      labelByStatus: { VERIFYING: "退回" },
      visibleFrom: ["BLOCKED", "WAITING_AGENT", "WAITING_USER", "VERIFYING", "DONE", "CANCELLED"],
    },
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
    ui: { label: "编辑", visibleFrom: [] },
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

export function generateWorkItemOperationTable(): string {
  const statuses = Object.keys(WORK_ITEM_STATUS_LABELS) as WorkItemStatus[];
  const statusRows = statuses.map((status) => {
    const operations = legalWorkItemOperations(status)
      .map(({ operation }) => `\`${operation}\``)
      .join(", ");
    return `| \`${status}\` | ${WORK_ITEM_STATUS_LABELS[status]} | ${operations || "-"} |`;
  });
  const operationRows = WORK_ITEM_OPERATION_NAMES.map((operation) => {
    const definition = WorkItemOperations[operation];
    return `| \`${operation}\` | ${definition.ui.label} | ${definition.allowedFrom
      .map((status) => `\`${status}\``)
      .join(", ")} | ${definition.preconditions.join(", ") || "-"} |`;
  });
  return [
    WORK_ITEM_OPERATION_TABLE_BEGIN,
    "",
    "### 状态与操作（自动生成）",
    "",
    "> 本表由 canonical `WorkItemOperations` registry 生成；不要手工维护状态机副本。",
    "",
    "<!-- prettier-ignore -->",
    "| 状态 | 显示名 | 合法操作 |",
    "| --- | --- | --- |",
    ...statusRows,
    "",
    "<!-- prettier-ignore -->",
    "| 操作 | 显示名 | 可进入的当前状态 | 前置条件 |",
    "| --- | --- | --- | --- |",
    ...operationRows,
    "",
    WORK_ITEM_OPERATION_TABLE_END,
  ].join("\n");
}
