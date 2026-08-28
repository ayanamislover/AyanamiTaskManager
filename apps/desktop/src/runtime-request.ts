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
