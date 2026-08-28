import type { FastifyInstance } from "fastify";
import { AtmError } from "@ayanami-task/errors";
import { CreateProjectInputSchema } from "@ayanami-task/protocol";
import { requestOpId } from "./rest-route-helpers.js";
import type { AyanamiServerOptions } from "./server-options.js";

export function registerProjectRoutes(
  app: FastifyInstance,
  options: AyanamiServerOptions,
  version: string,
): void {
  app.get("/api/v1/system/status", async () => {
    const doctor = await options.service.doctor();
    return {
      ok: doctor.registry.ok && doctor.projects.every((project) => project.ok),
      version,
      sqlite: doctor.registry,
      projectCount: doctor.projects.length,
      projectCounts: doctor.projectCounts,
      projectFailures: doctor.projects.filter((project) => !project.ok),
      projectionSummary: doctor.projectionSummary,
      projectionFailures: doctor.projectionFailures,
      at: new Date().toISOString(),
    };
  });
  app.get("/api/v1/overview", async () => options.service.overview());

  app.post("/api/v1/projects/:code/projection/reconcile", async (request) => {
    const { code } = request.params as { code: string };
    return options.service.reconcileProjection(code);
  });

  app.post("/api/v1/system/projections/reconcile", async () =>
    options.service.reconcileProjections(),
  );

  app.get("/api/v1/saved-views", async (request) => {
    const { project } = request.query as { project?: string };
    return options.service.listSavedViews(project);
  });
  app.post("/api/v1/saved-views", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if ((body.scope !== "GLOBAL" && body.scope !== "PROJECT") || typeof body.name !== "string") {
      throw new AtmError("VALIDATION_ERROR", { message: "scope 和 name 必填" });
    }
    if (body.scope === "PROJECT" && typeof body.project !== "string") {
      throw new AtmError("PROJECT_REQUIRED", { message: "项目视图需要 project" });
    }
    return reply.code(201).send(
      options.service.createSavedView({
        scope: body.scope,
        ...(typeof body.project === "string" ? { project: body.project } : {}),
        name: body.name,
        query:
          body.query && typeof body.query === "object"
            ? (body.query as Record<string, unknown>)
            : {},
        sort:
          body.sort && typeof body.sort === "object" ? (body.sort as Record<string, unknown>) : {},
      }),
    );
  });
  app.patch("/api/v1/saved-views/:id", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (!Number.isInteger(body.expectedVersion))
      throw new AtmError("VALIDATION_ERROR", { message: "expectedVersion 必填" });
    return options.service.updateSavedView(id, {
      expectedVersion: Number(body.expectedVersion),
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(body.query && typeof body.query === "object"
        ? { query: body.query as Record<string, unknown> }
        : {}),
      ...(body.sort && typeof body.sort === "object"
        ? { sort: body.sort as Record<string, unknown> }
        : {}),
    });
  });
  app.delete("/api/v1/saved-views/:id", async (request) => {
    const { id } = request.params as { id: string };
    const { expectedVersion } = request.query as { expectedVersion?: string };
    if (!expectedVersion || !Number.isInteger(Number(expectedVersion)))
      throw new AtmError("VALIDATION_ERROR", { message: "expectedVersion 必填" });
    return options.service.deleteSavedView(id, Number(expectedVersion));
  });
  app.get("/api/v1/settings", async () => options.service.listSettings());
  app.put("/api/v1/settings/:key", async (request) => {
    const { key } = request.params as { key: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (!("value" in body)) throw new AtmError("VALIDATION_ERROR", { message: "value 必填" });
    const expectedVersion =
      body.expectedVersion === undefined ? undefined : Number(body.expectedVersion);
    if (expectedVersion !== undefined && !Number.isInteger(expectedVersion))
      throw new AtmError("VALIDATION_ERROR", { message: "expectedVersion 无效" });
    return options.service.setSetting(key, body.value, expectedVersion);
  });

  app.get("/api/v1/projects", async () => options.service.listProjects());
  app.post("/api/v1/projects", async (request, reply) => {
    const input = CreateProjectInputSchema.parse(request.body);
    const project = await options.service.createProject({
      name: input.name,
      sourcePath: input.sourcePath,
      description: input.description,
      coordinationMode: input.coordinationMode,
      creationSignals: input.creationSignals,
      ...(input.code === undefined ? {} : { code: input.code }),
      ...(input.creationReason === undefined ? {} : { creationReason: input.creationReason }),
    });
    return reply.code(201).send(project);
  });
  app.get("/api/v1/projects/:code", async (request) => {
    const { code } = request.params as { code: string };
    return options.service.databases.getProject(code);
  });
  app.post("/api/v1/projects/:code/paths", async (request) => {
    const { code } = request.params as { code: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.path !== "string" || !body.path.trim()) {
      throw new AtmError("VALIDATION_ERROR", { message: "path 必填" });
    }
    return options.service.attachProjectPath(code, body.path, body.primary !== false);
  });
  app.get("/api/v1/projects/:code/engineering-metrics", async (request) => {
    const { code } = request.params as { code: string };
    const { task, refresh } = request.query as { task?: string; refresh?: string };
    return options.service.engineeringMetrics(code, {
      ...(task ? { taskKey: task } : {}),
      refresh: refresh === "true" || refresh === "1",
    });
  });
  app.post("/api/v1/projects/:code/archive", async (request) => {
    const { code } = request.params as { code: string };
    return options.service.archiveProject(code);
  });
  app.post("/api/v1/projects/:code/restore", async (request) => {
    const { code } = request.params as { code: string };
    return options.service.restoreProject(code);
  });
  app.post("/api/v1/projects/:code/trash", async (request) => {
    const { code } = request.params as { code: string };
    return options.service.trashProject(code);
  });
  app.get("/api/v1/backups", async (request) => {
    const { project } = request.query as { project?: string };
    return options.service.listBackups(project);
  });
  app.post("/api/v1/backups", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const scope = body.scope === "REGISTRY" ? "REGISTRY" : "PROJECT";
    if (scope === "PROJECT" && typeof body.project !== "string") {
      throw new AtmError("PROJECT_REQUIRED", { message: "项目备份需要 project" });
    }
    const backup = await options.service.createBackup({
      scope,
      ...(typeof body.project === "string" ? { project: body.project } : {}),
      reason: "MANUAL",
    });
    return reply.code(201).send(backup);
  });
  app.post("/api/v1/backups/:id/restore", async (request) => {
    const { id } = request.params as { id: string };
    return options.service.restoreBackup(id);
  });
  app.post("/api/v1/imports/agenttask-md/preview", async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.project !== "string" || typeof body.content !== "string") {
      throw new AtmError("VALIDATION_ERROR", { message: "project 和 content 必填" });
    }
    return options.service.previewAgentTaskImport(
      body.project,
      body.content,
      typeof body.sourceName === "string" ? body.sourceName : "agenttask.md",
    );
  });
  app.post("/api/v1/imports/agenttask-md/apply", async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.project !== "string" || typeof body.content !== "string") {
      throw new AtmError("VALIDATION_ERROR", { message: "project 和 content 必填" });
    }
    return options.service.applyAgentTaskImport(
      body.project,
      body.content,
      typeof body.sourceName === "string" ? body.sourceName : "agenttask.md",
      typeof body.expectedSha256 === "string" ? body.expectedSha256 : undefined,
    );
  });
  app.get("/api/v1/exports/:projectCode", async (request) => {
    const { projectCode } = request.params as { projectCode: string };
    const { format: rawFormat } = request.query as { format?: string };
    const format = rawFormat ?? "aytproj";
    if (!(["aytproj", "json", "csv"] as string[]).includes(format)) {
      throw new AtmError("VALIDATION_ERROR", { message: "format 必须是 aytproj、json 或 csv" });
    }
    return options.service.exportProject(projectCode, format as "aytproj" | "json" | "csv");
  });
  app.get("/api/v1/projects/:code/objectives", async (request) => {
    const { code } = request.params as { code: string };
    return options.service.listObjectives(code);
  });
  app.get("/api/v1/projects/:code/milestones", async (request) => {
    const { code } = request.params as { code: string };
    const { objective } = request.query as { objective?: string };
    return options.service.listMilestones(code, objective);
  });
  app.get("/api/v1/projects/:code/agents", async (request) => {
    const { code } = request.params as { code: string };
    const { limit, cursor } = request.query as { limit?: string; cursor?: string };
    const page = await options.service.agentPage(code, {
      limit: Number(limit ?? 100),
      ...(cursor ? { cursor } : {}),
    });
    return { items: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore };
  });
  app.get("/api/v1/projects/:code/sessions/:sessionId", async (request) => {
    const { code, sessionId } = request.params as { code: string; sessionId: string };
    return options.service.getSession(code, sessionId);
  });
  app.get("/api/v1/projects/:code/reconciliation", async (request) => {
    const { code } = request.params as { code: string };
    const { include_active: includeActive } = request.query as { include_active?: string };
    return options.service.reconcileProject(code, {
      includeActive: includeActive === "1" || includeActive === "true",
    });
  });
  app.get("/api/v1/projects/:code/records", async (request) => {
    const { code } = request.params as { code: string };
    const { limit, cursor } = request.query as { limit?: string; cursor?: string };
    const page = await options.service.recordPage(code, {
      limit: Number(limit ?? 100),
      ...(cursor ? { cursor } : {}),
    });
    return { items: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore };
  });
  app.get("/api/v1/projects/:code/records/:recordKey", async (request) => {
    const { code, recordKey } = request.params as { code: string; recordKey: string };
    return options.service.getRecord(code, recordKey);
  });
  app.get("/api/v1/projects/:code/progress-updates/:progressId", async (request) => {
    const { code, progressId } = request.params as { code: string; progressId: string };
    return options.service.getProgressUpdate(code, progressId);
  });
  app.get("/api/v1/projects/:code/project-updates", async (request) => {
    const { code } = request.params as { code: string };
    const { limit } = request.query as { limit?: string };
    return options.service.listProjectUpdates(code, Number(limit ?? 50));
  });
  app.get("/api/v1/projects/:code/project-updates/:updateId", async (request) => {
    const { code, updateId } = request.params as { code: string; updateId: string };
    return options.service.getProjectUpdate(code, updateId);
  });
  app.get("/api/v1/projects/:code/operations/:opId", async (request) => {
    const { code, opId } = request.params as { code: string; opId: string };
    const { session } = (request.query ?? {}) as { session?: string };
    return options.service.getOperationTrace(code, opId, session);
  });
  app.post("/api/v1/projects/:code/project-updates/draft", async (request, reply) => {
    const { code } = request.params as { code: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    return reply
      .code(201)
      .send(await options.service.draftProjectUpdateAsUser(code, requestOpId(body)));
  });
  app.post("/api/v1/projects/:code/project-updates", async (request, reply) => {
    const { code } = request.params as { code: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const health = typeof body.health === "string" ? body.health : "UNKNOWN";
    if (
      !(["ON_TRACK", "AT_RISK", "OFF_TRACK", "UNKNOWN"] as string[]).includes(health) ||
      typeof body.summary !== "string" ||
      !body.summary.trim()
    ) {
      throw new AtmError("VALIDATION_ERROR", { message: "health 和 summary 无效" });
    }
    return reply.code(201).send(
      await options.service.publishProjectUpdateAsUser(code, requestOpId(body), {
        health: health as "ON_TRACK" | "AT_RISK" | "OFF_TRACK" | "UNKNOWN",
        summary: body.summary,
        ...(typeof body.draftId === "string" ? { draftId: body.draftId } : {}),
        ...(Array.isArray(body.completed) ? { completed: body.completed.map(String) } : {}),
        ...(Array.isArray(body.risks) ? { risks: body.risks.map(String) } : {}),
        ...(Array.isArray(body.next) ? { next: body.next.map(String) } : {}),
      }),
    );
  });
  app.get("/api/v1/projects/:code/brief", async (request) => {
    const { code } = request.params as { code: string };
    const { session } = (request.query ?? {}) as { session?: string };
    return options.service.brief(code, session);
  });
}
