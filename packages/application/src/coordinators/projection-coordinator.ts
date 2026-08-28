import { asAtmError } from "@ayanami-task/errors";
import {
  type ProjectionBatchReceipt,
  type ProjectionReconcileReceipt,
} from "@ayanami-task/protocol";
import type { ProjectionReceipt } from "@ayanami-task/storage-sqlite";
import type { ApplicationServiceRuntime } from "../runtime/service-runtime.js";

export class ProjectionCoordinator {
  readonly #runtime: ApplicationServiceRuntime;

  constructor(runtime: ApplicationServiceRuntime) {
    this.#runtime = runtime;
  }

  async flush(projectCode: string): Promise<ProjectionReceipt> {
    const result = await this.#runtime.databases.dispatchProject(projectCode);
    this.#runtime.emitProject(projectCode);
    this.#runtime.emitGlobal();
    return result.projection;
  }

  async reconcileProjection(projectCode: string): Promise<ProjectionReconcileReceipt> {
    const project = this.#runtime.databases.getProject(projectCode);
    const attemptedAt = new Date().toISOString();
    const result = await this.#runtime.databases.dispatchProject(project.id);
    this.#runtime.emitProject(project.code);
    this.#runtime.emitGlobal();
    return {
      ok: true,
      project: {
        id: project.id,
        code: project.code,
        name: project.name,
        lifecycle: project.lifecycle,
      },
      delivered: result.delivered,
      sequence: result.sequence,
      attemptedAt,
      projection: result.projection,
    };
  }

  async reconcileProjections(
    reconcileOne: (projectCode: string) => Promise<ProjectionReconcileReceipt>,
  ): Promise<ProjectionBatchReceipt> {
    const attemptedAt = new Date().toISOString();
    const projects = this.#runtime.databases
      .listProjects()
      .filter((project) => ["ACTIVE", "ARCHIVED"].includes(project.lifecycle))
      .sort((left, right) => left.code.localeCompare(right.code));
    const results: ProjectionReconcileReceipt[] = [];
    const failures: ProjectionBatchReceipt["failures"] = [];
    for (const project of projects) {
      try {
        results.push(await reconcileOne(project.code));
      } catch (error) {
        const typed = asAtmError(error);
        failures.push({
          project: {
            id: project.id,
            code: project.code,
            name: project.name,
            lifecycle: project.lifecycle,
          },
          code: typed.code,
          message: typed.message.slice(0, 2_000),
        });
      }
    }
    return {
      ok: true,
      attempted: projects.length,
      applied: results.filter((result) => result.projection.status === "APPLIED").length,
      deferred: results.filter((result) => result.projection.status === "DEFERRED").length,
      failed: failures.length,
      attemptedAt,
      finishedAt: new Date().toISOString(),
      results,
      failures,
    };
  }
}
