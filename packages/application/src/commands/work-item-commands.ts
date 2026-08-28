import type { AtmError } from "@ayanami-task/errors";
import { workItemOperationHasEffect } from "@ayanami-task/protocol";
import { type ProjectRepository, type ProjectionReceipt } from "@ayanami-task/storage-sqlite";
import type { ProjectionCoordinator } from "../coordinators/projection-coordinator.js";
import type { EngineeringMetricsObserver } from "../observers/engineering-metrics-observer.js";
import type { ApplicationServiceRuntime } from "../runtime/service-runtime.js";
import { type MutationErrorContext, withMutationErrorDetails } from "./command-errors.js";
import { mutationAck, projectMutationReceipt } from "./command-results.js";
import type { SessionCommands } from "./session-commands.js";

type EnrichError = (
  error: unknown,
  context: MutationErrorContext & { projectCode: string },
) => Promise<AtmError>;

export class WorkItemCommands {
  readonly #runtime: ApplicationServiceRuntime;
  readonly #projection: ProjectionCoordinator;
  readonly #metrics: EngineeringMetricsObserver;
  readonly #sessions: SessionCommands;
  readonly #enrichError: EnrichError;

  constructor(
    runtime: ApplicationServiceRuntime,
    projection: ProjectionCoordinator,
    metrics: EngineeringMetricsObserver,
    sessions: SessionCommands,
    enrichError: EnrichError,
  ) {
    this.#runtime = runtime;
    this.#projection = projection;
    this.#metrics = metrics;
    this.#sessions = sessions;
    this.#enrichError = enrichError;
  }

  async createObjective(
    projectCode: string,
    sessionId: string,
    input: { title: string; description: string; definitionOfDone: string[] },
  ) {
    const repository = await this.#runtime.repository(projectCode);
    const result = repository.createObjective(
      await this.#runtime.actor(projectCode, sessionId),
      input,
    );
    const projection = await this.#projection.flush(projectCode);
    return projectMutationReceipt(result, projection);
  }

  async createObjectiveAsUser(
    projectCode: string,
    opId: string,
    input: { title: string; description: string; definitionOfDone: string[] },
  ) {
    const repository = await this.#runtime.repository(projectCode);
    const result = repository.createObjective(this.#runtime.userActor(), input, opId);
    const projection = await this.#projection.flush(projectCode);
    return projectMutationReceipt(result, projection);
  }

  async createMilestone(
    projectCode: string,
    sessionId: string,
    input: { objectiveId: string; title: string; description?: string; targetDate?: string | null },
  ) {
    const repository = await this.#runtime.repository(projectCode);
    const result = repository.createMilestone(
      await this.#runtime.actor(projectCode, sessionId),
      input,
    );
    const projection = await this.#projection.flush(projectCode);
    return projectMutationReceipt(result, projection);
  }

  async createMilestoneAsUser(
    projectCode: string,
    opId: string,
    input: { objectiveId: string; title: string; description?: string; targetDate?: string | null },
  ) {
    const repository = await this.#runtime.repository(projectCode);
    const result = repository.createMilestone(this.#runtime.userActor(), input, opId);
    const projection = await this.#projection.flush(projectCode);
    return projectMutationReceipt(result, projection);
  }

  async createWorkItems(
    projectCode: string,
    sessionId: string,
    opId: string,
    items: Parameters<ProjectRepository["createWorkItems"]>[2],
    options: { resolvePlanningRoot?: boolean } = {},
  ) {
    const repository = await this.#runtime.repository(projectCode);
    const planningRoot = options.resolvePlanningRoot
      ? {
          provisionIfMissing: items.some((item) => item.objectiveId === undefined),
          objectiveTitle: `${this.#runtime.databases.getProject(projectCode).name}（自动补建）`,
          objectiveDescription:
            "项目尚无目标时自动补建，用于承载任务。请按实际规划改写标题与验收，或另建目标后归档它。",
          milestoneTitle: "执行",
        }
      : undefined;
    const execution = repository.executeSessionMutation(
      sessionId,
      opId,
      "work.create.batch",
      items,
      (actor) => repository.createWorkItems(actor, opId, items, planningRoot),
    );
    const projection = await this.#projection.flush(projectCode);
    return mutationAck(execution.result, opId, execution.resolution, projection);
  }

  async createWorkItemsAsUser(
    projectCode: string,
    opId: string,
    items: Parameters<ProjectRepository["createWorkItems"]>[2],
  ): Promise<ReturnType<ProjectRepository["createWorkItems"]> & { projection: ProjectionReceipt }> {
    const repository = await this.#runtime.repository(projectCode);
    const result = repository.createWorkItems(this.#runtime.userActor(), opId, items);
    const projection = await this.#projection.flush(projectCode);
    return projectMutationReceipt(result, projection);
  }

  async patchWorkItems(
    projectCode: string,
    sessionId: string,
    opId: string,
    patches: Parameters<ProjectRepository["patchWorkItems"]>[2],
  ) {
    const repository = await this.#runtime.repository(projectCode);
    const firstPatch = patches[0];
    const execution = await withMutationErrorDetails(
      projectCode,
      firstPatch === undefined
        ? {}
        : {
            taskKey: firstPatch.taskKey,
            expectedVersion: firstPatch.expectedVersion,
            expectedVersions: Object.fromEntries(
              patches.map((patch) => [patch.taskKey, patch.expectedVersion]),
            ),
          },
      this.#enrichError,
      () =>
        repository.executeSessionMutation(sessionId, opId, "work.patch.batch", patches, (actor) =>
          repository.patchWorkItems(actor, opId, patches),
        ),
    );
    if (
      patches.some((patch) => workItemOperationHasEffect(patch.operation, "REFRESH_GIT_CONTEXT"))
    ) {
      await this.#sessions.refreshSessionGitContext(
        projectCode,
        String(execution.resolution.actor.sessionId),
      );
    }
    const projection = await this.#projection.flush(projectCode);
    const starts = patches
      .filter((patch) =>
        workItemOperationHasEffect(patch.operation, "ESTABLISH_ENGINEERING_BASELINE"),
      )
      .map((patch) => patch.taskKey);
    const finishes = patches
      .filter((patch) => workItemOperationHasEffect(patch.operation, "CAPTURE_ENGINEERING_METRICS"))
      .map((patch) => patch.taskKey);
    await this.#metrics.captureWorkItemEngineeringMetrics(projectCode, starts, true);
    await this.#metrics.captureWorkItemEngineeringMetrics(projectCode, finishes, false);
    return mutationAck(execution.result, opId, execution.resolution, projection);
  }

  async patchWorkItemsAsUser(
    projectCode: string,
    opId: string,
    patches: Parameters<ProjectRepository["patchWorkItems"]>[2],
  ): Promise<ReturnType<ProjectRepository["patchWorkItems"]> & { projection: ProjectionReceipt }> {
    const repository = await this.#runtime.repository(projectCode);
    const result = repository.patchWorkItems(this.#runtime.userActor(), opId, patches);
    const projection = await this.#projection.flush(projectCode);
    const starts = patches
      .filter((patch) =>
        workItemOperationHasEffect(patch.operation, "ESTABLISH_ENGINEERING_BASELINE"),
      )
      .map((patch) => patch.taskKey);
    const finishes = patches
      .filter((patch) => workItemOperationHasEffect(patch.operation, "CAPTURE_ENGINEERING_METRICS"))
      .map((patch) => patch.taskKey);
    await this.#metrics.captureWorkItemEngineeringMetrics(projectCode, starts, true);
    await this.#metrics.captureWorkItemEngineeringMetrics(projectCode, finishes, false);
    return projectMutationReceipt(result, projection);
  }

  async verifyAndComplete(
    projectCode: string,
    sessionId: string,
    opId: string,
    input: Parameters<ProjectRepository["verifyAndComplete"]>[2],
  ) {
    const repository = await this.#runtime.repository(projectCode);
    const execution = await withMutationErrorDetails(
      projectCode,
      { taskKey: input.taskKey, expectedVersion: input.expectedVersion },
      this.#enrichError,
      () =>
        repository.executeSessionMutation(
          sessionId,
          opId,
          "work.verify-and-complete",
          input,
          (actor) => repository.verifyAndComplete(actor, opId, input),
        ),
    );
    await this.#sessions.refreshSessionGitContext(
      projectCode,
      String(execution.resolution.actor.sessionId),
    );
    const projection = await this.#projection.flush(projectCode);
    await this.#metrics.captureWorkItemEngineeringMetrics(projectCode, [input.taskKey], false);
    return mutationAck(execution.result, opId, execution.resolution, projection);
  }

  async verifyAndCompleteAsUser(
    projectCode: string,
    opId: string,
    input: Parameters<ProjectRepository["verifyAndComplete"]>[2],
  ): Promise<
    ReturnType<ProjectRepository["verifyAndComplete"]> & { projection: ProjectionReceipt }
  > {
    const repository = await this.#runtime.repository(projectCode);
    const result = repository.verifyAndComplete(this.#runtime.userActor(), opId, input);
    const projection = await this.#projection.flush(projectCode);
    await this.#metrics.captureWorkItemEngineeringMetrics(projectCode, [input.taskKey], false);
    return projectMutationReceipt(result, projection);
  }

  async updateChecklist(
    projectCode: string,
    sessionId: string,
    opId: string,
    input: Parameters<ProjectRepository["updateChecklist"]>[2],
  ) {
    const repository = await this.#runtime.repository(projectCode);
    const execution = await withMutationErrorDetails(
      projectCode,
      { checklistId: input.checklistId, expectedVersion: input.expectedVersion },
      this.#enrichError,
      () =>
        repository.executeSessionMutation(sessionId, opId, "checklist.update", input, (actor) =>
          repository.updateChecklist(actor, opId, input),
        ),
    );
    const projection = await this.#projection.flush(projectCode);
    return mutationAck(execution.result, opId, execution.resolution, projection);
  }

  async updateChecklistAsUser(
    projectCode: string,
    opId: string,
    input: Parameters<ProjectRepository["updateChecklist"]>[2],
  ): Promise<ReturnType<ProjectRepository["updateChecklist"]> & { projection: ProjectionReceipt }> {
    const repository = await this.#runtime.repository(projectCode);
    const result = repository.updateChecklist(this.#runtime.userActor(), opId, input);
    const projection = await this.#projection.flush(projectCode);
    return projectMutationReceipt(result, projection);
  }

  async updateChecklistBatch(
    projectCode: string,
    sessionId: string,
    opId: string,
    input: Parameters<ProjectRepository["updateChecklistBatch"]>[2],
  ) {
    const repository = await this.#runtime.repository(projectCode);
    const execution = await withMutationErrorDetails(
      projectCode,
      { taskKey: input.taskKey, expectedVersion: input.expectedVersion },
      this.#enrichError,
      () =>
        repository.executeSessionMutation(
          sessionId,
          opId,
          "checklist.update.batch",
          input,
          (actor) => repository.updateChecklistBatch(actor, opId, input),
        ),
    );
    const projection = await this.#projection.flush(projectCode);
    return mutationAck(execution.result, opId, execution.resolution, projection);
  }

  async updateChecklistBatchAsUser(
    projectCode: string,
    opId: string,
    input: Parameters<ProjectRepository["updateChecklistBatch"]>[2],
  ): Promise<
    ReturnType<ProjectRepository["updateChecklistBatch"]> & { projection: ProjectionReceipt }
  > {
    const repository = await this.#runtime.repository(projectCode);
    const result = repository.updateChecklistBatch(this.#runtime.userActor(), opId, input);
    const projection = await this.#projection.flush(projectCode);
    return projectMutationReceipt(result, projection);
  }
}
