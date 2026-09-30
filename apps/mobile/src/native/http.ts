import { Capacitor, CapacitorHttp, type HttpResponse } from "@capacitor/core";
import type { FetchLike, FetchLikeResponse } from "@ayanami-task/sync-protocol";

/**
 * 原生 HTTP 的读超时下限。长轮询最多挂 25 s，RelayClient 给它的提示是 (25 + 15) s；
 * 原生层至少留 40 s，真正的超时由 RelayClient 的 AbortSignal 决定。
 */
export const NATIVE_READ_TIMEOUT_FLOOR_MS = 40_000;
const CONNECT_TIMEOUT_MS = 15_000;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("请求已取消", "AbortError");
}

/**
 * CapacitorHttp 不认 AbortSignal：取消时立即让调用方拿到拒绝，
 * 原生那边的请求自己跑完（最多到读超时）后结果被丢弃。
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** 原生层对 JSON 响应会先解析成对象，这里还原成文本交给 RelayClient 自己解析。 */
export function responseText(data: unknown): string {
  if (data === null || data === undefined) return "";
  if (typeof data === "string") return data;
  return JSON.stringify(data);
}

export function toFetchLikeResponse(
  response: Pick<HttpResponse, "status" | "headers" | "data">,
): FetchLikeResponse {
  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    headers.set(name.toLowerCase(), String(value));
  }
  const text = responseText(response.data);
  return {
    status: response.status,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    text: () => Promise.resolve(text),
  };
}

/**
 * 给 RelayClient 用的 fetch：手机上走 CapacitorHttp（原生 HttpURLConnection，不受中继 CORS 限制），
 * 浏览器开发时退回 window.fetch。只在这里用，不全局 patch fetch。
 */
export function createRelayFetch(): FetchLike {
  if (!Capacitor.isNativePlatform()) {
    return async (url, init) => {
      const request: RequestInit = { method: init.method, headers: init.headers };
      if (init.body !== undefined) request.body = init.body;
      if (init.signal) request.signal = init.signal;
      return fetch(url, request);
    };
  }
  return async (url, init) => {
    const options: Parameters<typeof CapacitorHttp.request>[0] = {
      url,
      method: init.method,
      headers: init.headers,
      responseType: "text",
      connectTimeout: CONNECT_TIMEOUT_MS,
      readTimeout: Math.max(NATIVE_READ_TIMEOUT_FLOOR_MS, (init.timeoutMs ?? 0) + 5_000),
    };
    if (init.body !== undefined) options.data = init.body;
    let response: HttpResponse;
    try {
      response = await raceAbort(CapacitorHttp.request(options), init.signal);
    } catch (error) {
      if (init.signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      // 与 fetch 的网络错误同形：RelayClient 会把它归为 status 0 的 NETWORK。
      throw new TypeError(message || "网络请求失败");
    }
    return toFetchLikeResponse(response);
  };
}
