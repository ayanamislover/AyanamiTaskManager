export type RuntimeRequestInput = {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type RuntimeRequestOutput = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
};

const allowedHeaders = new Set(["accept", "content-type"]);

/**
 * host-control 协议里的 runtimeRequest 参数来自 WebView，经 JSON 进来的是 unknown：
 * 逐个字段校验，只留 path/method/body 与 accept、content-type 两个头。
 */
export function parseRuntimeRequestInput(value: unknown): RuntimeRequestInput {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("ATM_RENDERER_REQUEST_REJECTED");
  const record = value as Record<string, unknown>;
  if (typeof record.path !== "string" || record.path.length > 4096)
    throw new Error("ATM_RENDERER_PATH_REJECTED");
  if (record.method !== undefined && typeof record.method !== "string")
    throw new Error("ATM_RENDERER_METHOD_REJECTED");
  if (record.body !== undefined && typeof record.body !== "string")
    throw new Error("ATM_RENDERER_BODY_REJECTED");
  const headers: Record<string, string> = {};
  if (record.headers !== undefined) {
    if (
      typeof record.headers !== "object" ||
      record.headers === null ||
      Array.isArray(record.headers)
    )
      throw new Error("ATM_RENDERER_HEADERS_REJECTED");
    for (const [key, header] of Object.entries(record.headers as Record<string, unknown>)) {
      const name = key.toLowerCase();
      if (!allowedHeaders.has(name)) continue;
      if (typeof header !== "string" || header.length > 256)
        throw new Error("ATM_RENDERER_HEADERS_REJECTED");
      headers[name] = header;
    }
  }
  return {
    path: record.path,
    ...(record.method === undefined ? {} : { method: record.method }),
    headers,
    ...(record.body === undefined ? {} : { body: record.body }),
  };
}

const allowedMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const maximumBodyBytes = 2 * 1024 * 1024;

export async function proxyRuntimeRequest(
  runtime: { endpoint: string; token: string },
  input: RuntimeRequestInput,
  fetchImpl: typeof fetch = fetch,
): Promise<RuntimeRequestOutput> {
  const method = (input.method ?? "GET").toUpperCase();
  if (!allowedMethods.has(method)) throw new Error("ATM_RENDERER_METHOD_REJECTED");
  if (typeof input.path !== "string") throw new Error("ATM_RENDERER_PATH_REJECTED");
  const base = new URL(runtime.endpoint);
  const target = new URL(input.path, base);
  if (target.origin !== base.origin || !target.pathname.startsWith("/api/v1/"))
    throw new Error("ATM_RENDERER_PATH_REJECTED");
  if (input.body !== undefined && Buffer.byteLength(input.body, "utf8") > maximumBodyBytes)
    throw new Error("ATM_RENDERER_BODY_TOO_LARGE");
  const response = await fetchImpl(target, {
    method,
    headers: {
      authorization: `Bearer ${runtime.token}`,
      accept: input.headers?.accept ?? "application/json",
      ...(input.headers?.["content-type"] ? { "content-type": input.headers["content-type"] } : {}),
    },
    ...(input.body === undefined ? {} : { body: input.body }),
  });
  return {
    status: response.status,
    statusText: response.statusText,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    body: await response.text(),
  };
}
