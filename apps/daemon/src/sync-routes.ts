import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { USER_ONLY } from "./http-boundary.js";
import type { SyncController } from "./server-options.js";

/**
 * 手机同步设置路由（docs/mobile-sync.md §7）。与派单路由一样总是注册，这样权限守卫能逐条核对；
 * 宿主没有注入连接器时统一 404 SYNC_UNAVAILABLE。
 *
 * 只有状态是两种令牌都能读（内容不含任何密钥）；改配置、测试中继、取配对码、重置配对都是
 * 用户的决定，USER_ONLY。配对码里有中继 token 与空间密钥，响应标 no-store。
 * 连接器的校验错误是 AtmError，交给全局错误处理。
 */
export function registerSyncRoutes(app: FastifyInstance, sync: SyncController | undefined): void {
  async function handle(
    request: FastifyRequest,
    reply: FastifyReply,
    work: (controller: SyncController) => Promise<unknown>,
  ) {
    if (!sync)
      return reply.code(404).send({
        error: {
          code: "SYNC_UNAVAILABLE",
          message: "当前 ATM 宿主没有启用手机同步",
          retryable: false,
        },
        request_id: request.id,
      });
    return reply.send(await work(sync));
  }

  app.get("/api/v1/sync/status", async (request, reply) =>
    handle(request, reply, (controller) => controller.status()),
  );
  app.put("/api/v1/sync/config", USER_ONLY, async (request, reply) =>
    handle(request, reply, (controller) => controller.updateConfig(request.body ?? {})),
  );
  app.post("/api/v1/sync/test", USER_ONLY, async (request, reply) =>
    handle(request, reply, (controller) => controller.testRelay(request.body ?? {})),
  );
  app.post("/api/v1/sync/pairing", USER_ONLY, async (request, reply) => {
    reply.header("cache-control", "no-store");
    return handle(request, reply, (controller) => controller.createPairing());
  });
  app.post("/api/v1/sync/reset", USER_ONLY, async (request, reply) =>
    handle(request, reply, (controller) => controller.resetSpace()),
  );
}
