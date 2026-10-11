/**
 * 脚本以 Agent 身份调本机 ATM 服务用的 `fetch`。
 *
 * 不能用 Node 自带的 fetch：undici 每个请求都自动带 `Sec-Fetch-Mode`，而 3.x 的 Agent HTTP 把带
 * `Sec-Fetch-*` 或 `Origin` 的请求一律当成浏览器发来的拒掉（http/src/lib.rs：真实的 Agent 与 atm-mcp
 * 桥都不带）。这里用 node:http 发同样的请求，只带调用方给的头；返回标准的 Response，
 * 可以直接交给 AyanamiClient 的 fetchImpl。
 */
import { request as httpRequest } from "node:http";

function headerRecord(headers: RequestInit["headers"]): Record<string, string> {
  if (headers === undefined) return {};
  return Object.fromEntries(new Headers(headers).entries());
}

function bodyBuffer(body: RequestInit["body"]): Buffer | null {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
  throw new Error(`AGENT_FETCH_BODY_UNSUPPORTED: ${Object.prototype.toString.call(body)}`);
}

export const agentFetch: typeof fetch = (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.protocol !== "http:") throw new Error(`AGENT_FETCH_HTTP_ONLY: ${url.protocol}`);
  const body = bodyBuffer(init.body);
  const headers = headerRecord(init.headers);
  if (body !== null) headers["content-length"] = String(body.length);
  return new Promise<Response>((resolve, reject) => {
    const req = httpRequest(
      url,
      { method: init.method ?? "GET", headers, signal: init.signal ?? undefined },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers))
            if (value !== undefined)
              for (const item of Array.isArray(value) ? value : [value])
                responseHeaders.append(key, item);
          // 204 / 304 不能带 body（Response 构造会抛）。
          const payload = status === 204 || status === 304 ? null : Buffer.concat(chunks);
          resolve(new Response(payload, { status, headers: responseHeaders }));
        });
      },
    );
    req.on("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
};
