import {
  gitHead,
  scanProjectMetrics,
  scanWorkItemChanges,
} from "@ayanami-task/engineering-metrics";
import { asAtmError } from "@ayanami-task/errors";
import type { ApplicationServiceRuntime } from "../runtime/service-runtime.js";

export class EngineeringMetricsObserver {
  readonly #runtime: ApplicationServiceRuntime;

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
      let workItem: Record<string, unknown> | null = null;
      if (input.taskKey) {
        const baseline = await this.#runtime.databases.ensureWorkItemEngineeringBaseline(
          projectCode,
          input.taskKey,
          gitHead(sourcePath),
        );
        const metrics = scanWorkItemChanges(sourcePath, baseline.baseline);
        workItem = await this.#runtime.databases.saveWorkItemEngineeringMetrics(
          projectCode,
          input.taskKey,
          baseline.baseline,
          metrics,
        );
      }
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
