import { AtmError } from "@ayanami-task/errors";
import type { AyanamiTaskService } from "@ayanami-task/application";
import { DISPATCH_STATES, PERMISSION_MODES } from "@ayanami-task/sync-protocol";

export type SyncDispatchState = (typeof DISPATCH_STATES)[number];
export type SyncPermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * 任务卡片上的派单状态；`at` 取最近一次状态变化的时间；`error` 是派单记下的失败原因
 * （原文，发布时只给 failed 带上并截断）。
 */
export type SyncDispatchRun = {
  run: string;
  state: SyncDispatchState;
  at: string;
  error?: string;
};

/**
 * 连接器对派单的全部需求。sync 包不依赖 agent-dispatch，宿主用 {@link dispatchPortFrom}
 * 把 AgentDispatcher 接上；没有派单时传 null，手机勾「交给 Claude」会得到 dispatchError。
 */
export type DispatchPort = {
  /** head 里的派单摘要。 */
  summary(): { enabled: boolean; mode: SyncPermissionMode; running: number };
  runForTask(project: string, key: string): SyncDispatchRun | null;
  /** 被拒时抛出带 `code`（SCREAMING_SNAKE）与中文 `message` 的错误。 */
  enqueue(input: { project: string; key: string; requestedBy?: string }): Promise<SyncDispatchRun>;
  /** 派单状态或配置变化；`project` 缺省表示影响全局（例如开关）。 */
  onChange(listener: (event: { project?: string }) => void): () => void;
};

type DispatchRunLike = {
  run: string;
  project: string;
  state: SyncDispatchState;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  error?: string;
};

/** AgentDispatcher 的结构化子集：按形状对接，不 import agent-dispatch 包。 */
export type DispatcherLike = {
  readonly config: { enabled: boolean; permissionMode: string };
  listRuns(): readonly DispatchRunLike[];
  runForTask(project: string, key: string): DispatchRunLike | null;
  enqueue(input: {
    project: string;
    key: string;
    origin: "mobile";
    requestedBy?: string;
  }): Promise<DispatchRunLike>;
  onChange(listener: (event: { type: string; run?: { project: string } }) => void): () => void;
};

function runView(run: DispatchRunLike): SyncDispatchRun {
  return {
    run: run.run,
    state: run.state,
    at: run.endedAt ?? run.startedAt ?? run.createdAt,
    ...(run.error ? { error: run.error } : {}),
  };
}

function permissionMode(value: string): SyncPermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value)
    ? (value as SyncPermissionMode)
    : "auto";
}

export function dispatchPortFrom(dispatcher: DispatcherLike): DispatchPort {
  return {
    summary() {
      const config = dispatcher.config;
      return {
        enabled: config.enabled,
        mode: permissionMode(config.permissionMode),
        running: dispatcher.listRuns().filter((run) => run.state === "running").length,
      };
    },
    runForTask(project, key) {
      const run = dispatcher.runForTask(project, key);
      return run ? runView(run) : null;
    },
    async enqueue(input) {
      const run = await dispatcher.enqueue({
        project: input.project,
        key: input.key,
        origin: "mobile",
        ...(input.requestedBy === undefined ? {} : { requestedBy: input.requestedBy }),
      });
      return runView(run);
    },
    onChange(listener) {
      return dispatcher.onChange((event) =>
        listener(event.run ? { project: event.run.project } : {}),
      );
    },
  };
}

type DispatchProjectView = { code: string; name: string; paths: string[] };
type DispatchTaskView = {
  key: string;
  title: string;
  status: string;
  description: string;
  claimedBySessionId: string | null;
  claimLeaseUntil: string | null;
};

function isNotFound(error: unknown): boolean {
  return (
    error instanceof AtmError &&
    (error.code === "PROJECT_NOT_FOUND" || error.code === "WORK_ITEM_NOT_FOUND")
  );
}

/**
 * 派单宿主端口（agent-dispatch 的 DispatchHost）的 AyanamiTaskService 实现：
 * 桌面宿主与独立 daemon 共用。只认活动项目；项目路径主路径在前。
 */
export function taskServiceDispatchHost(service: AyanamiTaskService): {
  getProject(code: string): DispatchProjectView | null;
  getTask(code: string, key: string): Promise<DispatchTaskView | null>;
} {
  return {
    getProject(code) {
      try {
        const project = service.databases.getProject(code);
        if (project.lifecycle !== "ACTIVE") return null;
        return { code: project.code, name: project.name, paths: [...project.sourcePaths] };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async getTask(code, key) {
      try {
        const task = await service.getWorkItemForUi(code, key);
        return {
          key: task.key,
          title: task.title,
          status: task.status,
          description: task.description,
          claimedBySessionId: task.claimedBySessionId,
          claimLeaseUntil: task.claimLeaseUntil,
        };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
  };
}
