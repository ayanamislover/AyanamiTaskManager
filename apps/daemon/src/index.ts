import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import {
  BeginInputSchema,
  ChecklistUpdateInputSchema,
  CreateMilestoneInputSchema,
  CreateObjectiveInputSchema,
  CreateProjectInputSchema,
  DeltaInputSchema,
  EndInputSchema,
  ProgressAddInputSchema,
  QuickTaskCreateInputSchema,
  RecordInputSchema,
  SearchInputSchema,
  TaskCreateBatchInputSchema,
  TaskPatchBatchInputSchema,
} from "@ayanami-task/protocol";
import type { AyanamiTaskService } from "@ayanami-task/application";
import { handleAyanamiMcpHttp } from "@ayanami-task/mcp";

export type AyanamiServerOptions = {
  service: AyanamiTaskService;
  token: string;
};

function bearer(request: FastifyRequest): string | null {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) return null;
  return value.slice("Bearer ".length);
}

function errorCode(error: unknown): string {
  if (!(error instanceof Error)) return "INTERNAL_ERROR";
  const candidate = error.message.split(":", 1)[0]!.trim();
  return /^[A-Z][A-Z0-9_]+$/u.test(candidate) ? candidate : "INTERNAL_ERROR";
}

function statusForCode(code: string): number {
  if (code === "NOT_FOUND" || code.endsWith("_NOT_FOUND")) return 404;
  if (
    code === "VALIDATION_ERROR" ||
    code.includes("REQUIRED") ||
    code.includes("INVALID") ||
    code.includes("HASH_MISMATCH") ||
    code.includes("MANIFEST_MISMATCH") ||
    code.includes("INTEGRITY_FAILED")
  )
    return 422;
  if (code === "UNAUTHORIZED") return 401;
  if (code === "FORBIDDEN") return 403;
  if (
    code.includes("CONFLICT") ||
    code.includes("CYCLE") ||
    code.includes("CLAIMED") ||
    code.includes("COMPLETION_GATE") ||
    code.includes("DEPENDENCY_NOT_READY") ||
    code.includes("PROJECT_REQUIRED") ||
    code.includes("MIGRATION")
  )
    return 409;
  return 500;
}

function assertToken(request: FastifyRequest, token: string): void {
  if (bearer(request) !== token) throw new Error("UNAUTHORIZED: 本地访问令牌无效");
}

function requestOpId(body: Record<string, unknown>): string {
  if (typeof body.opId !== "string" || !body.opId.trim() || body.opId.length > 128) {
    throw new Error("VALIDATION_ERROR: opId 必填且不超过 128 字符");
  }
  return body.opId.trim();
}

export async function buildAyanamiServer(options: AyanamiServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 10 * 1024 * 1024,
    requestIdHeader: "x-request-id",
  });
  await app.register(cors, {
    origin(origin, callback) {
      if (!origin || /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/iu.test(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("FORBIDDEN: 仅允许本机页面访问"), false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  app.setErrorHandler((error, request, reply) => {
    const code = errorCode(error);
    reply.code(statusForCode(code)).send({
      error: { code, message: error instanceof Error ? error.message : String(error) },
      request_id: request.id,
    });
  });
  app.addHook("preValidation", async (request) => {
    if (request.method === "OPTIONS") return;
    if (request.url.startsWith("/api/v1/ws")) return;
    assertToken(request, options.token);
  });

  app.get("/api/v1/system/status", async () => {
    const doctor = await options.service.doctor();
    return {
      ok: doctor.registry.ok && doctor.projects.every((project) => project.ok),
      version: "1.0.1",
      sqlite: doctor.registry,
      projectCount: doctor.projects.length,
      at: new Date().toISOString(),
    };
  });
  app.get("/api/v1/overview", async () => options.service.overview());

  app.get("/api/v1/saved-views", async (request) => {
    const { project } = request.query as { project?: string };
    return options.service.listSavedViews(project);
  });
  app.post("/api/v1/saved-views", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if ((body.scope !== "GLOBAL" && body.scope !== "PROJECT") || typeof body.name !== "string") {
      throw new Error("VALIDATION_ERROR: scope 和 name 必填");
    }
    if (body.scope === "PROJECT" && typeof body.project !== "string") {
      throw new Error("PROJECT_REQUIRED: 项目视图需要 project");
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
      throw new Error("VALIDATION_ERROR: expectedVersion 必填");
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
      throw new Error("VALIDATION_ERROR: expectedVersion 必填");
    return options.service.deleteSavedView(id, Number(expectedVersion));
  });
  app.get("/api/v1/settings", async () => options.service.listSettings());
  app.put("/api/v1/settings/:key", async (request) => {
    const { key } = request.params as { key: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (!("value" in body)) throw new Error("VALIDATION_ERROR: value 必填");
    const expectedVersion =
      body.expectedVersion === undefined ? undefined : Number(body.expectedVersion);
    if (expectedVersion !== undefined && !Number.isInteger(expectedVersion))
      throw new Error("VALIDATION_ERROR: expectedVersion 无效");
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
      throw new Error("VALIDATION_ERROR: path 必填");
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
      throw new Error("PROJECT_REQUIRED: 项目备份需要 project");
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
      throw new Error("VALIDATION_ERROR: project 和 content 必填");
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
      throw new Error("VALIDATION_ERROR: project 和 content 必填");
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
      throw new Error("VALIDATION_ERROR: format 必须是 aytproj、json 或 csv");
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
    const { limit } = request.query as { limit?: string };
    return options.service.listAgentSessions(code, Number(limit ?? 100));
  });
  app.get("/api/v1/projects/:code/records", async (request) => {
    const { code } = request.params as { code: string };
    const { limit } = request.query as { limit?: string };
    return options.service.listRecords(code, Number(limit ?? 100));
  });
  app.get("/api/v1/projects/:code/project-updates", async (request) => {
    const { code } = request.params as { code: string };
    const { limit } = request.query as { limit?: string };
    return options.service.listProjectUpdates(code, Number(limit ?? 50));
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
      throw new Error("VALIDATION_ERROR: health 和 summary 无效");
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
  app.post("/api/v1/projects/:code/objectives", async (request, reply) => {
    const { code } = request.params as { code: string };
    const body = request.body as Record<string, unknown>;
    const session = String(body.session ?? "");
    const input = CreateObjectiveInputSchema.parse(body);
    return reply.code(201).send(await options.service.createObjective(code, session, input));
  });
  app.post("/api/v1/projects/:code/milestones", async (request, reply) => {
    const { code } = request.params as { code: string };
    const body = request.body as Record<string, unknown>;
    const session = String(body.session ?? "");
    const input = CreateMilestoneInputSchema.parse(body);
    return reply.code(201).send(
      await options.service.createMilestone(code, session, {
        objectiveId: input.objectiveId,
        title: input.title,
        description: input.description,
        ...(input.targetDate === undefined ? {} : { targetDate: input.targetDate }),
      }),
    );
  });
  app.post("/api/v1/projects/:code/ui/objectives", async (request, reply) => {
    const { code } = request.params as { code: string };
    const body = request.body as Record<string, unknown>;
    const input = CreateObjectiveInputSchema.parse(body);
    return reply
      .code(201)
      .send(await options.service.createObjectiveAsUser(code, requestOpId(body), input));
  });
  app.post("/api/v1/projects/:code/ui/milestones", async (request, reply) => {
    const { code } = request.params as { code: string };
    const body = request.body as Record<string, unknown>;
    const input = CreateMilestoneInputSchema.parse(body);
    return reply.code(201).send(
      await options.service.createMilestoneAsUser(code, requestOpId(body), {
        objectiveId: input.objectiveId,
        title: input.title,
        description: input.description,
        ...(input.targetDate === undefined ? {} : { targetDate: input.targetDate }),
      }),
    );
  });
  app.post("/api/v1/projects/:code/ui/work-items", async (request, reply) => {
    const { code } = request.params as { code: string };
    const body = request.body as Record<string, unknown>;
    const parsed = TaskCreateBatchInputSchema.parse({ ...body, project: code, session: "USER" });
    return reply.code(201).send(
      await options.service.createWorkItemsAsUser(
        code,
        parsed.opId,
        parsed.items.map((item) => ({
          clientRef: item.clientRef,
          objectiveId: item.objectiveId,
          dependsOn: item.dependsOn,
          dependsOnRefs: item.dependsOnRefs,
          ...(item.discoveredFrom === undefined ? {} : { discoveredFrom: item.discoveredFrom }),
          ...(item.discoveredFromRef === undefined
            ? {}
            : { discoveredFromRef: item.discoveredFromRef }),
          title: item.title,
          description: item.description,
          type: item.type,
          priority: item.priority,
          status: item.status,
          acceptance: item.acceptance,
          checklist: item.checklist,
          weight: item.weight,
          verificationRequired: item.verificationRequired,
          ...(item.milestoneId === undefined ? {} : { milestoneId: item.milestoneId }),
          ...(item.parentKey === undefined ? {} : { parentKey: item.parentKey }),
          ...(item.parentRef === undefined ? {} : { parentRef: item.parentRef }),
          ...(item.targetDate === undefined ? {} : { targetDate: item.targetDate }),
        })),
      ),
    );
  });
  app.post("/api/v1/projects/:code/ui/work-items/patch", async (request) => {
    const { code } = request.params as { code: string };
    const body = request.body as Record<string, unknown>;
    const parsed = TaskPatchBatchInputSchema.parse({ ...body, project: code, session: "USER" });
    return options.service.patchWorkItemsAsUser(
      code,
      parsed.opId,
      parsed.items.map((item) => ({
        taskKey: item.taskKey,
        expectedVersion: item.expectedVersion,
        operation: item.operation,
        takeoverStale: item.takeoverStale,
        ...(item.title === undefined ? {} : { title: item.title }),
        ...(item.description === undefined ? {} : { description: item.description }),
        ...(item.blockedReason === undefined ? {} : { blockedReason: item.blockedReason }),
        ...(item.waitingFor === undefined ? {} : { waitingFor: item.waitingFor }),
        ...(item.assigneeAgentId === undefined ? {} : { assigneeAgentId: item.assigneeAgentId }),
        ...(item.targetDate === undefined ? {} : { targetDate: item.targetDate }),
        ...(item.parentKey === undefined ? {} : { parentKey: item.parentKey }),
      })),
    );
  });
  app.patch("/api/v1/projects/:code/ui/checklist/:id", async (request) => {
    const { code, id } = request.params as { code: string; id: string };
    const body = request.body as Record<string, unknown>;
    const input = ChecklistUpdateInputSchema.parse({ ...body, checklistId: id });
    return options.service.updateChecklistAsUser(code, requestOpId(body), {
      checklistId: input.checklistId,
      expectedVersion: input.expectedVersion,
      status: input.status,
      ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
    });
  });
  app.get("/api/v1/projects/:code/work-items", async (request) => {
    const { code } = request.params as { code: string };
    const query = request.query as Record<string, string | undefined>;
    return options.service.listWorkItems(code, {
      ...(query.status ? { status: query.status } : {}),
      ...(query.assignee ? { assigneeAgentId: query.assignee } : {}),
      ...(query.milestone ? { milestoneId: query.milestone } : {}),
      ...(query.q ? { query: query.q } : {}),
      readyOnly: query.ready === "1",
      limit: Number(query.limit ?? 20),
      offset: Number(query.offset ?? 0),
    });
  });
  app.post("/api/v1/projects/:code/work-items", async (request, reply) => {
    const { code } = request.params as { code: string };
    const parsed = TaskCreateBatchInputSchema.parse({ ...(request.body as object), project: code });
    return reply.code(201).send(
      await options.service.createWorkItems(
        code,
        parsed.session,
        parsed.opId,
        parsed.items.map((item) => ({
          clientRef: item.clientRef,
          objectiveId: item.objectiveId,
          dependsOn: item.dependsOn,
          dependsOnRefs: item.dependsOnRefs,
          ...(item.discoveredFrom === undefined ? {} : { discoveredFrom: item.discoveredFrom }),
          ...(item.discoveredFromRef === undefined
            ? {}
            : { discoveredFromRef: item.discoveredFromRef }),
          title: item.title,
          description: item.description,
          type: item.type,
          priority: item.priority,
          status: item.status,
          acceptance: item.acceptance,
          checklist: item.checklist,
          weight: item.weight,
          verificationRequired: item.verificationRequired,
          ...(item.milestoneId === undefined ? {} : { milestoneId: item.milestoneId }),
          ...(item.parentKey === undefined ? {} : { parentKey: item.parentKey }),
          ...(item.parentRef === undefined ? {} : { parentRef: item.parentRef }),
          ...(item.targetDate === undefined ? {} : { targetDate: item.targetDate }),
        })),
      ),
    );
  });
  app.post("/api/v1/projects/:code/work-items/patch", async (request) => {
    const { code } = request.params as { code: string };
    const parsed = TaskPatchBatchInputSchema.parse({ ...(request.body as object), project: code });
    return options.service.patchWorkItems(
      code,
      parsed.session,
      parsed.opId,
      parsed.items.map((item) => ({
        taskKey: item.taskKey,
        expectedVersion: item.expectedVersion,
        operation: item.operation,
        takeoverStale: item.takeoverStale,
        ...(item.title === undefined ? {} : { title: item.title }),
        ...(item.description === undefined ? {} : { description: item.description }),
        ...(item.blockedReason === undefined ? {} : { blockedReason: item.blockedReason }),
        ...(item.waitingFor === undefined ? {} : { waitingFor: item.waitingFor }),
        ...(item.assigneeAgentId === undefined ? {} : { assigneeAgentId: item.assigneeAgentId }),
        ...(item.targetDate === undefined ? {} : { targetDate: item.targetDate }),
        ...(item.parentKey === undefined ? {} : { parentKey: item.parentKey }),
      })),
    );
  });
  app.get("/api/v1/projects/:code/work-items/:taskKey", async (request) => {
    const { code, taskKey } = request.params as { code: string; taskKey: string };
    const { view } = request.query as { view?: "core" | "context" | "full" };
    return options.service.getWorkItem(code, taskKey, view ?? "core");
  });
  app.patch("/api/v1/projects/:code/checklist/:id", async (request) => {
    const { code, id } = request.params as { code: string; id: string };
    const body = request.body as Record<string, unknown>;
    const session = String(body.session ?? "");
    const opId = String(body.opId ?? "");
    const input = ChecklistUpdateInputSchema.parse({ ...body, checklistId: id });
    return options.service.updateChecklist(code, session, opId, {
      checklistId: input.checklistId,
      expectedVersion: input.expectedVersion,
      status: input.status,
      ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
    });
  });
  app.post("/api/v1/projects/:code/progress-updates", async (request) => {
    const { code } = request.params as { code: string };
    const input = ProgressAddInputSchema.parse({ ...(request.body as object), project: code });
    if (input.scope === "project") {
      return options.service.addProjectProgress(code, input.session, input.opId, {
        summary: input.summary,
        completed: input.completed,
        next: input.next,
        ...(input.health === undefined ? {} : { health: input.health }),
        ...(input.blocker === undefined ? {} : { blocker: input.blocker }),
      });
    }
    if (!input.taskKey) throw new Error("VALIDATION_ERROR: task scope 要求 taskKey");
    return options.service.addProgress(code, input.session, input.opId, {
      taskKey: input.taskKey,
      ...(input.percent === undefined ? {} : { percent: input.percent }),
      summary: input.summary,
      completed: input.completed,
      next: input.next,
      evidence: input.evidence,
      ...(input.blocker === undefined ? {} : { blocker: input.blocker }),
    });
  });
  app.post("/api/v1/projects/:code/records", async (request, reply) => {
    const { code } = request.params as { code: string };
    const input = RecordInputSchema.parse({ ...(request.body as object), project: code });
    return reply.code(201).send(
      await options.service.createRecord(code, input.session, input.opId, {
        kind: input.kind,
        title: input.title,
        summary: input.summary,
        detail: input.detail,
        importance: input.importance,
        scope: input.scope,
        ...(input.workItemKey === undefined ? {} : { workItemKey: input.workItemKey }),
        ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
      }),
    );
  });
  app.post("/api/v1/projects/:code/ui/records", async (request, reply) => {
    const { code } = request.params as { code: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const input = RecordInputSchema.parse({ ...body, project: code, session: "USER" });
    return reply.code(201).send(
      await options.service.createRecordAsUser(code, input.opId, {
        kind: input.kind,
        title: input.title,
        summary: input.summary,
        detail: input.detail,
        importance: input.importance,
        scope: input.scope,
        ...(input.workItemKey === undefined ? {} : { workItemKey: input.workItemKey }),
        ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
      }),
    );
  });
  app.get("/api/v1/projects/:code/search", async (request) => {
    const { code } = request.params as { code: string };
    const raw = request.query as Record<string, unknown>;
    const query = SearchInputSchema.parse({
      ...raw,
      project: code,
      ...(raw.limit === undefined ? {} : { limit: Number(raw.limit) }),
    });
    return options.service.search(code, query.query, query.limit);
  });
  app.get("/api/v1/search", async (request) => {
    const raw = request.query as Record<string, unknown>;
    const query = SearchInputSchema.parse({
      ...raw,
      ...(raw.limit === undefined ? {} : { limit: Number(raw.limit) }),
    });
    return { hits: options.service.globalSearch(query.query, query.limit) };
  });
  app.get("/api/v1/projects/:code/events", async (request) => {
    const { code } = request.params as { code: string };
    const raw = request.query as Record<string, unknown>;
    const query = DeltaInputSchema.parse({
      project: code,
      sinceSeq: Number(raw.since ?? raw.sinceSeq ?? 0),
      limit: Number(raw.limit ?? 50),
      types: typeof raw.types === "string" ? raw.types.split(",").filter(Boolean) : [],
    });
    return options.service.delta(code, query.sinceSeq, query.limit, query.types);
  });
  app.post("/api/v1/sessions", async (request, reply) => {
    const input = BeginInputSchema.parse(request.body);
    return reply.code(201).send(
      await options.service.begin({
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
      throw new Error("PROJECT_REQUIRED: 关闭 Session 需要 project");
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

  app.post("/mcp", async (request, reply) => {
    reply.hijack();
    await handleAyanamiMcpHttp(request.raw, reply.raw, request.body, options.service);
  });
  for (const method of ["GET", "DELETE"] as const) {
    app.route({
      method,
      url: "/mcp",
      handler: async (_request, reply) =>
        reply.code(405).send({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed for stateless MCP transport" },
          id: null,
        }),
    });
  }

  await app.register(websocket, {
    options: { maxPayload: 64 * 1024, perMessageDeflate: false },
  });
  app.get("/api/v1/ws", { websocket: true }, (socket, request) => {
    const query = request.query as { scope?: string; since?: string };
    let authenticated = false;
    let closed = false;
    let unsubscribe: (() => void) | null = null;
    let lastSequence = Math.max(0, Number(query.since ?? 0));
    const projectCode = query.scope?.startsWith("project:")
      ? query.scope.slice("project:".length).toUpperCase()
      : null;
    const globalScope = query.scope === "global";
    const deadline = setTimeout(() => {
      if (!authenticated) socket.close(1008, "Authentication required");
    }, 3000);
    deadline.unref();

    const sendGap = async () => {
      if (!authenticated || closed || (!projectCode && !globalScope) || socket.readyState !== 1)
        return;
      if (socket.bufferedAmount > 1024 * 1024) {
        socket.send(JSON.stringify({ type: "resync_required", reason: "bounded_queue_overflow" }));
        unsubscribe?.();
        unsubscribe = null;
        return;
      }
      const delta = projectCode
        ? await options.service.delta(projectCode, lastSequence, 100)
        : options.service.globalDelta(lastSequence, 100);
      for (const event of delta.events) {
        socket.send(
          JSON.stringify({
            scope: projectCode ?? "global",
            seq: event.seq,
            type: event.type,
            key: event.key,
            summary: event.summary,
            at: event.at,
          }),
        );
        lastSequence = event.seq;
      }
      if (delta.hasMore) await sendGap();
    };

    socket.on("message", (buffer: { toString(): string }) => {
      try {
        const frame = JSON.parse(buffer.toString()) as Record<string, unknown>;
        if (!authenticated) {
          if (
            frame.type !== "authenticate" ||
            frame.token !== options.token ||
            (!projectCode && !globalScope)
          ) {
            socket.close(1008, "Authentication failed");
            return;
          }
          authenticated = true;
          clearTimeout(deadline);
          socket.send(JSON.stringify({ type: "authenticated" }));
          void sendGap().then(() => {
            unsubscribe = projectCode
              ? options.service.subscribeProject(projectCode, () => void sendGap())
              : options.service.subscribeGlobal(() => void sendGap());
          });
          return;
        }
        if (frame.type === "pong") return;
        socket.send(JSON.stringify({ type: "error", code: "UNKNOWN_FRAME" }));
      } catch {
        socket.send(JSON.stringify({ type: "error", code: "INVALID_JSON" }));
      }
    });
    const ping = setInterval(() => {
      if (authenticated && socket.readyState === 1) {
        socket.send(JSON.stringify({ type: "ping", at: new Date().toISOString() }));
      }
    }, 10_000);
    ping.unref();
    socket.on("close", () => {
      closed = true;
      clearTimeout(deadline);
      clearInterval(ping);
      unsubscribe?.();
    });
  });

  await app.ready();
  return app;
}
