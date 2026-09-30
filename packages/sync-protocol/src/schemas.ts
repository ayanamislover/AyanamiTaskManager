import { z } from "zod";

import {
  COMMAND_ID_PATTERN,
  DEVICE_ID_PATTERN,
  PROJECT_CODE_PATTERN,
  PROJECT_HASH_PATTERN,
  TASK_KEY_PATTERN,
} from "./keys.js";

// 解密后的明文结构。未知字段一律丢弃（向前兼容），已知字段严格校验。

const timestamp = z.string().min(1).max(64);
const shortText = (max: number) => z.string().max(max);

export const TASK_STATUSES = [
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
export const TASK_PRIORITIES = ["LOW", "NORMAL", "HIGH", "CRITICAL"] as const;
export const TASK_TYPES = ["EPIC", "TASK", "SUBTASK", "BUG", "RESEARCH", "REVIEW"] as const;
export const DISPATCH_STATES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export const PERMISSION_MODES = ["auto", "acceptEdits", "bypassPermissions", "plan"] as const;

export const TaskCardSchema = z.object({
  key: z.string().regex(TASK_KEY_PATTERN),
  title: shortText(500),
  type: z.enum(TASK_TYPES),
  status: z.enum(TASK_STATUSES),
  priority: z.enum(TASK_PRIORITIES),
  progress: z.number().min(0).max(100),
  parent: z.string().regex(TASK_KEY_PATTERN).optional(),
  updatedAt: timestamp,
  claim: z.object({ agent: shortText(128), since: timestamp.optional() }).optional(),
  waiting: shortText(500).optional(),
  blocked: shortText(500).optional(),
  desc: shortText(2000).optional(),
  acceptance: z.array(shortText(500)).max(12).optional(),
  checklist: z.object({ done: z.number().int().min(0), total: z.number().int().min(0) }).optional(),
  recent: z
    .array(
      z.object({
        at: timestamp,
        summary: shortText(500),
        percent: z.number().min(0).max(100).optional(),
      }),
    )
    .max(3)
    .optional(),
  dispatch: z
    .object({
      state: z.enum(DISPATCH_STATES),
      at: timestamp,
      run: shortText(64),
      /** 失败时给用户看的一句原因（中文，可操作），例如「Claude Code 未登录…」。 */
      error: shortText(200).optional(),
    })
    .optional(),
});
export type TaskCard = z.infer<typeof TaskCardSchema>;

export const ProjectCountsSchema = z.object({
  active: z.number().int().min(0),
  ready: z.number().int().min(0),
  inProgress: z.number().int().min(0),
  blocked: z.number().int().min(0),
  waitingUser: z.number().int().min(0),
  doneRecent: z.number().int().min(0),
});
export type ProjectCounts = z.infer<typeof ProjectCountsSchema>;

export const ProjectHeadSchema = z.object({
  code: z.string().regex(PROJECT_CODE_PATTERN),
  name: shortText(200),
  h: z.string().regex(PROJECT_HASH_PATTERN),
  d: z.string().min(1).max(64),
  counts: ProjectCountsSchema,
  updatedAt: timestamp,
});
export type ProjectHead = z.infer<typeof ProjectHeadSchema>;

export const HeadDocSchema = z.object({
  v: z.literal(1),
  host: z.object({
    id: z.string().regex(DEVICE_ID_PATTERN),
    name: shortText(64),
    app: shortText(32),
  }),
  at: timestamp,
  dispatch: z.object({
    enabled: z.boolean(),
    mode: z.enum(PERMISSION_MODES),
    running: z.number().int().min(0),
  }),
  projects: z.array(ProjectHeadSchema).max(500),
});
export type HeadDoc = z.infer<typeof HeadDocSchema>;

export const ProjectDocSchema = z.object({
  v: z.literal(1),
  code: z.string().regex(PROJECT_CODE_PATTERN),
  name: shortText(200),
  at: timestamp,
  tasks: z.array(TaskCardSchema).max(5000),
});
export type ProjectDoc = z.infer<typeof ProjectDocSchema>;

const deviceRef = z.object({ id: z.string().regex(DEVICE_ID_PATTERN), name: shortText(64) });

export const TaskCreateBodySchema = z.object({
  project: z.string().regex(PROJECT_CODE_PATTERN),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(8000).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  dispatch: z.boolean().optional(),
});
export type TaskCreateBody = z.infer<typeof TaskCreateBodySchema>;

export const TaskDispatchBodySchema = z.object({
  project: z.string().regex(PROJECT_CODE_PATTERN),
  key: z.string().regex(TASK_KEY_PATTERN),
});
export type TaskDispatchBody = z.infer<typeof TaskDispatchBodySchema>;

const commandBase = {
  v: z.literal(1),
  id: z.string().regex(COMMAND_ID_PATTERN),
  device: deviceRef,
  at: timestamp,
};

export const CommandDocSchema = z.discriminatedUnion("type", [
  z.object({ ...commandBase, type: z.literal("task.create"), body: TaskCreateBodySchema }),
  z.object({ ...commandBase, type: z.literal("task.dispatch"), body: TaskDispatchBodySchema }),
]);
export type CommandDoc = z.infer<typeof CommandDocSchema>;
export type CommandInput =
  | { type: "task.create"; body: TaskCreateBody }
  | { type: "task.dispatch"; body: TaskDispatchBody };

export const AckResultSchema = z.object({
  project: z.string().regex(PROJECT_CODE_PATTERN),
  key: z.string().regex(TASK_KEY_PATTERN),
  dispatch: z.object({ run: shortText(64), state: z.enum(DISPATCH_STATES) }).optional(),
  /** 派单被拒时任务仍已创建，这里给出原因。 */
  dispatchError: z.object({ code: shortText(64), message: shortText(500) }).optional(),
});

export const AckDocSchema = z.discriminatedUnion("ok", [
  z.object({
    v: z.literal(1),
    id: z.string().regex(COMMAND_ID_PATTERN),
    at: timestamp,
    ok: z.literal(true),
    result: AckResultSchema,
  }),
  z.object({
    v: z.literal(1),
    id: z.string().regex(COMMAND_ID_PATTERN),
    at: timestamp,
    ok: z.literal(false),
    error: z.object({ code: shortText(64), message: shortText(500) }),
  }),
]);
export type AckDoc = z.infer<typeof AckDocSchema>;

export const DeviceDocSchema = z.object({
  v: z.literal(1),
  id: z.string().regex(DEVICE_ID_PATTERN),
  name: shortText(64),
  kind: z.enum(["windows", "android", "other"]),
  role: z.enum(["host", "client"]),
  app: shortText(32),
  at: timestamp,
  state: z.enum(["online", "offline"]),
});
export type DeviceDoc = z.infer<typeof DeviceDocSchema>;

/** 手机判定「电脑在线」的窗口。电脑每 5 分钟写一次在线状态。 */
export const HOST_ONLINE_WINDOW_MS = 7 * 60 * 1000;
/** 早于这个时间的命令直接拒绝。 */
export const COMMAND_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
