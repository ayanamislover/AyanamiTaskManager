import { z } from "zod";
import type { WorkItemPhase, WorkItemStatus, WorkItemWaitingOn } from "../index.js";

export const TASK_VIEW_NAMES = ["core", "context", "full"] as const;
export const TaskViewNameSchema = z.enum(TASK_VIEW_NAMES);
export type TaskViewName = z.infer<typeof TaskViewNameSchema>;

export const ProgressSourceSchema = z.enum(["NONE", "CHECKLIST", "CHILDREN", "REPORTED", "STATUS"]);
export type ProgressSource = z.infer<typeof ProgressSourceSchema>;

export const ChecklistSummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    todo: z.number().int().nonnegative(),
    doing: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    evidenceRequired: z.number().int().nonnegative(),
    evidenceMissing: z.number().int().nonnegative(),
  })
  .strict();
export type ChecklistSummary = z.infer<typeof ChecklistSummarySchema>;

export const TaskChecklistViewSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    kind: z.string(),
    status: z.string(),
    weight: z.number(),
    evidenceRequired: z.boolean(),
    evidence: z.array(z.unknown()),
    version: z.number().int().nonnegative(),
  })
  .strict();
export type TaskChecklistView = z.infer<typeof TaskChecklistViewSchema>;

export const TaskRelationViewSchema = z
  .object({
    type: z.enum(["PARENT", "CHILD", "BLOCKS", "RELATES", "DUPLICATES", "DISCOVERED_FROM"]),
    direction: z.enum(["INCOMING", "OUTGOING"]),
    taskKey: z.string(),
  })
  .strict();
export type TaskRelationView = z.infer<typeof TaskRelationViewSchema>;

export const TaskCoreViewSchema = z
  .object({
    key: z.string(),
    status: z.string() as z.ZodType<WorkItemStatus>,
    phase: z.string() as z.ZodType<WorkItemPhase>,
    waitingOn: z.string().nullable() as z.ZodType<WorkItemWaitingOn | null>,
    progress: z.number().min(0).max(100),
    progressSource: ProgressSourceSchema,
    version: z.number().int().nonnegative(),
    updatedAt: z.string(),
  })
  .strict();
export type TaskCoreView = z.infer<typeof TaskCoreViewSchema>;

export const TaskContextViewSchema = TaskCoreViewSchema.extend({
  title: z.string(),
  descriptionPreview: z.string().max(240),
  acceptance: z.array(z.string()),
  checklistSummary: ChecklistSummarySchema,
  assigneeAgentId: z.string().nullable(),
  waitingFor: z.string().nullable(),
  blockedReason: z.string().nullable(),
}).strict();
export type TaskContextView = z.infer<typeof TaskContextViewSchema>;

export const TaskFullViewSchema = TaskContextViewSchema.extend({
  description: z.string(),
  checklist: z.array(TaskChecklistViewSchema),
  relations: z.array(TaskRelationViewSchema),
}).strict();
export type TaskFullView = z.infer<typeof TaskFullViewSchema>;

export type TaskView = TaskCoreView | TaskContextView | TaskFullView;
