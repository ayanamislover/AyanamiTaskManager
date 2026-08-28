import { z } from "zod";

export const WORK_ITEM_STATUSES = [
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
] as const;

export const WorkItemStatusSchema = z.enum(WORK_ITEM_STATUSES);
export type WorkItemStatus = z.infer<typeof WorkItemStatusSchema>;

export const WORK_ITEM_PHASES = [
  "BACKLOG",
  "READY",
  "CLAIMED",
  "IN_PROGRESS",
  "BLOCKED",
  "VERIFYING",
  "DONE",
  "CANCELLED",
] as const;
export const WorkItemPhaseSchema = z.enum(WORK_ITEM_PHASES);
export type WorkItemPhase = z.infer<typeof WorkItemPhaseSchema>;

export const WORK_ITEM_WAITING_ON = ["USER", "AGENT"] as const;
export const WorkItemWaitingOnSchema = z.enum(WORK_ITEM_WAITING_ON);
export type WorkItemWaitingOn = z.infer<typeof WorkItemWaitingOnSchema>;

export const WORK_ITEM_TYPES = ["EPIC", "TASK", "SUBTASK", "BUG", "RESEARCH", "REVIEW"] as const;
export const WorkItemTypeSchema = z.enum(WORK_ITEM_TYPES);
export type WorkItemType = z.infer<typeof WorkItemTypeSchema>;

export const PRIORITIES = ["LOW", "NORMAL", "HIGH", "CRITICAL"] as const;
export const PrioritySchema = z.enum(PRIORITIES);
export type Priority = z.infer<typeof PrioritySchema>;

export const WORK_ITEM_STATUS_LABELS: Record<WorkItemStatus, string> = {
  BACKLOG: "待整理",
  READY: "可开始",
  CLAIMED: "已认领",
  IN_PROGRESS: "进行中",
  BLOCKED: "受阻",
  WAITING_AGENT: "等待其他 Agent",
  WAITING_USER: "等待用户",
  VERIFYING: "待验收",
  DONE: "已完成",
  CANCELLED: "已取消",
};

export function workItemStatusLabel(status: WorkItemStatus): string {
  return WORK_ITEM_STATUS_LABELS[status];
}

export const PRIORITY_LABELS: Record<Priority, string> = {
  LOW: "低",
  NORMAL: "普通",
  HIGH: "高",
  CRITICAL: "紧急",
};

export const WORK_ITEM_TYPE_LABELS: Record<WorkItemType, string> = {
  EPIC: "大型事项",
  TASK: "任务",
  SUBTASK: "子任务",
  BUG: "缺陷",
  RESEARCH: "研究",
  REVIEW: "评审",
};
