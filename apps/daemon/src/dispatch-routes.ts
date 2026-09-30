import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { USER_ONLY } from "./http-boundary.js";
import type { DispatchController } from "./server-options.js";

/** 控制器抛出的派单错误：形状与 AtmError 相同，错误码以 DISPATCH_ 开头。 */
type DispatchFailure = Error & {
  code: string;
  httpStatus: number;
  retryable?: boolean;
  details?: Record<string, unknown> | null;
};

function isDispatchFailure(error: unknown): error is DispatchFailure {
  if (!(error instanceof Error)) return false;
  const { code, httpStatus } = error as Partial<DispatchFailure>;
  return (
    typeof code === "string" &&
    code.startsWith("DISPATCH_") &&
    Number.isInteger(httpStatus) &&
    Number(httpStatus) >= 400 &&
    Number(httpStatus) < 600
  );
}

function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  error: { code: string; message: string; retryable?: boolean; details?: unknown },
) {
  return reply.code(status).send({
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable ?? false,
      ...(error.details === undefined || error.details === null ? {} : { details: error.details }),
    },
    request_id: request.id,
  });
}

/**
 * 派单路由总是注册（这样权限守卫能逐条核对它们）；宿主没有注入控制器时统一 404 DISPATCH_UNAVAILABLE。
 * 派单错误按控制器给的状态码与错误码原样回给调用方，其余错误交给全局错误处理。
 */
export function registerDispatchRoutes(
  app: FastifyInstance,
  dispatch: DispatchController | undefined,
): void {
  async function handle(
    request: FastifyRequest,
    reply: FastifyReply,
    work: (controller: DispatchController) => Promise<unknown>,
    successStatus = 200,
  ) {
    if (!dispatch)
      return sendError(request, reply, 404, {
        code: "DISPATCH_UNAVAILABLE",
        message: "当前 ATM 宿主没有启用 Claude 派单",
      });
    try {
      return reply.code(successStatus).send(await work(dispatch));
    } catch (error) {
      if (!isDispatchFailure(error)) throw error;
      return sendError(request, reply, error.httpStatus, error);
    }
  }

  app.get("/api/v1/dispatch/status", async (request, reply) =>
    handle(request, reply, (controller) => controller.status()),
  );
  app.put("/api/v1/dispatch/config", USER_ONLY, async (request, reply) =>
    handle(request, reply, (controller) => controller.updateConfig(request.body ?? {})),
  );
  app.post(
    "/api/v1/projects/:code/ui/work-items/:taskKey/dispatch",
    USER_ONLY,
    async (request, reply) => {
      const { code, taskKey } = request.params as { code: string; taskKey: string };
      return handle(
        request,
        reply,
        (controller) => controller.enqueue({ project: code, key: taskKey, origin: "desktop" }),
        201,
      );
    },
  );
  app.post("/api/v1/dispatch/runs/:run/cancel", USER_ONLY, async (request, reply) => {
    const { run } = request.params as { run: string };
    return handle(request, reply, (controller) => controller.cancel(run));
  });
}
