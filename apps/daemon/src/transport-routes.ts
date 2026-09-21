import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import { handleAyanamiMcpHttp, type AyanamiMcpProfile } from "@ayanami-task/mcp";
import type { AyanamiServerOptions } from "./server-options.js";

const WS_OPEN = 1;
const WS_BUFFER_LIMIT = 1024 * 1024;
const WS_BACKPRESSURE_CLOSE_TIMEOUT = 250;
const WS_FAILURE_CLOSE_TIMEOUT = 250;
const WS_SEND_TIMEOUT = 5_000;

type WebSocketQuery = {
  projectCode: string | null;
  since: number;
};

function parseWebSocketQuery(rawQuery: unknown): WebSocketQuery | null {
  if (typeof rawQuery !== "object" || rawQuery === null) return null;
  const query = rawQuery as Record<string, unknown>;
  const scope = query.scope;
  let projectCode: string | null = null;
  if (scope !== "global") {
    if (typeof scope !== "string" || !scope.startsWith("project:") || scope.length <= 8) {
      return null;
    }
    projectCode = scope.slice("project:".length).toUpperCase();
  }

  const rawSince = query.since;
  if (rawSince === undefined) return { projectCode, since: 0 };
  if (typeof rawSince !== "string" && typeof rawSince !== "number") return null;
  if (typeof rawSince === "string" && rawSince.trim() === "") return null;
  const since = typeof rawSince === "number" ? rawSince : Number(rawSince);
  if (!Number.isSafeInteger(since) || since < 0) return null;
  return { projectCode, since };
}

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
    const query = parseWebSocketQuery(request.query);
    if (!query) {
      socket.close(1008, "Invalid query");
      return;
    }
    const { projectCode } = query;

    let authenticated = false;
    let closed = false;
    let cleanupDone = false;
    let failureInitiated = false;
    let pumpRunning = false;
    let pumpRequested = false;
    let unsubscribe: (() => void) | null = null;
    let lastSequence = query.since;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    let ping: ReturnType<typeof setInterval> | null = null;
    let backpressureCloseTimer: ReturnType<typeof setTimeout> | null = null;
    let failureCloseTimer: ReturnType<typeof setTimeout> | null = null;

    const releaseSubscription = () => {
      const current = unsubscribe;
      unsubscribe = null;
      if (!current) return;
      try {
        current();
      } catch {
        // A close path must remain idempotent even if a service implementation
        // has already released the listener.
      }
    };

    const cleanup = () => {
      if (cleanupDone) return;
      cleanupDone = true;
      closed = true;
      pumpRequested = false;
      if (deadline) clearTimeout(deadline);
      if (ping) clearInterval(ping);
      if (backpressureCloseTimer) clearTimeout(backpressureCloseTimer);
      if (failureCloseTimer) clearTimeout(failureCloseTimer);
      releaseSubscription();
    };

    const closeSocket = (code: number, reason: string) => {
      cleanup();
      if (socket.readyState !== 0 && socket.readyState !== WS_OPEN) return;
      try {
        socket.close(code, reason);
      } catch {
        // The close event remains the authoritative cleanup boundary.
      }
    };

    const terminateForBackpressure = () => {
      if (closed || failureInitiated) return;
      failureInitiated = true;
      pumpRequested = false;
      releaseSubscription();
      const finish = () => closeSocket(1013, "Backpressure overflow");
      if (socket.readyState !== WS_OPEN) {
        finish();
        return;
      }
      const payload = JSON.stringify({
        type: "resync_required",
        reason: "bounded_queue_overflow",
      });
      try {
        socket.send(payload, (error?: Error) => {
          void error;
          finish();
        });
        backpressureCloseTimer = setTimeout(finish, WS_BACKPRESSURE_CLOSE_TIMEOUT);
        backpressureCloseTimer.unref();
      } catch {
        finish();
      }
    };

    const sendRawFrame = (frame: unknown, allowOverflow = false): Promise<void> => {
      if (closed || socket.readyState !== WS_OPEN) {
        return Promise.reject(new Error("WS_NOT_OPEN"));
      }
      if (!allowOverflow && socket.bufferedAmount > WS_BUFFER_LIMIT) {
        terminateForBackpressure();
        return Promise.reject(new Error("WS_BACKPRESSURE"));
      }
      let payload: string;
      try {
        const serialized = JSON.stringify(frame);
        if (serialized === undefined) throw new Error("WS_FRAME_UNSERIALIZABLE");
        payload = serialized;
      } catch (error) {
        return Promise.reject(error);
      }
      return new Promise<void>((resolvePromise, rejectPromise) => {
        let settled = false;
        const sendTimeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          rejectPromise(new Error("WS_SEND_TIMEOUT"));
        }, WS_SEND_TIMEOUT);
        sendTimeout.unref();
        const settle = (error?: Error | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(sendTimeout);
          if (error) rejectPromise(error);
          else resolvePromise();
        };
        try {
          socket.send(payload, settle);
        } catch (error) {
          settle(error instanceof Error ? error : new Error(String(error)));
        }
      });
    };

    const failConnection = (code: string) => {
      if (closed || failureInitiated) return;
      failureInitiated = true;
      pumpRequested = false;
      releaseSubscription();
      const finish = () => closeSocket(1011, "WebSocket stream failed");
      failureCloseTimer = setTimeout(finish, WS_FAILURE_CLOSE_TIMEOUT);
      failureCloseTimer.unref();
      void sendRawFrame({ type: "error", code }, true)
        .catch(() => undefined)
        .finally(finish);
    };

    const sendFrame = (frame: unknown): Promise<void> => {
      if (failureInitiated) return Promise.reject(new Error("WS_CLOSING"));
      return sendRawFrame(frame);
    };

    const runPump = async () => {
      while (!closed && authenticated && pumpRequested) {
        pumpRequested = false;
        const sequenceBefore = lastSequence;
        const delta = projectCode
          ? await options.service.delta(projectCode, lastSequence, 100)
          : await options.service.globalDelta(lastSequence, 100);
        if (closed || socket.readyState !== WS_OPEN) return;
        if (!delta || !Array.isArray(delta.events)) throw new Error("WS_DELTA_INVALID");
        for (const event of delta.events) {
          if (closed || socket.readyState !== WS_OPEN) return;
          if (!Number.isSafeInteger(event.seq) || event.seq < 0) {
            throw new Error("WS_DELTA_SEQUENCE_INVALID");
          }
          if (event.seq <= lastSequence) continue;
          await sendFrame({
            scope: projectCode ?? "global",
            seq: event.seq,
            type: event.type,
            key: event.key,
            summary: event.summary,
            at: event.at,
          });
          if (closed || socket.readyState !== WS_OPEN) return;
          lastSequence = event.seq;
          if (socket.bufferedAmount > WS_BUFFER_LIMIT) {
            terminateForBackpressure();
            return;
          }
        }
        if (delta.hasMore) {
          if (lastSequence === sequenceBefore) throw new Error("WS_DELTA_NO_PROGRESS");
          pumpRequested = true;
        }
      }
    };

    const requestPump = () => {
      if (closed || !authenticated || failureInitiated) return;
      pumpRequested = true;
      if (pumpRunning) return;
      pumpRunning = true;
      void runPump()
        .catch(() => {
          if (!closed && socket.readyState === WS_OPEN) failConnection("STREAM_FAILED");
        })
        .finally(() => {
          pumpRunning = false;
          if (!closed && pumpRequested) requestPump();
        });
    };

    const handleMessage = async (buffer: { toString(): string }) => {
      if (closed) return;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(buffer.toString()) as Record<string, unknown>;
      } catch {
        await sendFrame({ type: "error", code: "INVALID_JSON" });
        return;
      }
      if (!authenticated) {
        if (frame.type !== "authenticate" || frame.token !== options.token) {
          closeSocket(1008, "Authentication failed");
          return;
        }
        authenticated = true;
        if (deadline) clearTimeout(deadline);
        await sendFrame({ type: "authenticated" });
        if (closed) return;
        try {
          unsubscribe = projectCode
            ? options.service.subscribeProject(projectCode, requestPump)
            : options.service.subscribeGlobal(requestPump);
        } catch {
          failConnection("SUBSCRIPTION_FAILED");
          return;
        }
        requestPump();
        return;
      }
      if (frame.type === "pong") return;
      await sendFrame({ type: "error", code: "UNKNOWN_FRAME" });
    };

    deadline = setTimeout(() => {
      if (!authenticated) closeSocket(1008, "Authentication required");
    }, 3_000);
    deadline.unref();
    ping = setInterval(() => {
      if (!authenticated || closed || socket.readyState !== WS_OPEN) return;
      void sendFrame({ type: "ping", at: new Date().toISOString() }).catch(() =>
        failConnection("SEND_FAILED"),
      );
    }, 10_000);
    ping.unref();
    socket.on("message", (buffer: { toString(): string }) => {
      void handleMessage(buffer).catch(() => failConnection("MESSAGE_FAILED"));
    });
    socket.on("error", () => closeSocket(1011, "WebSocket transport error"));
    socket.on("close", cleanup);
  });
}
