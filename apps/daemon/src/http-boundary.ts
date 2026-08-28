import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { asAtmError, AtmError, atmErrorDto } from "@ayanami-task/errors";
import { unicodeCodePointLength } from "@ayanami-task/protocol";
import type { AyanamiServerOptions } from "./server-options.js";

type PublicErrorDetails = Record<string, unknown>;

type ZodLikeIssue = {
  code?: unknown;
  path?: unknown;
  message?: unknown;
  maximum?: unknown;
  minimum?: unknown;
};

function boundedText(value: unknown, limit: number): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function isZodError(error: unknown): error is { issues: ZodLikeIssue[] } {
  return Boolean(
    error &&
      typeof error === "object" &&
      (error as { name?: unknown }).name === "ZodError" &&
      Array.isArray((error as { issues?: unknown }).issues),
  );
}

function valueAtPath(root: unknown, path: unknown): unknown {
  if (!Array.isArray(path)) return undefined;
  let current = root;
  for (const segment of path) {
    if (
      current === null ||
      typeof current !== "object" ||
      (typeof segment !== "string" && typeof segment !== "number")
    ) {
      return undefined;
    }
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

function validationDetails(error: unknown, requestBody?: unknown): PublicErrorDetails | null {
  if (!isZodError(error)) return null;
  const rawIssues = (error as { issues: ZodLikeIssue[] }).issues;
  const issueLimit = 50;
  const issues = rawIssues.slice(0, issueLimit).map((issue) => {
    const value = valueAtPath(requestBody, issue.path);
    const actualLength =
      typeof value === "string"
        ? unicodeCodePointLength(value)
        : Array.isArray(value)
          ? value.length
          : undefined;
    const limit =
      typeof issue.maximum === "number"
        ? issue.maximum
        : typeof issue.minimum === "number"
          ? issue.minimum
          : undefined;
    return {
      code: boundedText(issue.code, 64) || "invalid_value",
      path: Array.isArray(issue.path)
        ? boundedText(issue.path.map((segment) => String(segment)).join("."), 256)
        : "",
      message: boundedText(issue.message, 500) || "参数不合法",
      ...(actualLength === undefined ? {} : { actual_length: actualLength }),
      ...(limit === undefined ? {} : { limit }),
    };
  });
  return {
    issues,
    issue_count: rawIssues.length,
    issues_truncated: rawIssues.length > issueLimit,
  };
}

function expectedVersionFromBody(body: unknown, taskKey?: string): number | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const candidate = body as Record<string, unknown>;
  if (Number.isInteger(candidate.expectedVersion)) return Number(candidate.expectedVersion);
  if (!Array.isArray(candidate.items)) return null;
  const item = candidate.items.find(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (!taskKey || (entry as Record<string, unknown>).taskKey === taskKey),
  ) as Record<string, unknown> | undefined;
  return item && Number.isInteger(item.expectedVersion) ? Number(item.expectedVersion) : null;
}

function bearer(request: FastifyRequest): string | null {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) return null;
  return value.slice("Bearer ".length);
}

function assertToken(request: FastifyRequest, token: string): void {
  if (bearer(request) !== token)
    throw new AtmError("UNAUTHORIZED", { message: "本地访问令牌无效" });
}

export async function createHttpServer(options: AyanamiServerOptions): Promise<FastifyInstance> {
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
      callback(new AtmError("FORBIDDEN", { message: "仅允许本机页面访问" }), false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  app.setErrorHandler(async (error, request, reply) => {
    const validation = validationDetails(error, request.body);
    const params =
      request.params && typeof request.params === "object"
        ? (request.params as Record<string, unknown>)
        : {};
    const body =
      request.body && typeof request.body === "object" && !Array.isArray(request.body)
        ? (request.body as Record<string, unknown>)
        : {};
    const taskKey =
      typeof params.taskKey === "string"
        ? params.taskKey
        : typeof body.taskKey === "string"
          ? body.taskKey
          : undefined;
    const checklistId =
      typeof params.id === "string"
        ? params.id
        : typeof body.checklistId === "string"
          ? body.checklistId
          : undefined;
    const expectedVersion = expectedVersionFromBody(request.body, taskKey);
    let typed: AtmError;
    if (validation) {
      typed = new AtmError("INVALID_ARGUMENT", {
        message: "请求参数不合法",
        details: validation,
      });
    } else {
      const base = asAtmError(error);
      typed = base;
      if (typeof options.service.enrichError === "function") {
        try {
          typed = await options.service.enrichError(base, {
            ...(typeof params.code === "string" ? { projectCode: params.code } : {}),
            ...(taskKey === undefined ? {} : { taskKey }),
            ...(checklistId === undefined ? {} : { checklistId }),
            ...(expectedVersion === null ? {} : { expectedVersion }),
          });
        } catch {
          // Error enrichment is diagnostic only. A failed lookup must never replace the
          // original typed domain error with a secondary INTERNAL_ERROR response.
        }
      }
    }
    reply.code(typed.httpStatus).send({
      error: atmErrorDto(typed),
      request_id: request.id,
    });
  });
  app.addHook("preValidation", async (request) => {
    if (request.method === "OPTIONS") return;
    if (request.url.startsWith("/api/v1/ws")) return;
    assertToken(request, options.token);
  });
  return app;
}

export function installNotFoundHandler(app: FastifyInstance): void {
  // Fastify 对「路径存在但方法没注册」同样返回 404，和「路径不存在」一模一样。
  // 于是用错方法的人会去猜端点，越猜越远——checklist 的正确入口是 PATCH，
  // 有人试了 POST 拿到 404，就此认定它不存在，绕开了整条路。把这两种情况分开。
  const probeMethods = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;
  app.setNotFoundHandler((request, reply) => {
    const allowed = probeMethods.filter(
      (method) => method !== request.method && app.findRoute({ method, url: request.url }),
    );
    if (allowed.length === 0) {
      reply.code(404).send({
        error: { code: "NOT_FOUND", message: `NOT_FOUND: ${request.method} ${request.url}` },
        request_id: request.id,
      });
      return;
    }
    reply
      .code(405)
      .header("allow", allowed.join(", "))
      .send({
        error: {
          code: "METHOD_NOT_ALLOWED",
          message: `METHOD_NOT_ALLOWED: ${request.url} 只接受 ${allowed.join(" / ")}，收到 ${request.method}`,
        },
        request_id: request.id,
      });
  });
}
