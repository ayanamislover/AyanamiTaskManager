import { statSync } from "node:fs";
import { DispatchError } from "./errors.js";
import type { DispatchHost, DispatchProject, DispatchTask } from "./types.js";

// 派单入口的校验：项目、工作目录、任务归属与状态，以及派单器关闭后的拒绝。只读宿主端口，不碰派单内部状态。

/**
 * 等一个异步步骤；派单器关闭（`lifetime` 中止）就不再等，立即以 DISPATCH_CLOSED 结束。
 * 关闭之后它才落定（读到结果，或因库已关而失败）都不再算数：那时这个 Promise 已经 reject。
 * `work` 无论如何都要先接住——已经关闭时它多半正以 DISPATCH_CLOSED 失败（宿主端口拒绝），
 * 没人接的拒绝在 Node 里默认会让整个进程退出。
 */
export function whileOpen<T>(work: Promise<T>, lifetime: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onClose = () => reject(closedError());
    void work.then(resolve, reject).finally(() => lifetime.removeEventListener("abort", onClose));
    if (lifetime.aborted) return onClose();
    lifetime.addEventListener("abort", onClose, { once: true });
  });
}

/** 可以派单的任务状态：还没人开工的。 */
const DISPATCHABLE_STATUSES = new Set(["READY", "BACKLOG"]);

export function disabledError(): DispatchError {
  return new DispatchError("DISPATCH_DISABLED", "派单未开启：请先在 ATM 设置里打开「交给 Claude」");
}

export function closedError(): DispatchError {
  return new DispatchError(
    "DISPATCH_CLOSED",
    "ATM 正在退出，Claude 派单已停止：重新打开 ATM 后再试",
  );
}

/**
 * 关闭后一律拒绝的宿主端口：宿主收尾时（随后就关库）已经在途的入队、启动不能再读库。
 * 只拦调用的入口；已经发出的读取由调用方在 await 回来后自己再查。
 */
export function openOnly(host: DispatchHost, closed: () => boolean): DispatchHost {
  return {
    getProject(code) {
      if (closed()) throw closedError();
      return host.getProject(code);
    },
    getTask(code, key) {
      if (closed()) throw closedError();
      return host.getTask(code, key);
    },
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 任务现在不能派单的原因；可以派单返回 null。 */
export function taskBlocker(task: DispatchTask, now: Date): string | null {
  if (!DISPATCHABLE_STATUSES.has(task.status))
    return `任务状态是 ${task.status}，只有 READY 或 BACKLOG 的任务可以交给 Claude`;
  if (task.claimedBySessionId) {
    const lease = task.claimLeaseUntil ? Date.parse(task.claimLeaseUntil) : Number.NaN;
    if (Number.isNaN(lease) || lease > now.getTime())
      return `任务已被会话 ${task.claimedBySessionId} 领取`;
  }
  return null;
}

/** 来源一行（例如手机设备名）：去掉控制字符，截到 60 个字。 */
export function cleanRequester(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  // eslint-disable-next-line no-control-regex
  const flat = Array.from(value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim());
  return flat.length === 0 ? undefined : flat.slice(0, 60).join("");
}

/** 项目存在且有可用的工作目录、任务属于该项目且现在可以派单；否则抛对应的拒绝码。 */
export async function admitTask(
  host: DispatchHost,
  input: { project: string; key: string },
  now: () => Date,
): Promise<{ project: DispatchProject; task: DispatchTask; cwd: string }> {
  const project = await host.getProject(input.project);
  if (!project)
    throw new DispatchError("DISPATCH_PROJECT_NOT_FOUND", `项目不存在：${input.project}`, {
      project: input.project,
    });
  const cwd = project.paths.find(isDirectory);
  if (!cwd)
    throw new DispatchError(
      "DISPATCH_PROJECT_PATH_MISSING",
      project.paths.length === 0
        ? `项目 ${project.code} 没有绑定工作目录，Claude 不知道在哪里干活：请先在 ATM 里给项目绑定目录`
        : `项目 ${project.code} 绑定的目录都不存在`,
      { project: project.code, paths: project.paths },
    );
  if (!input.key.startsWith(`${project.code}-`))
    throw new DispatchError("DISPATCH_TASK_NOT_FOUND", `${input.key} 不属于项目 ${project.code}`, {
      project: project.code,
      key: input.key,
    });
  const task = await host.getTask(project.code, input.key);
  if (!task)
    throw new DispatchError("DISPATCH_TASK_NOT_FOUND", `任务不存在：${input.key}`, {
      project: project.code,
      key: input.key,
    });
  const blocker = taskBlocker(task, now());
  if (blocker)
    throw new DispatchError("DISPATCH_TASK_NOT_READY", blocker, {
      key: task.key,
      status: task.status,
      claimedBySessionId: task.claimedBySessionId,
      claimLeaseUntil: task.claimLeaseUntil,
    });
  return { project, task, cwd };
}
