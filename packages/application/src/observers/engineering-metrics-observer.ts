import {
  gitHead,
  scanProjectMetrics,
  scanWorkItemChanges,
} from "@ayanami-task/engineering-metrics";
import { asAtmError } from "@ayanami-task/errors";
import type { ApplicationServiceRuntime } from "../runtime/service-runtime.js";

/**
 * 工程变更扫描要跑一串 git 子进程，而且是同步的：本仓实测 scanWorkItemChanges 1.7 秒、
 * scanProjectMetrics 1.5 秒。它一跑，daemon 这一整段时间什么请求都答不了——
 * 点开任务详情之所以慢，慢的不是任务本身，是它排在这次扫描后面。
 *
 * 所以：手里有一份不太旧的就直接给，稍旧的先给旧的、扫描挪到这次响应之后去补。
 * 只有一份都没有（这个任务第一次看）才真的当场扫。
 */
const WORK_ITEM_METRICS_FRESH_MS = 60_000;

export class EngineeringMetricsObserver {
  readonly #runtime: ApplicationServiceRuntime;
  readonly #scanning = new Set<string>();

  constructor(runtime: ApplicationServiceRuntime) {
    this.#runtime = runtime;
  }

  async engineeringMetrics(
    projectCode: string,
    input: { taskKey?: string; refresh?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const project = this.#runtime.databases.getProject(projectCode);
    const sourcePath = project.sourcePaths[0];
    if (!sourcePath) {
      return { available: false, reason: "NO_SOURCE_PATH", project: null, workItem: null };
    }
    try {
      const latest = await this.#runtime.databases.latestProjectEngineeringMetrics(projectCode);
      const latestAt = typeof latest?.capturedAt === "string" ? Date.parse(latest.capturedAt) : 0;
      const projectMetrics =
        !input.refresh && latest && Date.now() - latestAt < 5 * 60_000
          ? latest
          : await this.#runtime.databases.saveProjectEngineeringMetrics(
              projectCode,
              scanProjectMetrics(sourcePath),
            );
      const workItem = input.taskKey
        ? await this.#workItemMetrics(
            projectCode,
            input.taskKey,
            sourcePath,
            input.refresh === true,
          )
        : null;
      return { available: true, root: sourcePath, project: projectMetrics, workItem };
    } catch (error) {
      const typed = asAtmError(error);
      return {
        available: false,
        reason: typed.code === "INTERNAL_ERROR" ? "METRICS_FAILED" : typed.code,
        message: typed.message,
        project: null,
        workItem: null,
      };
    }
  }

  async #workItemMetrics(
    projectCode: string,
    taskKey: string,
    sourcePath: string,
    refresh: boolean,
  ): Promise<Record<string, unknown> | null> {
    const stored = await this.#runtime.databases.workItemEngineeringMetrics(projectCode, taskKey);
    const capturedAt = typeof stored?.capturedAt === "string" ? Date.parse(stored.capturedAt) : 0;
    if (!refresh && stored) {
      if (Date.now() - capturedAt >= WORK_ITEM_METRICS_FRESH_MS) {
        this.#scheduleWorkItemScan(projectCode, taskKey, sourcePath);
      }
      return stored;
    }
    return this.#scanWorkItem(projectCode, taskKey, sourcePath);
  }

  #scheduleWorkItemScan(projectCode: string, taskKey: string, sourcePath: string): void {
    const key = `${projectCode}\u0000${taskKey}`;
    if (this.#scanning.has(key)) return;
    this.#scanning.add(key);
    const timer = setTimeout(() => {
      void this.#scanWorkItem(projectCode, taskKey, sourcePath)
        .catch(() => undefined)
        .finally(() => this.#scanning.delete(key));
    }, 0);
    // 后台补扫不该拖着进程不退出。
    timer.unref?.();
  }

  async #scanWorkItem(
    projectCode: string,
    taskKey: string,
    sourcePath: string,
  ): Promise<Record<string, unknown>> {
    const baseline = await this.#runtime.databases.ensureWorkItemEngineeringBaseline(
      projectCode,
      taskKey,
      gitHead(sourcePath),
    );
    return this.#runtime.databases.saveWorkItemEngineeringMetrics(
      projectCode,
      taskKey,
      baseline.baseline,
      scanWorkItemChanges(sourcePath, baseline.baseline),
    );
  }

  async captureWorkItemEngineeringMetrics(
    projectCode: string,
    taskKeys: string[],
    establishBaseline: boolean,
  ): Promise<void> {
    const sourcePath = this.#runtime.databases.getProject(projectCode).sourcePaths[0];
    if (!sourcePath) return;
    try {
      const head = gitHead(sourcePath);
      for (const taskKey of [...new Set(taskKeys)]) {
        let stored = await this.#runtime.databases.workItemEngineeringMetrics(projectCode, taskKey);
        if (!stored && establishBaseline) {
          stored = await this.#runtime.databases.ensureWorkItemEngineeringBaseline(
            projectCode,
            taskKey,
            head,
          );
        }
        if (!stored) continue;
        const metrics = scanWorkItemChanges(sourcePath, stored.baseline);
        await this.#runtime.databases.saveWorkItemEngineeringMetrics(
          projectCode,
          taskKey,
          stored.baseline,
          metrics,
        );
      }
    } catch {
      // Engineering metrics are observational and never roll back a committed task transition.
    }
  }
}
