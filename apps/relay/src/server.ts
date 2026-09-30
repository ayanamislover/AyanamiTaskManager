// HTTP(S) 服务：请求管线（路由 → 方法 → 限流 → 认证 → 归属）与优雅退出。
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { bootstrapIfNeeded } from "./bootstrap.js";
import { type Database, nowIso, openDatabase } from "./database.js";
import {
  RelayError,
  forbidden,
  internalError,
  notFound,
  tooManyRequests,
  unauthorized,
} from "./errors.js";
import { type RelayContext, handleRoute } from "./handlers.js";
import { bearerToken, clientAddress, sendError, sendJson, sendPreflight } from "./http-io.js";
import { type RelayLimits, resolveLimits } from "./limits.js";
import { type RelayLogger, silentLogger } from "./log.js";
import { ChangeNotifier } from "./notifier.js";
import { TokenBucketLimiter, WaiterGate } from "./rate-limit.js";
import { ROUTE_METHODS, matchRoute, splitUrl } from "./routes.js";
import { authenticate, touchToken } from "./tokens.js";

export type TlsFiles = { cert: string | Buffer; key: string | Buffer };

export type RelayServerOptions = {
  dataDir: string;
  host?: string;
  port?: number;
  tls?: TlsFiles;
  /** 只在中继位于反向代理之后时打开：X-Forwarded-For 仅用作未认证请求的限流键。 */
  trustProxy?: boolean;
  limits?: Partial<RelayLimits>;
  log?: RelayLogger;
  /** 每个请求记一行访问日志（不含查询串、token 与内容）。 */
  accessLog?: boolean;
  /** 首次启动自动建 app atm 与第一枚 token（默认开）。 */
  bootstrap?: boolean;
  now?: () => number;
};

export type RunningRelay = {
  url: string;
  host: string;
  port: number;
  db: Database;
  limits: RelayLimits;
  /** 首次启动写出的 initial-token.txt 路径；非首次为 null。 */
  initialTokenPath: string | null;
  /** 仅 HTTPS：重新加载证书（续期后 SIGHUP 调用）。 */
  reloadTls(files: TlsFiles): void;
  close(): Promise<void>;
};

/** last_used_at 最多每分钟写一次：它只用来推导「connected」，不值得每个请求一次写事务。 */
const TOUCH_INTERVAL_MS = 60_000;
/** 关闭时等进行中的请求最多这么久，然后强制断开。 */
const SHUTDOWN_GRACE_MS = 5_000;

export async function startRelay(options: RelayServerOptions): Promise<RunningRelay> {
  const log = options.log ?? silentLogger;
  const limits = resolveLimits(options.limits);
  const now = options.now ?? Date.now;
  const db = openDatabase(options.dataDir);
  const initialTokenPath =
    options.bootstrap === false ? null : bootstrapIfNeeded(db, options.dataDir, log);

  let closing = false;
  const notifier = new ChangeNotifier();
  const ctx: RelayContext = {
    db,
    limits,
    notifier,
    waiters: new WaiterGate(limits.waitersPerToken, limits.waitersGlobal),
    isClosing: () => closing,
    now,
  };
  const limiter = new TokenBucketLimiter(limits.requestsPerSecond, now);
  const touched = new Map<string, number>();

  const touch = (tokenId: string) => {
    const at = now();
    const last = touched.get(tokenId);
    if (last !== undefined && at - last < TOUCH_INTERVAL_MS) return;
    touched.set(tokenId, at);
    touchToken(db, tokenId, nowIso(at));
  };

  const pipeline = async (req: IncomingMessage, res: ServerResponse, state: RequestState) => {
    if (closing) res.setHeader("Connection", "close");
    const { path, query } = splitUrl(req.url ?? "/");
    state.path = path;
    const method = req.method ?? "GET";
    if (method === "OPTIONS") {
      sendPreflight(res);
      return;
    }
    const route = matchRoute(path);
    if (!route) throw notFound("接口不存在");
    const allowed = ROUTE_METHODS[route.kind];
    if (!allowed.includes(method)) {
      res.setHeader("Allow", allowed.join(", "));
      throw new RelayError(
        405,
        "METHOD_NOT_ALLOWED",
        `该路径不支持 ${method}，可用：${allowed.join("、")}`,
      );
    }
    if (route.kind === "health") {
      sendJson(res, 200, { ok: true });
      return;
    }
    const token = bearerToken(req);
    const principal = token === null ? null : authenticate(db, token);
    const limitKey = principal
      ? `t:${principal.tokenId}`
      : `a:${clientAddress(req, options.trustProxy === true)}`;
    const retryAfter = limiter.take(limitKey);
    if (retryAfter > 0) throw tooManyRequests("RATE_LIMITED", "请求过于频繁", retryAfter);
    if (!principal) throw unauthorized();
    state.tokenId = principal.tokenId;
    touch(principal.tokenId);
    // 与 AyanamiCloud 一致：token 有效但不属于路径里的 app 是 403（不是 404），
    // 客户端据此区分「token 失效、该重新配对」（401）和「填错了 app」（403）。
    if (principal.appId !== route.app) throw forbidden("该 token 不能访问这个应用");
    await handleRoute(ctx, route, { req, res, query, principal });
  };

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const state: RequestState = { started: performance.now(), path: "-", tokenId: null };
    if (options.accessLog) {
      res.on("close", () => logAccess(log, req, res, state, options.trustProxy === true));
    }
    pipeline(req, res, state).catch((error: unknown) => {
      if (error instanceof RelayError) {
        sendError(res, error);
        return;
      }
      log.error(`处理 ${req.method} ${state.path} 时出错：${describe(error)}`);
      sendError(res, internalError());
    });
  };

  const server: Server = options.tls
    ? createHttpsServer({ cert: options.tls.cert, key: options.tls.key }, handler)
    : createServer(handler);
  // 长轮询最长 25 s，加上传 300 KiB 的余量；头部 20 s 内没发完就断，挡慢速攻击。
  server.requestTimeout = 60_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 30_000;

  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8790, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const scheme = options.tls ? "https" : "http";
  const displayHost = address.family === "IPv6" ? `[${address.address}]` : address.address;

  let closed: Promise<void> | null = null;
  const close = () => {
    if (closed) return closed;
    closing = true;
    closed = new Promise<void>((resolve) => {
      // 先唤醒长轮询：它们按「无新变更」立即返回（带 Connection: close），客户端下一轮会连到新进程。
      notifier.shutdown();
      const force = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
      // 关闭开始时还在处理的请求，回完之后连接变成空闲 keep-alive；隔一会儿收一次，别干等到强制断开。
      const sweep = setInterval(() => server.closeIdleConnections(), 50);
      server.close(() => {
        clearTimeout(force);
        clearInterval(sweep);
        db.close();
        resolve();
      });
      server.closeIdleConnections();
    });
    return closed;
  };

  return {
    url: `${scheme}://${displayHost}:${address.port}`,
    host: address.address,
    port: address.port,
    db,
    limits,
    initialTokenPath,
    reloadTls(files) {
      if (!("setSecureContext" in server)) throw new Error("当前没有启用 TLS");
      (server as ReturnType<typeof createHttpsServer>).setSecureContext({
        cert: files.cert,
        key: files.key,
      });
    },
    close,
  };
}

type RequestState = { started: number; path: string; tokenId: string | null };

function logAccess(
  log: RelayLogger,
  req: IncomingMessage,
  res: ServerResponse,
  state: RequestState,
  trustProxy: boolean,
): void {
  if (state.path === "/health/live") return;
  const elapsed = Math.round(performance.now() - state.started);
  const status = res.writableFinished ? String(res.statusCode) : "断开";
  log.info(
    `${req.method} ${state.path} ${status} ${elapsed}ms token=${state.tokenId ?? "-"} ip=${clientAddress(req, trustProxy)}`,
  );
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
