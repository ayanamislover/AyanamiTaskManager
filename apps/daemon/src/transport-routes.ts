import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import { handleAyanamiMcpHttp, type AyanamiMcpProfile } from "@ayanami-task/mcp";
import type { AyanamiServerOptions } from "./server-options.js";

export async function registerTransportRoutes(
  app: FastifyInstance,
  options: AyanamiServerOptions,
): Promise<void> {
  const mcpRoutes: Array<{ url: string; profile: AyanamiMcpProfile }> = [
    // 旧入口只为尚未重启、仍缓存单 server 配置的客户端保留完整工具面；新配置始终走
    // 拆开的 core / memory / actions。兼容入口不能静默缺掉任一能力，否则升级中的活跃会话无法收尾。
    { url: "/mcp", profile: "legacy" },
    { url: "/mcp/core", profile: "core" },
    { url: "/mcp/memory", profile: "memory" },
    { url: "/mcp/actions", profile: "actions" },
  ];
  for (const route of mcpRoutes) {
    app.post(route.url, async (request, reply) => {
      reply.hijack();
      await handleAyanamiMcpHttp(request.raw, reply.raw, request.body, options.service, {
        profile: route.profile,
      });
    });
    for (const method of ["GET", "DELETE"] as const) {
      app.route({
        method,
        url: route.url,
        handler: async (_request, reply) =>
          reply.code(405).send({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Method not allowed for stateless MCP transport" },
            id: null,
          }),
      });
    }
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
}
