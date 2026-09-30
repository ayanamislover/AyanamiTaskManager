import type { AyanamiTaskService } from "@ayanami-task/application";
import { AtmError } from "@ayanami-task/errors";
import { WorkItemCreateInputSchema } from "@ayanami-task/protocol";
import {
  COMMAND_MAX_AGE_MS,
  commandTimestamp,
  type AckDoc,
  type CommandDoc,
} from "@ayanami-task/sync-protocol";
import type { DispatchPort } from "./dispatch-port.js";
import { ackError, SyncCommandError } from "./errors.js";

// 手机命令（docs/mobile-sync.md §6）：校验 → 以 USER 身份执行 → 生成 ack 结果。

/** 命令 ID 里的时间与 `at` 允许的偏差：两者本来由同一次 `Date.now()` 生成。 */
export const COMMAND_CLOCK_TOLERANCE_MS = 10 * 60 * 1000;
/** 手机时钟快一点可以，快出一天就当伪造。 */
export const COMMAND_FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

export type AckResult = Extract<AckDoc, { ok: true }>["result"];

export type CommandContext = {
  service: AyanamiTaskService;
  dispatch: DispatchPort | null;
};

/** 键名里的命令 ID 必须与明文一致、属于发送设备，时间合理且不过期。 */
export function validateCommand(doc: CommandDoc, keyCommandId: string, now: Date): void {
  if (doc.id !== keyCommandId)
    throw new SyncCommandError("COMMAND_INVALID", "命令内容与文档键不一致，已拒绝");
  if (!doc.id.startsWith(`${doc.device.id}.`))
    throw new SyncCommandError("COMMAND_INVALID", "命令 ID 与发送设备不符，已拒绝");
  const at = Date.parse(doc.at);
  const stamped = commandTimestamp(doc.id);
  if (!Number.isFinite(at) || stamped === null)
    throw new SyncCommandError("COMMAND_INVALID", "命令时间无法识别，已拒绝");
  if (Math.abs(stamped - at) > COMMAND_CLOCK_TOLERANCE_MS)
    throw new SyncCommandError("COMMAND_INVALID", "命令 ID 里的时间与发送时间不一致，已拒绝");
  if (now.getTime() - at > COMMAND_MAX_AGE_MS)
    throw new SyncCommandError("COMMAND_EXPIRED", "命令发出已超过 7 天，电脑不再执行");
  if (at - now.getTime() > COMMAND_FUTURE_TOLERANCE_MS)
    throw new SyncCommandError("COMMAND_INVALID", "命令时间在未来，请检查手机时间设置");
}

function activeProject(service: AyanamiTaskService, code: string): { code: string } {
  try {
    const project = service.databases.getProject(code);
    if (project.lifecycle === "ACTIVE") return { code: project.code };
  } catch (error) {
    if (!(error instanceof AtmError && error.code === "PROJECT_NOT_FOUND")) throw error;
  }
  throw new SyncCommandError("PROJECT_NOT_FOUND", `项目 ${code} 不存在或已归档`);
}

/**
 * 与桌面端「新建任务」同一规则：项目目标按创建顺序，取第一个 ACTIVE 的。
 * 项目还没有目标时，走 promote / Agent 建任务共用的补建路径（标题带「自动补建」，一眼可辨），
 * 而不是把手机上的任务拒掉——新项目头一个任务多半就是从手机发来的。
 */
async function firstActiveObjective(service: AyanamiTaskService, code: string): Promise<string> {
  const objectives = (await service.listObjectives(code)) as Array<{ id: string; status: string }>;
  const objective = objectives.find((entry) => entry.status === "ACTIVE");
  if (objective) return String(objective.id);
  return (await service.ensurePlanningRoot(code)).objectiveId;
}

async function dispatchOutcome(
  context: CommandContext,
  input: { project: string; key: string; requestedBy: string },
): Promise<Pick<AckResult, "dispatch" | "dispatchError">> {
  if (!context.dispatch)
    return {
      dispatchError: {
        code: "DISPATCH_UNAVAILABLE",
        message: "这台电脑没有启用 Claude 派单",
      },
    };
  // 同一条命令重放时，已经排上的派单直接报告，不再排第二次。
  const existing = context.dispatch.runForTask(input.project, input.key);
  if (existing && (existing.state === "queued" || existing.state === "running"))
    return { dispatch: { run: existing.run, state: existing.state } };
  try {
    const run = await context.dispatch.enqueue(input);
    return { dispatch: { run: run.run, state: run.state } };
  } catch (error) {
    return { dispatchError: ackError(error) };
  }
}

async function createTask(
  context: CommandContext,
  doc: Extract<CommandDoc, { type: "task.create" }>,
): Promise<AckResult> {
  const project = activeProject(context.service, doc.body.project);
  const objectiveId = await firstActiveObjective(context.service, project.code);
  // 与桌面端「新建任务」走同一份 ATM 输入校验与默认值（长度上限、枚举）。
  const item = WorkItemCreateInputSchema.parse({
    clientRef: "mobile",
    objectiveId,
    title: doc.body.title.trim(),
    description: doc.body.description ?? "",
    type: "TASK",
    priority: doc.body.priority ?? "NORMAL",
    status: "READY",
  });
  const created = await context.service.createWorkItemsAsUser(project.code, `mobile:${doc.id}`, [
    {
      clientRef: item.clientRef,
      objectiveId,
      title: item.title,
      description: item.description,
      type: item.type,
      priority: item.priority,
      status: item.status,
      acceptance: item.acceptance,
      checklist: item.checklist,
      dependsOn: item.dependsOn,
      dependsOnRefs: item.dependsOnRefs,
      weight: item.weight,
      verificationRequired: item.verificationRequired,
    },
  ]);
  const key = created.items[0]?.key;
  if (!key) throw new SyncCommandError("COMMAND_FAILED", "任务没有建出来");
  const result: AckResult = { project: project.code, key };
  if (!doc.body.dispatch) return result;
  return {
    ...result,
    ...(await dispatchOutcome(context, {
      project: project.code,
      key,
      requestedBy: doc.device.name,
    })),
  };
}

async function dispatchTask(
  context: CommandContext,
  doc: Extract<CommandDoc, { type: "task.dispatch" }>,
): Promise<AckResult> {
  const project = activeProject(context.service, doc.body.project);
  try {
    await context.service.getWorkItemForUi(project.code, doc.body.key);
  } catch (error) {
    if (error instanceof AtmError && error.code === "WORK_ITEM_NOT_FOUND")
      throw new SyncCommandError("TASK_NOT_FOUND", `任务 ${doc.body.key} 不存在`);
    throw error;
  }
  const outcome = await dispatchOutcome(context, {
    project: project.code,
    key: doc.body.key,
    requestedBy: doc.device.name,
  });
  if (outcome.dispatchError) {
    // 派单被拒就是这条命令失败，错误码照实透传（例如 DISPATCH_DISABLED）。
    const code = outcome.dispatchError.code;
    throw new SyncCommandError(
      code.startsWith("DISPATCH_") ? (code as `DISPATCH_${string}`) : "COMMAND_FAILED",
      outcome.dispatchError.message,
    );
  }
  return { project: project.code, key: doc.body.key, ...outcome };
}

/** 执行一条已校验的命令。失败抛错，由调用方写 `ok:false` 的 ack（可重试的 ATM 错误除外）。 */
export async function executeCommand(context: CommandContext, doc: CommandDoc): Promise<AckResult> {
  switch (doc.type) {
    case "task.create":
      return createTask(context, doc);
    case "task.dispatch":
      return dispatchTask(context, doc);
  }
}

/** ATM 自己标了可重试的错误（例如项目库暂时打不开）：不写失败 ack，稍后再处理。 */
export function isRetryableCommandError(error: unknown): boolean {
  return error instanceof AtmError && error.retryable;
}
