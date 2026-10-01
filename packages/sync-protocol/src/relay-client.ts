import { APP_ID_PATTERN, DOC_KEY_PATTERN } from "./keys.js";
import { normalizeRelayUrl } from "./pairing.js";

// 应用数据 HTTP 子集的客户端：AyanamiCloud 与 atm-relay 共用。见 docs/mobile-sync.md §3。

export type FetchLikeResponse = {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
};

export type FetchLikeInit = {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** 给不支持 AbortSignal 的实现（例如 Capacitor 原生 HTTP）用的读超时提示。 */
  timeoutMs?: number;
};

export type FetchLike = (url: string, init: FetchLikeInit) => Promise<FetchLikeResponse>;

export type RelayDocumentMeta = {
  key: string;
  revision: number;
  schemaVersion: number;
  updatedAt: string;
  updatedByDevice: string | null;
  sizeBytes: number;
};
export type RelayDocument = RelayDocumentMeta & { data: unknown };

export type RelayChange = {
  seq: number;
  key: string;
  revision: number;
  op: "put" | "delete";
  deviceId: string | null;
  at: string;
};

export type RelayChangesPage = {
  changes: RelayChange[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type RelayProbe = {
  appId: string;
  /** 服务端支持 `changes?wait=` 长轮询（atm-relay 扩展）。 */
  longPoll: boolean;
  maxWait: number;
  server: string;
  version: string | null;
};

// ─── 错误：中继是不可信的 ───
//
// 中继本来就能看到请求里的 Authorization。它只要回一个 `error.message = <收到的 token>` 的 500，
// 早先的实现就会把 token 原样放进连接器的状态（Agent 令牌可读）和宿主日志（peer R1-01）。
// 所以 RelayError 的 `code` 只取下面的白名单，`message` 只用这里写死的中文；中继返回的
// code / message 原文不进任何会被打印、序列化或返回的字段。

/**
 * 中继会返回的错误码：atm-relay（apps/relay/src/errors.ts 与各 handler）和 AyanamiCloud 应用数据子集
 * 实测一致的那些（apps/relay/README.md「兼容性」）。每个码绑定它唯一合法的 HTTP 状态，对不上就不认。
 */
const REMOTE_ERRORS = {
  BAD_REQUEST: { status: 400, message: "中继读不懂这个请求" },
  INVALID_ARGUMENT: { status: 400, message: "中继认为请求参数不合法" },
  UNAUTHORIZED: { status: 401, message: "中继不认这个 token（没带、填错或已吊销）" },
  FORBIDDEN: { status: 403, message: "这个 token 无权访问该应用" },
  NOT_FOUND: { status: 404, message: "中继上没有请求的内容" },
  METHOD_NOT_ALLOWED: { status: 405, message: "中继不支持这个请求方法" },
  REVISION_CONFLICT: { status: 409, message: "文档已被其它设备修改" },
  CURSOR_EXPIRED: { status: 410, message: "增量游标已过期，需要全量重新同步" },
  PAYLOAD_TOO_LARGE: { status: 413, message: "内容超过中继允许的大小" },
  RATE_LIMITED: { status: 429, message: "请求过于频繁，中继要求稍后再试" },
  TOO_MANY_WAITERS: { status: 429, message: "中继上挂起的长轮询太多，稍后再试" },
  INTERNAL: { status: 500, message: "中继内部出错" },
  INSUFFICIENT_STORAGE: { status: 507, message: "中继的存储空间已满" },
} as const;

/** 客户端自己判定的错误（status 0）。 */
const LOCAL_ERRORS = {
  NETWORK: "连不上中继",
  KEY_INVALID: "文档键不合法",
  APP_ID_INVALID: "应用 ID 只能是小写字母、数字、- 和 _",
  APP_MISMATCH: "中继返回的应用与配置不一致",
  EMPTY_RESPONSE: "中继没有返回文档",
} as const;

/** 不在白名单里（或与 HTTP 状态对不上）的错误一律归为这个码。 */
const GENERIC_CODE = "RELAY_ERROR";

export type RelayErrorCode =
  | keyof typeof REMOTE_ERRORS
  | keyof typeof LOCAL_ERRORS
  | typeof GENERIC_CODE;

// 用 Map 查表：远端的码可能是 "constructor"、"__proto__" 这类原型链上的名字。
const REMOTE_TABLE: ReadonlyMap<string, { status: number; message: string }> = new Map(
  Object.entries(REMOTE_ERRORS),
);
const LOCAL_TABLE: ReadonlyMap<string, string> = new Map(Object.entries(LOCAL_ERRORS));

/** 中继要求的等待（秒）的上限；连接器自己另有 60 s 上限，这里防手机端被拖住。 */
const MAX_RETRY_AFTER_SECONDS = 600;

function resolveError(
  status: number,
  code: string,
  message: string | undefined,
): { code: RelayErrorCode; message: string } {
  if (status === 0) {
    const fixed = LOCAL_TABLE.get(code);
    if (fixed !== undefined) return { code: code as RelayErrorCode, message: message ?? fixed };
    return { code: GENERIC_CODE, message: message ?? "中继请求失败" };
  }
  const known = REMOTE_TABLE.get(code);
  if (known?.status === status) return { code: code as RelayErrorCode, message: known.message };
  return { code: GENERIC_CODE, message: status >= 500 ? "中继暂时不可用" : "中继拒绝了这个请求" };
}

function retryAfterSeconds(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.ceil(value));
}

/** 409 时中继返回的当前版本里，协议只用得上这几个数字；字符串与 `data` 一概不留。 */
export type RelayConflictCurrent = { revision: number; schemaVersion: number; sizeBytes: number };

/**
 * 中继返回的错误。`status` 为 0 表示本地判定（网络层失败、参数不合法等）。
 * `code` 恒为 {@link RelayErrorCode} 之一；`message` 是本地写死的中文，不含中继返回的任何原文。
 */
export class RelayError extends Error {
  readonly status: number;
  readonly code: RelayErrorCode;
  readonly retryAfter: number | null;
  readonly current: RelayConflictCurrent | null;

  /**
   * `code` 不在白名单、或与 `status` 对不上时归为 `RELAY_ERROR`。`message` 只对本地错误（status 0）
   * 生效，且只能传本地写死的文字；HTTP 错误一律用白名单里的固定文案，传了也不用。
   */
  constructor(
    status: number,
    code: string,
    message?: string,
    options: { retryAfter?: number | null; current?: RelayConflictCurrent | null } = {},
  ) {
    const resolved = resolveError(status, code, message);
    super(resolved.message);
    this.name = "RelayError";
    this.status = status;
    this.code = resolved.code;
    this.retryAfter = retryAfterSeconds(options.retryAfter);
    this.current = options.current ?? null;
  }

  /** token 无效、被撤销或无权访问该应用：重试没有意义。 */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export type RelayClientOptions = {
  baseUrl: string;
  appId: string;
  token: string;
  fetchImpl?: FetchLike;
  /** 普通请求超时，默认 20 s。长轮询会在 wait 之上再加 15 s。 */
  timeoutMs?: number;
};

const MAX_LIST_PAGES = 100;

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toMeta(raw: Record<string, unknown>): RelayDocumentMeta {
  return {
    key: String(raw.key ?? ""),
    revision: num(raw.revision),
    schemaVersion: num(raw.schema_version, 1),
    updatedAt: str(raw.updated_at) ?? "",
    updatedByDevice: str(raw.updated_by_device),
    sizeBytes: num(raw.size_bytes),
  };
}

function toDocument(raw: Record<string, unknown>): RelayDocument {
  return { ...toMeta(raw), data: raw.data };
}

function toChange(raw: Record<string, unknown>): RelayChange {
  return {
    seq: num(raw.seq),
    key: String(raw.key ?? ""),
    revision: num(raw.revision),
    op: raw.op === "delete" ? "delete" : "put",
    deviceId: str(raw.device_id),
    at: str(raw.at) ?? "",
  };
}

/** 非负安全整数，否则取 fallback。 */
function count(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/** 中继自报的名字与版本只当标签显示：限定字符集与长度，不合就丢掉（远端文本不原样外显）。 */
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,31}$/u;

function label(value: unknown): string | null {
  return typeof value === "string" && LABEL_PATTERN.test(value) ? value : null;
}

function parseObject(text: string): Record<string, unknown> | null {
  if (text.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * HTTP 错误响应 → RelayError。只读三样结构化数据：错误码（交给白名单）、等待秒数（只认数字）、
 * 409 的当前修订号等数字；错误正文里的 message 与其余字符串一概不读。
 */
function errorFromResponse(
  status: number,
  body: Record<string, unknown> | null,
  headers: FetchLikeResponse["headers"],
): RelayError {
  const raw = body?.error;
  const detail = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const code = typeof detail.code === "string" ? detail.code : GENERIC_CODE;
  const header = headers.get("Retry-After")?.trim() ?? "";
  const retryAfter =
    typeof detail.retry_after === "number"
      ? detail.retry_after
      : /^\d{1,6}$/u.test(header)
        ? Number(header)
        : null;
  const current = body?.current;
  const conflict =
    status === 409 && current && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : null;
  return new RelayError(status, code, undefined, {
    retryAfter,
    current: conflict
      ? {
          revision: count(conflict.revision),
          schemaVersion: count(conflict.schema_version, 1),
          sizeBytes: count(conflict.size_bytes),
        }
      : null,
  });
}

/** 本机运行时给的系统错误码，例如 ECONNREFUSED、UND_ERR_CONNECT_TIMEOUT、CERT_HAS_EXPIRED。 */
const SYSTEM_CODE = /^[A-Z][A-Z0-9_]{2,47}$/u;

/**
 * 网络层失败 → RelayError(0, NETWORK)。网络库的报错文字可能夹带对端可控的内容（例如 Android 的
 * 证书错误会列出对方证书的 DN 与 SAN），所以不取 message，只看是不是超时、以及运行时给的错误码。
 */
function networkError(error: unknown): RelayError {
  const shape = error as { name?: unknown; code?: unknown; cause?: unknown } | null | undefined;
  if (shape?.name === "TimeoutError") return new RelayError(0, "NETWORK", "连接中继超时");
  const cause = shape?.cause as { code?: unknown } | null | undefined;
  const code = cause?.code ?? shape?.code;
  const detail = typeof code === "string" && SYSTEM_CODE.test(code) ? `（${code}）` : "";
  return new RelayError(0, "NETWORK", `${LOCAL_ERRORS.NETWORK}${detail}`);
}

function assertKey(key: string): void {
  // 键可能来自中继的变更流或列表，不把它拼进错误文字。
  if (!DOC_KEY_PATTERN.test(key)) throw new RelayError(0, "KEY_INVALID");
}

export class RelayClient {
  readonly baseUrl: string;
  readonly appId: string;
  readonly #token: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: RelayClientOptions) {
    this.baseUrl = normalizeRelayUrl(options.baseUrl);
    if (!APP_ID_PATTERN.test(options.appId)) throw new RelayError(0, "APP_ID_INVALID");
    this.appId = options.appId;
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
    this.#timeoutMs = options.timeoutMs ?? 20_000;
  }

  #url(path: string, query?: Record<string, string | number | null | undefined>): string {
    const url = `${this.baseUrl}/v1/apps/${encodeURIComponent(this.appId)}${path}`;
    const params = Object.entries(query ?? {})
      .filter(
        (entry): entry is [string, string | number] =>
          entry[1] !== null && entry[1] !== undefined && entry[1] !== "",
      )
      .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    return params.length > 0 ? `${url}?${params.join("&")}` : url;
  }

  async #request(
    method: string,
    url: string,
    options: { body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{
    status: number;
    body: Record<string, unknown> | null;
    headers: FetchLikeResponse["headers"];
  }> {
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const signals = [AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])];
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#token}`,
      Accept: "application/json",
    };
    const init: FetchLikeInit = { method, headers, timeoutMs };
    if (signal) init.signal = signal;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    let response: FetchLikeResponse;
    try {
      response = await this.#fetch(url, init);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw networkError(error);
    }
    const body = parseObject(await response.text());
    if (response.status >= 400) throw errorFromResponse(response.status, body, response.headers);
    return { status: response.status, body, headers: response.headers };
  }

  async probe(): Promise<RelayProbe> {
    const { body } = await this.#request("GET", this.#url(""));
    if (!body || body.id !== this.appId) throw new RelayError(0, "APP_MISMATCH");
    const relay = (body.relay ?? null) as Record<string, unknown> | null;
    return {
      appId: this.appId,
      longPoll: relay?.long_poll === true,
      maxWait: Math.min(25, Math.max(0, num(relay?.max_wait, 0))),
      server: label(relay?.name) ?? "app-data",
      version: label(relay?.version),
    };
  }

  async getDocument(key: string, signal?: AbortSignal): Promise<RelayDocument | null> {
    assertKey(key);
    try {
      const request = signal ? { signal } : {};
      const { body } = await this.#request(
        "GET",
        this.#url(`/documents/${encodeURIComponent(key)}`),
        request,
      );
      return body ? toDocument(body) : null;
    } catch (error) {
      if (error instanceof RelayError && error.status === 404) return null;
      throw error;
    }
  }

  /** `expectedRevision` 为 0 表示新建。修订号不符抛 409 RelayError，`current` 带当前版本（若存在）。 */
  async putDocument(key: string, expectedRevision: number, data: unknown): Promise<RelayDocument> {
    assertKey(key);
    const { body } = await this.#request(
      "PUT",
      this.#url(`/documents/${encodeURIComponent(key)}`),
      {
        body: { expected_revision: expectedRevision, data },
      },
    );
    if (!body) throw new RelayError(0, "EMPTY_RESPONSE");
    return toDocument(body);
  }

  /** 已经不存在时返回 false。 */
  async deleteDocument(key: string, expectedRevision: number): Promise<boolean> {
    assertKey(key);
    try {
      await this.#request(
        "DELETE",
        this.#url(`/documents/${encodeURIComponent(key)}`, { expected_revision: expectedRevision }),
      );
      return true;
    } catch (error) {
      if (error instanceof RelayError && error.status === 404) return false;
      throw error;
    }
  }

  async listDocuments(prefix: string): Promise<RelayDocumentMeta[]> {
    const out: RelayDocumentMeta[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const { body } = await this.#request(
        "GET",
        this.#url("/documents", { prefix, cursor, limit: 500 }),
      );
      const documents = Array.isArray(body?.documents)
        ? (body.documents as Record<string, unknown>[])
        : [];
      out.push(...documents.map(toMeta));
      cursor = str(body?.next_cursor);
      if (!cursor || documents.length === 0) return out;
    }
    return out;
  }

  async changes(
    cursor: string | null,
    options: { limit?: number; wait?: number; signal?: AbortSignal } = {},
  ): Promise<RelayChangesPage> {
    const wait = options.wait && options.wait > 0 ? Math.min(25, Math.floor(options.wait)) : 0;
    const request: { timeoutMs: number; signal?: AbortSignal } = {
      timeoutMs: wait > 0 ? (wait + 15) * 1000 : this.#timeoutMs,
    };
    if (options.signal) request.signal = options.signal;
    const { body } = await this.#request(
      "GET",
      this.#url("/changes", { cursor, limit: options.limit ?? 500, wait: wait > 0 ? wait : null }),
      request,
    );
    const changes = Array.isArray(body?.changes) ? (body.changes as Record<string, unknown>[]) : [];
    return {
      changes: changes.map(toChange),
      // 没有新变更时 AyanamiCloud 原样返回游标；从头拉且为空时返回 null。
      nextCursor: str(body?.next_cursor) ?? cursor,
      hasMore: body?.has_more === true,
    };
  }
}
