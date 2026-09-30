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

/** 中继返回的错误。`status` 为 0 表示网络层失败。 */
export class RelayError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter: number | null;
  readonly current: RelayDocument | null;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { retryAfter?: number | null; current?: RelayDocument | null } = {},
  ) {
    super(message);
    this.name = "RelayError";
    this.status = status;
    this.code = code;
    this.retryAfter = options.retryAfter ?? null;
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

function assertKey(key: string): void {
  if (!DOC_KEY_PATTERN.test(key)) throw new RelayError(0, "KEY_INVALID", `文档键不合法：${key}`);
}

export class RelayClient {
  readonly baseUrl: string;
  readonly appId: string;
  readonly #token: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: RelayClientOptions) {
    this.baseUrl = normalizeRelayUrl(options.baseUrl);
    if (!APP_ID_PATTERN.test(options.appId)) {
      throw new RelayError(0, "APP_ID_INVALID", "应用 ID 只能是小写字母、数字、- 和 _");
    }
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
      const message = error instanceof Error ? error.message : String(error);
      throw new RelayError(0, "NETWORK", `连不上中继：${message}`);
    }
    const text = await response.text();
    let body: Record<string, unknown> | null = null;
    if (text.length > 0) {
      try {
        const parsed: unknown = JSON.parse(text);
        body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
      } catch {
        body = null;
      }
    }
    if (response.status >= 400) {
      const error = (body?.error ?? {}) as Record<string, unknown>;
      const current =
        body?.current && typeof body.current === "object"
          ? toDocument(body.current as Record<string, unknown>)
          : null;
      throw new RelayError(
        response.status,
        str(error.code) ?? `HTTP_${response.status}`,
        str(error.message) ?? `中继返回 ${response.status}`,
        { retryAfter: typeof error.retry_after === "number" ? error.retry_after : null, current },
      );
    }
    return { status: response.status, body, headers: response.headers };
  }

  async probe(): Promise<RelayProbe> {
    const { body } = await this.#request("GET", this.#url(""));
    if (!body || body.id !== this.appId) {
      throw new RelayError(0, "APP_MISMATCH", "中继返回的应用与配置不一致");
    }
    const relay = (body.relay ?? null) as Record<string, unknown> | null;
    return {
      appId: this.appId,
      longPoll: relay?.long_poll === true,
      maxWait: Math.min(25, Math.max(0, num(relay?.max_wait, 0))),
      server: str(relay?.name) ?? "app-data",
      version: str(relay?.version),
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
    if (!body) throw new RelayError(0, "EMPTY_RESPONSE", "中继没有返回文档");
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
