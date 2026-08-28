import {
  AtmError,
  isAtmErrorCode,
  type AtmBaseErrorDetails,
  type AtmErrorCode,
} from "@ayanami-task/errors";

export type ClientRequest = <T>(method: string, path: string, body?: unknown) => Promise<T>;

export class AyanamiClientError extends AtmError<AtmErrorCode> {
  readonly status: number;
  readonly requestId: string | null;

  constructor(input: {
    code: AtmErrorCode;
    message: string;
    status: number;
    requestId?: string | null;
    details?: AtmBaseErrorDetails | null;
    retryable?: boolean;
  }) {
    super(input.code, {
      message: input.message,
      httpStatus: input.status,
      ...(input.details === undefined ? {} : { details: input.details }),
      ...(input.retryable === undefined ? {} : { retryable: input.retryable }),
    });
    this.name = "AyanamiClientError";
    this.status = input.status;
    this.requestId = input.requestId ?? null;
  }
}

export function queryString(values: Record<string, unknown>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

export async function requestJson<T>(input: {
  endpoint: string;
  token: string;
  fetchImpl: typeof fetch;
  method: string;
  path: string;
  body?: unknown;
}): Promise<T> {
  const response = await input.fetchImpl(`${input.endpoint}${input.path}`, {
    method: input.method,
    headers: {
      authorization: `Bearer ${input.token}`,
      accept: "application/json",
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  const text = await response.text();
  let payload: any = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new AyanamiClientError({
        code: "INVALID_RESPONSE",
        message: `服务返回了非 JSON 响应（HTTP ${response.status}）`,
        status: response.status,
      });
    }
  }
  if (!response.ok) {
    const rawCode = payload?.error?.code;
    throw new AyanamiClientError({
      code: isAtmErrorCode(rawCode) ? rawCode : "INVALID_RESPONSE",
      message: payload?.error?.message ?? `请求失败（HTTP ${response.status}）`,
      status: response.status,
      requestId: payload?.request_id ?? response.headers.get("x-request-id"),
      ...(payload?.error?.details && typeof payload.error.details === "object"
        ? { details: payload.error.details as AtmBaseErrorDetails }
        : {}),
      ...(typeof payload?.error?.retryable === "boolean"
        ? { retryable: payload.error.retryable }
        : {}),
    });
  }
  return payload as T;
}
