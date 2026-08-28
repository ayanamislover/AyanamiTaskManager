import type { FastifyInstance } from "fastify";
import { AtmError } from "@ayanami-task/errors";
import {
  ChecklistBatchUpdateInputSchema,
  ChecklistUpdateInputSchema,
  CreateMilestoneInputSchema,
  CreateObjectiveInputSchema,
  DeltaInputSchema,
  ProgressAddInputSchema,
  RecordInputSchema,
  ReviewRequestCreateInputSchema,
  ReviewSubmitInputSchema,
  SearchInputSchema,
  TaskCreateBatchInputSchema,
  TaskPatchBatchInputSchema,
  TaskViewNameSchema,
  VerifyAndCompleteInputSchema,
} from "@ayanami-task/protocol";
import {
  completedEntryForProject,
  completedEntryText,
  repositoryPatchInput,
  requestOpId,
} from "./rest-route-helpers.js";
import type { AyanamiServerOptions } from "./server-options.js";

export function registerWorkRoutes(app: FastifyInstance, options: AyanamiServerOptions): void {
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
          ...(item.objectiveId === undefined ? {} : { objectiveId: item.objectiveId }),
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
          ...(item.assigneeAgentId === undefined ? {} : { assigneeAgentId: item.assigneeAgentId }),
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
      parsed.items.map(repositoryPatchInput),
    );
  });
  app.post("/api/v1/projects/:code/ui/work-items/:taskKey/verify-and-complete", async (request) => {
    const { code, taskKey } = request.params as { code: string; taskKey: string };
    const body = request.body as Record<string, unknown>;
    const input = VerifyAndCompleteInputSchema.parse({
      ...body,
      project: code,
      session: "USER",
      taskKey,
    });
    return options.service.verifyAndCompleteAsUser(code, input.opId, {
      taskKey: input.taskKey,
      expectedVersion: input.expectedVersion,
    });
  });
  app.patch("/api/v1/projects/:code/ui/checklist/batch", async (request) => {
    const { code } = request.params as { code: string };
    const body = request.body as Record<string, unknown>;
    const input = ChecklistBatchUpdateInputSchema.parse({
      ...body,
      project: code,
      session: "USER",
    });
    return options.service.updateChecklistBatchAsUser(code, input.opId, {
      taskKey: input.taskKey,
      expectedVersion: input.expectedVersion,
      items: input.items.map((item) => ({
        checklistId: item.checklistId,
        status: item.status,
        ...(item.evidence === undefined ? {} : { evidence: item.evidence }),
      })),
    });
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
  app.get("/api/v1/projects/:code/ui/work-items", async (request) => {
    const { code } = request.params as { code: string };
    const query = request.query as Record<string, string | undefined>;
    const page = await options.service.listWorkItemPageForUi(code, {
      ...(query.status ? { status: query.status } : {}),
      ...(query.assignee ? { assigneeAgentId: query.assignee } : {}),
      ...(query.milestone ? { milestoneId: query.milestone } : {}),
      ...(query.q ? { query: query.q } : {}),
      readyOnly: query.ready === "1",
      limit: Number(query.limit ?? 20),
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
    return { items: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore };
  });
  app.get("/api/v1/projects/:code/ui/work-items/:taskKey", async (request) => {
    const { code, taskKey } = request.params as { code: string; taskKey: string };
    return options.service.getWorkItemForUi(code, taskKey);
  });
  app.get("/api/v1/projects/:code/work-items", async (request) => {
    const { code } = request.params as { code: string };
    const query = request.query as Record<string, string | undefined>;
    const view = TaskViewNameSchema.default("core").parse(query.view);
    const page = await options.service.listWorkItemPage(
      code,
      {
        ...(query.status ? { status: query.status } : {}),
        ...(query.assignee ? { assigneeAgentId: query.assignee } : {}),
        ...(query.milestone ? { milestoneId: query.milestone } : {}),
        ...(query.q ? { query: query.q } : {}),
        readyOnly: query.ready === "1",
        limit: Number(query.limit ?? 20),
        ...(query.cursor ? { cursor: query.cursor } : {}),
      },
      view,
    );
    return { items: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore };
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
          ...(item.objectiveId === undefined ? {} : { objectiveId: item.objectiveId }),
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
          ...(item.assigneeAgentId === undefined ? {} : { assigneeAgentId: item.assigneeAgentId }),
          ...(item.milestoneId === undefined ? {} : { milestoneId: item.milestoneId }),
          ...(item.parentKey === undefined ? {} : { parentKey: item.parentKey }),
          ...(item.parentRef === undefined ? {} : { parentRef: item.parentRef }),
          ...(item.targetDate === undefined ? {} : { targetDate: item.targetDate }),
        })),
        { resolvePlanningRoot: true },
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
      parsed.items.map(repositoryPatchInput),
    );
  });
  app.post("/api/v1/projects/:code/work-items/:taskKey/verify-and-complete", async (request) => {
    const { code, taskKey } = request.params as { code: string; taskKey: string };
    const input = VerifyAndCompleteInputSchema.parse({
      ...(request.body as object),
      project: code,
      taskKey,
    });
    return options.service.verifyAndComplete(code, input.session, input.opId, {
      taskKey: input.taskKey,
      expectedVersion: input.expectedVersion,
    });
  });
  app.get("/api/v1/projects/:code/work-items/:taskKey", async (request) => {
    const { code, taskKey } = request.params as { code: string; taskKey: string };
    const query = request.query as Record<string, unknown>;
    const view = TaskViewNameSchema.default("core").parse(query.view);
    return options.service.getWorkItem(code, taskKey, view);
  });
  app.post("/api/v1/projects/:code/reviews/requests", async (request, reply) => {
    const { code } = request.params as { code: string };
    const input = ReviewRequestCreateInputSchema.parse({
      ...(request.body as object),
      project: code,
    });
    return reply.code(201).send(
      await options.service.createReviewRequest(code, input.session, input.opId, {
        reviewTaskKey: input.reviewTaskKey,
        expectedReviewTaskVersion: input.expectedReviewTaskVersion,
        parentChecklistId: input.parentChecklistId,
        expectedParentChecklistVersion: input.expectedParentChecklistVersion,
        expectedCandidateHashes: input.expectedCandidateHashes,
      }),
    );
  });
  app.get("/api/v1/projects/:code/reviews/requests/:requestKey", async (request) => {
    const { code, requestKey } = request.params as { code: string; requestKey: string };
    return options.service.getReviewRequest(code, requestKey);
  });
  app.post("/api/v1/projects/:code/reviews/requests/:requestKey/submit", async (request) => {
    const { code, requestKey } = request.params as { code: string; requestKey: string };
    const input = ReviewSubmitInputSchema.parse({
      ...(request.body as object),
      project: code,
      requestKey,
    });
    return options.service.submitReview(code, input.session, input.opId, {
      requestKey: input.requestKey,
      expectedReviewTaskVersion: input.expectedReviewTaskVersion,
      verdict: input.verdict,
      reviewedHashes: input.reviewedHashes,
      evidence: input.evidence,
    });
  });
  app.patch("/api/v1/projects/:code/checklist/batch", async (request) => {
    const { code } = request.params as { code: string };
    const input = ChecklistBatchUpdateInputSchema.parse({
      ...(request.body as object),
      project: code,
    });
    return options.service.updateChecklistBatch(code, input.session, input.opId, {
      taskKey: input.taskKey,
      expectedVersion: input.expectedVersion,
      items: input.items.map((item) => ({
        checklistId: item.checklistId,
        status: item.status,
        ...(item.evidence === undefined ? {} : { evidence: item.evidence }),
      })),
    });
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
    const body = (request.body ?? {}) as Record<string, unknown>;
    const input = ProgressAddInputSchema.parse({ ...body, project: code });
    if (input.scope === "project") {
      return options.service.addProjectProgress(code, input.session, input.opId, {
        summary: input.summary,
        completed: input.completed.map(completedEntryForProject),
        next: input.next,
        evidence: input.evidence,
        ...(input.health === undefined ? {} : { health: input.health }),
        ...(input.blocker === undefined ? {} : { blocker: input.blocker }),
      });
    }
    if (!input.taskKey)
      throw new AtmError("VALIDATION_ERROR", { message: "task scope 要求 taskKey" });
    return options.service.addProgress(code, input.session, input.opId, {
      taskKey: input.taskKey,
      ...(input.percent === undefined ? {} : { percent: input.percent }),
      summary: input.summary,
      completed: input.completed.map(completedEntryText),
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
        ...(input.topic === undefined ? {} : { topic: input.topic }),
        ...(input.subjectKey === undefined ? {} : { subjectKey: input.subjectKey }),
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
        ...(input.topic === undefined ? {} : { topic: input.topic }),
        ...(input.subjectKey === undefined ? {} : { subjectKey: input.subjectKey }),
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
    return options.service.search(code, query.query, query.limit, query.cursor);
  });
  app.get("/api/v1/search", async (request) => {
    const raw = request.query as Record<string, unknown>;
    const query = SearchInputSchema.parse({
      ...raw,
      ...(raw.limit === undefined ? {} : { limit: Number(raw.limit) }),
    });
    return options.service.globalSearch(query.query, query.limit, query.cursor);
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
}
