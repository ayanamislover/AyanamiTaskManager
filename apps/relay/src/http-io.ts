// HTTP 读写的小工具：限长读体、JSON 响应、CORS、来源地址。
import type { IncomingMessage, ServerResponse } from "node:http";
import { RelayError, payloadTooLarge } from "./errors.js";

/**
 * CORS：放行任意来源，但只允许 Bearer 头，不允许 Cookie。
 * token 不是浏览器自动附带的环境凭据，别的网页拿不到它，也就没有 CSRF 面；
 * 放开来源是为了让手机 WebView 或网页版客户端直接调中继。
 */
const CORS_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "Retry-After",
});

const PREFLIGHT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept",
  "Access-Control-Max-Age": "600",
});

function baseHeaders(res: ServerResponse): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  for (const [name, value] of Object.entries(CORS_HEADERS)) res.setHeader(name, value);
}

export function sendJsonText(res: ServerResponse, status: number, body: string): void {
  if (res.headersSent || res.destroyed) return;
  baseHeaders(res);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body, "utf8"));
  res.statusCode = status;
  res.end(body);
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  sendJsonText(res, status, JSON.stringify(body));
}

export function sendNoContent(res: ServerResponse): void {
  if (res.headersSent || res.destroyed) return;
  baseHeaders(res);
  res.statusCode = 204;
  res.end();
}

export function sendError(res: ServerResponse, error: RelayError): void {
  if (error.retryAfter !== undefined) res.setHeader("Retry-After", String(error.retryAfter));
  if (error.status === 413) {
    // 体没读完就拒绝了：告诉客户端关连接，免得剩下的字节被当成下一个请求。
    res.setHeader("Connection", "close");
  }
  sendJsonText(res, error.status, error.toJson());
}

export function sendPreflight(res: ServerResponse): void {
  baseHeaders(res);
  for (const [name, value] of Object.entries(PREFLIGHT_HEADERS)) res.setHeader(name, value);
  res.statusCode = 204;
  res.end();
}

/** 超限后最多再读掉多少字节再回 413。 */
const DRAIN_FACTOR = 4;

/**
 * 读请求体，超过 maxBytes 回 413。
 *
 * 稍微超限的体先读完再拒绝：服务端一边回 413 一边断连接时，客户端往往还在写，
 * 拿到的是「连接被重置」而不是 413，排障时就只看到网络错误。明显过大的（超过 4 倍）不读，直接拒绝。
 */
export function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? Number.NaN);
  if (declared > maxBytes * DRAIN_FACTOR) {
    return Promise.reject(payloadTooLarge("请求体过大"));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (error: RelayError | null) => {
      if (settled) return;
      settled = true;
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks, total));
    };
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total <= maxBytes) {
        chunks.push(chunk);
        return;
      }
      chunks.length = 0;
      if (total > maxBytes * DRAIN_FACTOR) {
        finish(payloadTooLarge("请求体过大"));
        req.resume();
      }
    };
    const onEnd = () => finish(total > maxBytes ? payloadTooLarge("请求体过大") : null);
    const onError = () => finish(new RelayError(400, "BAD_REQUEST", "读取请求体失败"));
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

/** Authorization: Bearer <token>，大小写不敏感，与 AyanamiCloud 的解析相同。 */
export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const prefix = "bearer ";
  if (header.length <= prefix.length || header.slice(0, prefix.length).toLowerCase() !== prefix) {
    return null;
  }
  const token = header.slice(prefix.length).trim();
  return token === "" ? null : token;
}

/**
 * 来源地址，仅用于未认证请求的限流键。默认只认 TCP 对端；
 * `--trust-proxy` 时取 X-Forwarded-For 最右一段（最近一跳代理写进去的那个），
 * 最左段是客户端自己能随便填的，拿它当键等于让人任意换桶。
 */
export function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  const remote = req.socket.remoteAddress ?? "unknown";
  if (!trustProxy) return remote;
  const forwarded = req.headers["x-forwarded-for"];
  const value = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
  if (!value) return remote;
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return parts[parts.length - 1] ?? remote;
}
