import { STATUS_CODES } from "node:http";

/** fastify 实例上用到的那一小块：进程内注入请求，不经过网络。 */
export type InjectableServer = {
  inject(options: {
    method: string;
    url: string;
    headers: Record<string, string>;
    payload?: string;
  }): Promise<{ statusCode: number; headers: Record<string, unknown>; body: string }>;
};

/**
 * 给 proxyRuntimeRequest 用的 fetch：界面的请求在 core 进程内直接注入 fastify，
 * 用户凭证连 loopback 都不经过。
 *
 * 顺带避开一个 Windows 上的真实崩溃：用全局 fetch（undici）并发打两路 loopback 请求后，
 * 连接池里留着 keep-alive 句柄，此时 process.exit 会触发 libuv 断言
 * `!(handle->flags & UV_HANDLE_CLOSING)`（src\win\async.c:76），进程以 0xC0000409 退出。
 * 实测单路请求不触发、两路并发必现。
 */
export function injectFetch(server: InjectableServer): typeof fetch {
  const adapter = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>))
      headers[key.toLowerCase()] = value;
    const result = await server.inject({
      method: (init?.method ?? "GET").toUpperCase(),
      url: `${url.pathname}${url.search}`,
      headers,
      ...(typeof init?.body === "string" ? { payload: init.body } : {}),
    });
    const contentType = result.headers["content-type"];
    return new Response(
      result.statusCode === 204 || result.statusCode === 304 ? null : result.body,
      {
        status: result.statusCode,
        statusText: STATUS_CODES[result.statusCode] ?? "",
        headers: typeof contentType === "string" ? { "content-type": contentType } : {},
      },
    );
  };
  return adapter as typeof fetch;
}
