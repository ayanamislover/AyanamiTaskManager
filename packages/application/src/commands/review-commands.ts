import type { AtmError } from "@ayanami-task/errors";
import { normalizeReviewCandidateHashes } from "@ayanami-task/protocol";
import type { ProjectRepository } from "@ayanami-task/storage-sqlite";
import type { ProjectionCoordinator } from "../coordinators/projection-coordinator.js";
import type { ApplicationServiceRuntime } from "../runtime/service-runtime.js";
import { type MutationErrorContext, withMutationErrorDetails } from "./command-errors.js";
import { mutationAck } from "./command-results.js";

type EnrichError = (
  error: unknown,
  context: MutationErrorContext & { projectCode: string },
) => Promise<AtmError>;

export class ReviewCommands {
  readonly #runtime: ApplicationServiceRuntime;
  readonly #projection: ProjectionCoordinator;
  readonly #enrichError: EnrichError;

  constructor(
    runtime: ApplicationServiceRuntime,
    projection: ProjectionCoordinator,
    enrichError: EnrichError,
  ) {
    this.#runtime = runtime;
    this.#projection = projection;
    this.#enrichError = enrichError;
  }

  async createReviewRequest(
    projectCode: string,
    sessionId: string,
    opId: string,
    input: Parameters<ProjectRepository["createReviewRequest"]>[2],
  ) {
    const repository = await this.#runtime.repository(projectCode);
    const normalizedInput = {
      ...input,
      expectedCandidateHashes: normalizeReviewCandidateHashes(input.expectedCandidateHashes),
    };
    const execution = await withMutationErrorDetails(
      projectCode,
      {
        taskKey: normalizedInput.reviewTaskKey,
        checklistId: normalizedInput.parentChecklistId,
        expectedVersion: normalizedInput.expectedParentChecklistVersion,
        expectedVersions: {
          [normalizedInput.reviewTaskKey]: normalizedInput.expectedReviewTaskVersion,
        },
      },
      this.#enrichError,
      () =>
        repository.executeSessionMutation(
          sessionId,
          opId,
          "review.request.create",
          normalizedInput,
          (actor) => repository.createReviewRequest(actor, opId, normalizedInput),
        ),
    );
    const projection = await this.#projection.flush(projectCode);
    return mutationAck(execution.result, opId, execution.resolution, projection);
  }

  async submitReview(
    projectCode: string,
    sessionId: string,
    opId: string,
    input: Parameters<ProjectRepository["submitReview"]>[2],
  ) {
    const repository = await this.#runtime.repository(projectCode);
    const normalizedInput = {
      ...input,
      reviewedHashes: normalizeReviewCandidateHashes(input.reviewedHashes),
    };
    const execution = await withMutationErrorDetails(
      projectCode,
      {
        ...(normalizedInput.reviewTaskKey === undefined
          ? {}
          : { taskKey: normalizedInput.reviewTaskKey }),
        expectedVersion: normalizedInput.expectedReviewTaskVersion,
      },
      this.#enrichError,
      () =>
        repository.executeSessionMutation(
          sessionId,
          opId,
          "review.submit",
          normalizedInput,
          (actor) => repository.submitReview(actor, opId, normalizedInput),
        ),
    );
    const projection = await this.#projection.flush(projectCode);
    return mutationAck(execution.result, opId, execution.resolution, projection);
  }
}
