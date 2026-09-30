import {
  PRIORITY_LABELS,
  WORK_ITEM_STATUS_LABELS,
  WORK_ITEM_TYPE_LABELS,
  type Priority,
  type WorkItemStatus,
  type WorkItemType,
} from "@ayanami-task/protocol";
import type { TaskCard } from "@ayanami-task/sync-protocol";
import type { LocalCommand } from "../data/commands.js";

export function statusLabel(status: string): string {
  return WORK_ITEM_STATUS_LABELS[status as WorkItemStatus] ?? status;
}

export function priorityLabel(priority: string): string {
  return PRIORITY_LABELS[priority as Priority] ?? priority;
}

export function typeLabel(type: string): string {
  return WORK_ITEM_TYPE_LABELS[type as WorkItemType] ?? type;
}

/** 状态 → 桌面端 --atm-st-* 的色调名（语义与桌面端一致）。 */
export type Tone = "progress" | "verify" | "blocked" | "user" | "agent" | "ready" | "done";

export function statusTone(status: string): Tone {
  switch (status) {
    case "IN_PROGRESS":
      return "progress";
    case "VERIFYING":
      return "verify";
    case "BLOCKED":
      return "blocked";
    case "WAITING_USER":
      return "user";
    case "WAITING_AGENT":
      return "agent";
    case "DONE":
      return "done";
    default:
      return "ready";
  }
}

export const DISPATCH_LABELS: Record<NonNullable<TaskCard["dispatch"]>["state"], string> = {
  queued: "排队中",
  running: "运行中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export function dispatchTone(state: NonNullable<TaskCard["dispatch"]>["state"]): Tone {
  switch (state) {
    case "running":
      return "progress";
    case "succeeded":
      return "done";
    case "failed":
      return "blocked";
    case "queued":
      return "agent";
    default:
      return "ready";
  }
}

export const PRIORITY_ORDER: Priority[] = ["LOW", "NORMAL", "HIGH", "CRITICAL"];

/** 为什么这个任务不能「交给 Claude」；可以时返回 null。 */
export function dispatchBlocker(
  task: TaskCard,
  dispatchEnabled: boolean | undefined,
): string | null {
  if (!dispatchEnabled) return "电脑端未开启 Claude 派单，请在电脑 ATM「设置 → Claude 派单」里打开";
  if (task.dispatch && (task.dispatch.state === "queued" || task.dispatch.state === "running")) {
    return "已经交给 Claude 了";
  }
  if (task.status === "DONE" || task.status === "CANCELLED") return "任务已经结束";
  if (task.claim) return `任务已被 ${task.claim.agent} 领取`;
  if (task.status !== "READY" && task.status !== "BACKLOG")
    return "只有待领取的任务可以交给 Claude";
  return null;
}

/**
 * 派单失败时给用户看的原因。回执里的 dispatchError（派单根本没开始，针对的正是这条命令）优先；
 * 其次是任务卡上电脑写的 dispatch.error（跑起来之后失败，只在状态为 failed 时有意义）。都没有返回 null。
 */
export function dispatchFailureReason(
  result: { dispatchError?: { message: string } | undefined } | null | undefined,
  task: Pick<TaskCard, "dispatch"> | null | undefined,
): string | null {
  const fromAck = result?.dispatchError?.message.trim();
  if (fromAck) return fromAck;
  if (task?.dispatch?.state !== "failed") return null;
  return task.dispatch.error?.trim() || null;
}

/**
 * 电脑已经接下这条「交给 Claude」，但快照还没更新到这次派单（任务卡上仍是上一次的 failed 等）。
 * 这段时间里按钮不能再点，否则会连发两次。以回执里的 run 为准：快照出现同一个 run，
 * 或出现了比回执更晚的派单，就算赶上了。回执没带 run 时不拦（无从判断，宁可放行）。
 */
export function dispatchAwaitingSnapshot(
  command: LocalCommand,
  taskKey: string,
  task: Pick<TaskCard, "dispatch"> | null | undefined,
): boolean {
  const { doc, result } = command;
  if (doc.type !== "task.dispatch" || doc.body.key !== taskKey) return false;
  if (command.state !== "created" || !result || result.dispatchError) return false;
  const run = result.dispatch?.run;
  if (!run) return false;
  const current = task?.dispatch;
  if (!current) return true;
  if (current.run === run) return false;
  return !(command.ackAt && Date.parse(current.at) >= Date.parse(command.ackAt));
}

export type CommandView = { tone: Tone | "pending"; title: string; detail: string | null };

/** 本地命令在界面上的样子：等待电脑接收 → 已创建 ATM-T-xxxx → 派单状态。 */
export function describeCommand(command: LocalCommand, task: TaskCard | null): CommandView {
  const { doc } = command;
  const subject = doc.type === "task.create" ? doc.body.title : doc.body.key;
  if (command.state === "pending") {
    return {
      tone: "pending",
      title: command.lastError ? "暂未发出 · 联网后自动重试" : "正在发送…",
      detail: subject,
    };
  }
  if (command.state === "sent") return { tone: "pending", title: "等待电脑接收", detail: subject };
  if (command.state === "failed") {
    return { tone: "blocked", title: "电脑没有接受", detail: command.error?.message ?? "原因未知" };
  }
  const result = command.result;
  const key = result?.key ?? "";
  const dispatch = task?.dispatch ?? (result?.dispatch ? { state: result.dispatch.state } : null);
  if (result?.dispatchError) {
    return {
      tone: "user",
      title: `已创建 ${key}`,
      detail: `派单没有开始：${result.dispatchError.message}`,
    };
  }
  if (dispatch) {
    const reason = dispatch.state === "failed" ? dispatchFailureReason(result, task) : null;
    return {
      tone: dispatchTone(dispatch.state),
      title: doc.type === "task.create" ? `已创建 ${key}` : `${key} 已交给 Claude`,
      detail: reason ? `Claude 运行失败：${reason}` : `Claude ${DISPATCH_LABELS[dispatch.state]}`,
    };
  }
  return { tone: "done", title: `已创建 ${key}`, detail: subject };
}
