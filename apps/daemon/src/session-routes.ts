import type { FastifyInstance } from "fastify";
import { AtmError } from "@ayanami-task/errors";
import {
  BeginInputSchema,
  EndInputSchema,
  QuickTaskCreateInputSchema,
} from "@ayanami-task/protocol";
import type { AyanamiServerOptions } from "./server-options.js";

export function registerSessionRoutes(app: FastifyInstance, options: AyanamiServerOptions): void {
  app.post("/api/v1/sessions", async (request, reply) => {
    const input = BeginInputSchema.parse(request.body);
    return reply.code(201).send(
      await options.service.begin({
        ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
        mode: input.mode,
        agentId: input.agentId,
        clientKind: input.clientKind,
        role: input.role,
        resume: input.resume,
        maxChars: input.maxChars,
        signals: {
          ...(input.signals.expectedMinutes === undefined
            ? {}
            : { expectedMinutes: input.signals.expectedMinutes }),
          ...(input.signals.subtaskCount === undefined
            ? {}
            : { subtaskCount: input.signals.subtaskCount }),
          ...(input.signals.multiSession === undefined
            ? {}
            : { multiSession: input.signals.multiSession }),
          ...(input.signals.multiAgent === undefined
            ? {}
            : { multiAgent: input.signals.multiAgent }),
          ...(input.signals.hasDependencies === undefined
            ? {}
            : { hasDependencies: input.signals.hasDependencies }),
          ...(input.signals.needsEvidence === undefined
            ? {}
            : { needsEvidence: input.signals.needsEvidence }),
          ...(input.signals.hasTargetDate === undefined
            ? {}
            : { hasTargetDate: input.signals.hasTargetDate }),
        },
        allowProjectCreate: input.allowProjectCreate,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.projectCode === undefined ? {} : { projectCode: input.projectCode }),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
        ...(input.predecessorSessionId === undefined
          ? {}
          : { predecessorSessionId: input.predecessorSessionId }),
        ...(input.creationReason === undefined ? {} : { creationReason: input.creationReason }),
      }),
    );
  });
  app.post("/api/v1/sessions/:id/close", async (request) => {
    const { id } = request.params as { id: string };
    const raw = request.body as Record<string, unknown>;
    const input = EndInputSchema.parse({ ...raw, session: id });
    return options.service.end(input.project, id, input.opId, {
      outcome: input.outcome,
      summary: input.summary,
      next: input.next,
      releaseClaims: input.releaseClaims,
      ...(input.retirementReason === undefined ? {} : { retirementReason: input.retirementReason }),
    });
  });
  app.post("/api/v1/sessions/:id/force-close", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.project !== "string")
      throw new AtmError("PROJECT_REQUIRED", { message: "关闭 Session 需要 project" });
    return options.service.forceCloseSessionAsUser(body.project, id, body.releaseClaims !== false);
  });
  app.post("/api/v1/projects/:code/sessions/:id/git-context/refresh", async (request) => {
    const { code, id } = request.params as { code: string; id: string };
    return options.service.refreshSessionGitContextAsUser(code, id);
  });

  app.get("/api/v1/quick-tasks", async (request) => {
    const { status } = request.query as { status?: string };
    return options.service.listQuickTasks(status);
  });
  app.post("/api/v1/quick-tasks", async (request, reply) => {
    const input = QuickTaskCreateInputSchema.parse(request.body);
    return reply.code(201).send(
      options.service.createQuickTask({
        title: input.title,
        note: input.note,
        actor: input.actor,
        ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate }),
        ...(input.sourceCwd === undefined ? {} : { sourceCwd: input.sourceCwd }),
      }),
    );
  });
  app.patch("/api/v1/quick-tasks/:id", async (request) => {
    const { id } = request.params as { id: string };
    return options.service.updateQuickTask(id, request.body as any);
  });
  app.post("/api/v1/quick-tasks/:id/promote", async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    return options.service.promoteQuickTask({
      quickTask: id,
      expectedVersion: Number(body.expectedVersion),
      ...(typeof body.targetProjectCode === "string"
        ? { targetProjectCode: body.targetProjectCode }
        : {}),
      ...(typeof body.actor === "string" ? { actor: body.actor } : {}),
    });
  });
}
