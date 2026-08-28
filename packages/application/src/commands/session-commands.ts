import { basename } from "node:path";
import { classifyTaskScope } from "@ayanami-task/domain";
import { inspectGitContext } from "@ayanami-task/engineering-metrics";
import { AtmError } from "@ayanami-task/errors";
import {
  type CreateSessionInput,
  type ProjectRepository,
  type RegisteredProject,
} from "@ayanami-task/storage-sqlite";
import type { ProjectionCoordinator } from "../coordinators/projection-coordinator.js";
import type { EngineeringMetricsObserver } from "../observers/engineering-metrics-observer.js";
import type { ApplicationServiceRuntime } from "../runtime/service-runtime.js";
import { mutationAck, projectMutationReceipt } from "./command-results.js";

type BeginInput = {
  operationId?: string;
  projectCode?: string;
  cwd?: string | null;
  title?: string;
  mode?: "auto" | "quick" | "project";
  agentId: string;
  displayName?: string;
  clientKind?: string;
  parentSessionId?: string | null;
  threadId?: string | null;
  role?: "PRIMARY" | "SUBAGENT" | "REVIEWER" | "OBSERVER";
  gitBranch?: string | null;
  gitHead?: string | null;
  resume?: boolean;
  predecessorSessionId?: string | null;
  maxChars?: number;
  signals?: {
    expectedMinutes?: number;
    subtaskCount?: number;
    multiSession?: boolean;
    multiAgent?: boolean;
    hasDependencies?: boolean;
    needsEvidence?: boolean;
    hasTargetDate?: boolean;
  };
  allowProjectCreate?: boolean;
  creationReason?: string;
};

type CreateProject = (input: {
  name: string;
  sourcePath: string | null;
  description?: string;
  creationReason?: string;
  creationSignals?: Record<string, unknown>;
}) => Promise<RegisteredProject>;

export class SessionCommands {
  readonly #runtime: ApplicationServiceRuntime;
  readonly #projection: ProjectionCoordinator;
  readonly #metrics: EngineeringMetricsObserver;

  constructor(
    runtime: ApplicationServiceRuntime,
    projection: ProjectionCoordinator,
    metrics: EngineeringMetricsObserver,
  ) {
    this.#runtime = runtime;
    this.#projection = projection;
    this.#metrics = metrics;
  }

  async begin(input: BeginInput, createProject: CreateProject) {
    const operationId = input.operationId?.trim();
    if (input.operationId !== undefined && (!operationId || operationId.length > 128)) {
      throw new AtmError("OPERATION_ID_INVALID", { message: "operationId 无效" });
    }
    let project = input.projectCode ? this.#runtime.databases.getProject(input.projectCode) : null;
    if (!project && input.cwd) project = this.#runtime.databases.identifyProject(input.cwd);
    if (operationId && !project) {
      throw new AtmError("ATOMIC_BEGIN_REQUIRES_EXISTING_PROJECT", {
        message: "原子恢复要求项目已存在",
      });
    }
    const classification = classifyTaskScope({
      matchedProject: Boolean(project),
      explicitMode: input.mode ?? "auto",
      signals: input.signals ?? {},
    });
    if (!project && classification.scope === "quick") {
      const quick = this.#runtime.databases.createQuickTask({
        title: input.title ?? "未命名临时任务",
        sourceCwd: input.cwd ?? null,
        actor: input.agentId,
      });
      return { scope: "quick", quick, session: null, score: classification.score };
    }
    if (!project) {
      if (!input.allowProjectCreate) {
        throw new AtmError("PROJECT_REQUIRED", { message: "需要明确的受管项目" });
      }
      project = await createProject({
        name: input.title ?? (input.cwd ? basename(input.cwd) : "未命名项目"),
        sourcePath: input.cwd ?? null,
        ...(input.creationReason === undefined ? {} : { creationReason: input.creationReason }),
        ...(input.signals === undefined ? {} : { creationSignals: input.signals }),
      });
    }
    const repository = await this.#runtime.repository(project.code);
    const gitContext = input.cwd ? inspectGitContext(input.cwd) : null;
    const sessionInput: CreateSessionInput = {
      agentId: input.agentId,
      displayName: input.displayName ?? input.agentId,
      clientKind: input.clientKind ?? "generic",
      role: input.role ?? "PRIMARY",
      ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.gitBranch === undefined ? {} : { gitBranch: input.gitBranch }),
      ...(input.gitHead === undefined ? {} : { gitHead: input.gitHead }),
      gitContext,
      ...(input.resume === undefined ? {} : { resume: input.resume }),
      ...(input.predecessorSessionId === undefined
        ? {}
        : { predecessorSessionId: input.predecessorSessionId }),
    };
    let session: { id: string; sequence: number };
    let atomicBegin: {
      operationId: string;
      disposition: "CREATED" | "RECOVERED";
    } | null = null;
    if (operationId) {
      const recovered = repository.recoverOrCreateSession(
        operationId,
        {
          projectCode: project.code,
          cwd: input.cwd ?? null,
          title: input.title ?? null,
          mode: input.mode ?? "auto",
          agentId: input.agentId,
          displayName: input.displayName ?? input.agentId,
          clientKind: input.clientKind ?? "generic",
          parentSessionId: input.parentSessionId ?? null,
          threadId: input.threadId ?? null,
          role: input.role ?? "PRIMARY",
          gitBranch: input.gitBranch ?? null,
          gitHead: input.gitHead ?? null,
          resume: input.resume ?? false,
          predecessorSessionId: input.predecessorSessionId ?? null,
          signals: input.signals ?? {},
          allowProjectCreate: input.allowProjectCreate ?? false,
          creationReason: input.creationReason ?? null,
        },
        sessionInput,
      );
      session = recovered;
      atomicBegin = { operationId, disposition: recovered.disposition };
    } else {
      session = repository.createSession(sessionInput);
    }
    const projection = await this.#projection.flush(project.code);
    return {
      scope: "project",
      project: project.code,
      session: session.id,
      score: classification.score,
      projection,
      ...(atomicBegin === null ? {} : { atomicBegin }),
    };
  }

  async assertSessionCanProvisionPlanningRoot(
    projectCode: string,
    sessionId: string,
    getSession: (
      projectCode: string,
      sessionId: string,
    ) => Promise<{
      connectionState: string;
      closeReason: string | null;
    }>,
  ): Promise<void> {
    const session = await getSession(projectCode, sessionId);
    if (session.connectionState !== "ONLINE" && session.closeReason !== "HEARTBEAT_TIMEOUT") {
      throw new AtmError("SESSION_CLOSED", {
        message: sessionId,
        details: { entity: "SESSION", session_id: sessionId, reference: sessionId },
      });
    }
  }

  async end(
    projectCode: string,
    sessionId: string,
    opId: string,
    input: Parameters<ProjectRepository["endSession"]>[2],
  ) {
    const repository = await this.#runtime.repository(projectCode);
    const resolution = repository.resolveMutationActor(sessionId, opId, "session.end", input);
    const effectiveSessionId = String(resolution.actor.sessionId);
    if (resolution.disposition !== "REPLAY") {
      await this.refreshSessionGitContext(projectCode, effectiveSessionId);
    }
    const result = repository.endSession(resolution.actor, opId, input);
    const projection = await this.#projection.flush(projectCode);
    await this.#metrics.captureWorkItemEngineeringMetrics(
      projectCode,
      result.releasedItems.map((task) => task.key),
      false,
    );
    return mutationAck(result, opId, resolution, projection);
  }

  async forceCloseSessionAsUser(projectCode: string, sessionId: string, releaseClaims = true) {
    const repository = await this.#runtime.repository(projectCode);
    const result = repository.forceCloseSession(sessionId, releaseClaims);
    const projection = await this.#projection.flush(projectCode);
    return projectMutationReceipt(result, projection);
  }

  async refreshSessionGitContextAsUser(projectCode: string, sessionId: string) {
    const result = await this.refreshSessionGitContext(projectCode, sessionId);
    const projection = await this.#projection.flush(projectCode);
    return {
      ...result,
      projection,
      session: (await this.#runtime.repository(projectCode)).getSessionView(sessionId),
    };
  }

  async refreshSessionGitContext(projectCode: string, sessionId: string) {
    const repository = await this.#runtime.repository(projectCode);
    const session = repository.getSession(sessionId);
    if (!session.cwd) return { updated: false, sequence: repository.meta.sequence };
    return repository.updateSessionGitContext(sessionId, inspectGitContext(String(session.cwd)));
  }
}
