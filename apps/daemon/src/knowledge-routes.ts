import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  KnowledgeArchiveInputSchema,
  KnowledgeGetInputSchema,
  KnowledgeSaveInputSchema,
  KnowledgeSearchInputSchema,
} from "@ayanami-task/protocol";
import { AtmError } from "@ayanami-task/errors";
import type { AyanamiServerOptions } from "./server-options.js";

type Query = Record<string, unknown>;

function query(request: FastifyRequest): Query {
  return (request.query ?? {}) as Query;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isInteger(number) ? number : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return undefined;
}

function invalidQuery(message: string): never {
  throw new AtmError("INVALID_ARGUMENT", { message });
}

function searchInput(request: FastifyRequest) {
  const input = query(request);
  const limit = input.limit === undefined ? undefined : numberValue(input.limit);
  const maxChars = input.maxChars === undefined ? undefined : numberValue(input.maxChars);
  const includeArchived =
    input.includeArchived === undefined ? undefined : booleanValue(input.includeArchived);
  if (input.limit !== undefined && limit === undefined) invalidQuery("limit 必须是整数");
  if (input.maxChars !== undefined && maxChars === undefined) invalidQuery("maxChars 必须是整数");
  if (input.includeArchived !== undefined && includeArchived === undefined)
    invalidQuery("includeArchived 必须是布尔值");
  return KnowledgeSearchInputSchema.parse({
    ...(stringValue(input.query) === undefined ? {} : { query: input.query }),
    ...(stringValue(input.tag) === undefined ? {} : { tag: input.tag }),
    ...(includeArchived === undefined ? {} : { includeArchived }),
    ...(limit === undefined ? {} : { limit }),
    ...(maxChars === undefined ? {} : { maxChars }),
    ...(stringValue(input.cursor) === undefined ? {} : { cursor: input.cursor }),
  });
}

function getInput(request: FastifyRequest) {
  const { id } = request.params as { id: string };
  const input = query(request);
  const maxChars = input.maxChars === undefined ? undefined : numberValue(input.maxChars);
  if (input.maxChars !== undefined && maxChars === undefined) invalidQuery("maxChars 必须是整数");
  if (input.revision !== undefined) invalidQuery("revision 已移除，请使用 revisionId");
  const revisionId = input.revisionId === undefined ? undefined : stringValue(input.revisionId);
  if (input.revisionId !== undefined && revisionId === undefined)
    invalidQuery("revisionId 必须是修订 ID");
  return KnowledgeGetInputSchema.parse({
    id,
    ...(revisionId === undefined ? {} : { revisionId }),
    ...(stringValue(input.section) === undefined ? {} : { section: input.section }),
    ...(maxChars === undefined ? {} : { maxChars }),
    ...(stringValue(input.cursor) === undefined ? {} : { cursor: input.cursor }),
  });
}

function historyInput(request: FastifyRequest): {
  id: string;
  beforeRevision?: number;
  limit?: number;
} {
  const { id } = request.params as { id: string };
  const input = query(request);
  const beforeRevision =
    input.beforeRevision === undefined ? undefined : numberValue(input.beforeRevision);
  const limit = input.limit === undefined ? undefined : numberValue(input.limit);
  if (input.beforeRevision !== undefined && beforeRevision === undefined)
    invalidQuery("beforeRevision 必须是整数");
  if (input.limit !== undefined && limit === undefined) invalidQuery("limit 必须是整数");
  return {
    id,
    ...(beforeRevision === undefined ? {} : { beforeRevision }),
    ...(limit === undefined ? {} : { limit }),
  };
}

/** REST adapter for the isolated, global knowledge database. */
export function registerKnowledgeRoutes(app: FastifyInstance, options: AyanamiServerOptions): void {
  const previewRecord = async (project: string, record: string) =>
    options.service.knowledge.previewRecord(project, record);

  // The preview is read-only and deliberately lives outside the save contract: it
  // pins the source Record version while the UI prepares a draft, but never publishes
  // anything to the shared knowledge database on its own.
  app.get("/api/v1/knowledge/preview-record", async (request) => {
    const input = query(request);
    const project = stringValue(input.project);
    const record = stringValue(input.record);
    if (!project || !record) invalidQuery("project 和 record 必填");
    return previewRecord(project, record);
  });
  app.get("/api/v1/projects/:code/records/:recordKey/knowledge-preview", async (request) => {
    const { code, recordKey } = request.params as { code: string; recordKey: string };
    return previewRecord(code, recordKey);
  });

  app.get("/api/v1/knowledge", async (request) =>
    options.service.knowledge.search(searchInput(request)),
  );

  app.post("/api/v1/knowledge", async (request, reply) => {
    const input = KnowledgeSaveInputSchema.parse(request.body);
    const entry = await options.service.knowledge.save(input);
    return reply.code(input.id === undefined ? 201 : 200).send(entry);
  });

  const saveExisting = async (request: FastifyRequest) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const input = KnowledgeSaveInputSchema.parse({ ...body, id });
    return options.service.knowledge.save(input);
  };
  app.put("/api/v1/knowledge/:id", saveExisting);
  app.patch("/api/v1/knowledge/:id", saveExisting);

  app.get("/api/v1/knowledge/:id", async (request) =>
    options.service.knowledge.get(getInput(request)),
  );

  app.get("/api/v1/knowledge/:id/history", async (request) => {
    const input = historyInput(request);
    return options.service.knowledge.history(input.id, input.beforeRevision, input.limit);
  });

  app.post("/api/v1/knowledge/:id/archive", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    return options.service.knowledge.archive(KnowledgeArchiveInputSchema.parse({ ...body, id }));
  });
}
