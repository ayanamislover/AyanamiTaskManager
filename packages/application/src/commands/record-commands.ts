import type { EvidenceInput } from "@ayanami-task/protocol";
import { type ProjectRepository, type ProjectionReceipt } from "@ayanami-task/storage-sqlite";
import type { ProjectionCoordinator } from "../coordinators/projection-coordinator.js";
import type { ApplicationServiceRuntime } from "../runtime/service-runtime.js";
import { mutationAck, projectMutationReceipt } from "./command-results.js";
import type { SessionCommands } from "./session-commands.js";

export class RecordCommands {
  readonly #runtime: ApplicationServiceRuntime;
  readonly #projection: ProjectionCoordinator;
  readonly #sessions: SessionCommands;

  constructor(
    runtime: ApplicationServiceRuntime,
    projection: ProjectionCoordinator,
    sessions: SessionCommands,
  ) {
    this.#runtime = runtime;
    this.#projection = projection;
    this.#sessions = sessions;
  }

  async draftProjectUpdateAsUser(projectCode: string, opId: string) {
    const repository = await this.#runtime.repository(projectCode);
    const result = repository.draftProjectUpdate(this.#runtime.userActor(), opId);
    const projection = await this.#projection.flush(projectCode);
    return projectMutationReceipt(result, projection);
  }

  async publishProjectUpdateAsUser(
    projectCode: string,
    opId: string,
    input: Parameters<ProjectRepository["publishProjectUpdate"]>[2],
  ) {
    const repository = await this.#runtime.repository(projectCode);
    const result = repository.publishProjectUpdate(this.#runtime.userActor(), opId, input);
    const projection = await this.#projection.flush(projectCode);
    return projectMutationReceipt(result, projection);
  }

  async addProgress(
    projectCode: string,
    sessionId: string,
    opId: string,
    input: Parameters<ProjectRepository["addProgress"]>[2],
  ) {
    const repository = await this.#runtime.repository(projectCode);
    const execution = repository.executeSessionMutation(
      sessionId,
      opId,
      "work.progress",
      input,
      (actor) => repository.addProgress(actor, opId, input),
    );
    await this.#sessions.refreshSessionGitContext(
      projectCode,
      String(execution.resolution.actor.sessionId),
    );
    const projection = await this.#projection.flush(projectCode);
    return mutationAck(execution.result, opId, execution.resolution, projection);
  }

  async addProjectProgress(
    projectCode: string,
    sessionId: string,
    opId: string,
    input: {
      health?: "ON_TRACK" | "AT_RISK" | "OFF_TRACK" | "UNKNOWN" | null;
      summary: string;
      completed?: Array<string | { text: string; workItemKey?: string }>;
      next?: string[];
      blocker?: string | null;
      evidence?: EvidenceInput[];
    },
  ) {
    const repository = await this.#runtime.repository(projectCode);
    const completed = input.completed ?? [];
    const linkedKeys = new Set(
      completed.flatMap((entry) =>
        typeof entry === "string" || !entry.workItemKey ? [] : [entry.workItemKey],
      ),
    );
    for (const taskKey of linkedKeys) repository.getWorkItem(taskKey);
    const update = {
      health: input.health ?? (input.blocker ? "AT_RISK" : "UNKNOWN"),
      summary: input.summary,
      completed,
      risks: input.blocker ? [input.blocker] : [],
      next: input.next ?? [],
      evidence: input.evidence ?? [],
    };
    const execution = repository.executeSessionMutation(
      sessionId,
      opId,
      "project-update.publish",
      update,
      (actor) => repository.publishProjectUpdate(actor, opId, update),
    );
    await this.#sessions.refreshSessionGitContext(
      projectCode,
      String(execution.resolution.actor.sessionId),
    );
    const projection = await this.#projection.flush(projectCode);
    return mutationAck(execution.result, opId, execution.resolution, projection);
  }

  async createRecord(
    projectCode: string,
    sessionId: string,
    opId: string,
    input: Parameters<ProjectRepository["createRecord"]>[2],
  ) {
    const repository = await this.#runtime.repository(projectCode);
    const execution = repository.executeSessionMutation(
      sessionId,
      opId,
      "record.create",
      input,
      (actor) => repository.createRecord(actor, opId, input),
    );
    const projection = await this.#projection.flush(projectCode);
    return mutationAck(execution.result, opId, execution.resolution, projection);
  }

  async createRecordAsUser(
    projectCode: string,
    opId: string,
    input: Parameters<ProjectRepository["createRecord"]>[2],
  ): Promise<ReturnType<ProjectRepository["createRecord"]> & { projection: ProjectionReceipt }> {
    const repository = await this.#runtime.repository(projectCode);
    const result = repository.createRecord(this.#runtime.userActor(), opId, {
      ...input,
      sourceType: "USER",
      sourceActorId: "USER",
      sourceSessionId: null,
    });
    const projection = await this.#projection.flush(projectCode);
    return projectMutationReceipt(result, projection);
  }
}
