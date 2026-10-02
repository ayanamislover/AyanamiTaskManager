// 契约套件用的最小 HTTP 客户端：站在「ATM 客户端」的视角调应用数据接口。
// 不依赖 vitest，scripts/contract-against.ts 也用它对任意兼容服务跑同一套断言。

export type ContractCapabilities = {
  /** 服务端支持 `changes?wait=` 长轮询（GET /v1/apps/{app} 里 relay.long_poll=true）。 */
  longPoll: boolean;
  /**
   * 已知的变更保留条数。给出时跑「游标被裁剪 → 410」用例，需要写入 retention+2 次；
   * 不给就跳过（AyanamiCloud 是 10000，只在明确要跑时才给）。
   */
  changeRetention?: number;
};

export type ContractTarget = {
  baseUrl: string;
  appId: string;
  token: string;
  capabilities: ContractCapabilities;
};

export type ContractResponse = {
  status: number;
  /** 解析后的 JSON；204 或空体为 null。 */
  json: any;
  text: string;
  headers: Headers;
  elapsedMs: number;
};

export type RequestOptions = {
  /** 会被 JSON.stringify 的请求体。 */
  body?: unknown;
  /** 原样发送的请求体（测试坏 JSON 用）。 */
  rawBody?: string;
  /** null 表示不带 Authorization；字符串表示用这枚 token。 */
  token?: string | null;
  /** 遇到 429 时不自动重试（测限流本身时用）。 */
  noRetry?: boolean;
  /** 原样使用的 Authorization 头（测认证方案大小写时用），优先于 token。 */
  authorization?: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ContractClient {
  constructor(
    readonly target: ContractTarget,
    /** 本次运行独占的键前缀，形如 contract/<runId>。 */
    readonly namespace: string,
  ) {}

  key(name: string): string {
    return `${this.namespace}/${name}`;
  }

  appPath(suffix = ""): string {
    return `/v1/apps/${encodeURIComponent(this.target.appId)}${suffix}`;
  }

  docPath(key: string, query = ""): string {
    return this.appPath(`/documents/${encodeURIComponent(key)}${query}`);
  }

  async request(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<ContractResponse> {
    const token = options.token === undefined ? this.target.token : options.token;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.authorization !== undefined) headers.Authorization = options.authorization;
    else if (token !== null) headers.Authorization = `Bearer ${token}`;
    let body: string | undefined;
    if (options.rawBody !== undefined) body = options.rawBody;
    else if (options.body !== undefined) body = JSON.stringify(options.body);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const url = `${this.target.baseUrl.replace(/\/+$/, "")}${path}`;
    for (let attempt = 0; ; attempt++) {
      const started = performance.now();
      const response = await fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
      });
      const text = await response.text();
      const elapsedMs = performance.now() - started;
      let json: any = null;
      if (text !== "") {
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
      }
      // 客户端本来就该按 retry_after 退避；这里照做，免得限流把契约断言搅红。
      if (response.status === 429 && !options.noRetry && attempt < 8) {
        const seconds = Number(json?.error?.retry_after ?? 1);
        await sleep(Math.min(5, Math.max(1, seconds)) * 1000);
        continue;
      }
      return { status: response.status, json, text, headers: response.headers, elapsedMs };
    }
  }

  async put(
    key: string,
    expectedRevision: number,
    data: unknown,
    extra: Record<string, unknown> = {},
  ): Promise<ContractResponse> {
    return this.request("PUT", this.docPath(key), {
      body: { expected_revision: expectedRevision, data, ...extra },
    });
  }

  async get(key: string): Promise<ContractResponse> {
    return this.request("GET", this.docPath(key));
  }

  async remove(key: string, expectedRevision: number): Promise<ContractResponse> {
    return this.request("DELETE", this.docPath(key, `?expected_revision=${expectedRevision}`));
  }

  async changes(cursor: string | null, query = ""): Promise<ContractResponse> {
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    const extra = query === "" ? "" : `&${query}`;
    return this.request("GET", this.appPath(`/changes?${params.toString()}${extra}`));
  }

  /** 沿变更流从头翻到 has_more=false，得到当前头部游标（没有任何变更时为 null）。 */
  async headCursor(): Promise<string | null> {
    let cursor: string | null = null;
    for (let page = 0; page < 10_000; page++) {
      const response = await this.changes(cursor, "limit=500");
      if (response.status !== 200) {
        throw new Error(`翻变更流失败：HTTP ${response.status} ${response.text.slice(0, 200)}`);
      }
      cursor = response.json.next_cursor ?? cursor;
      if (!response.json.has_more) return cursor;
    }
    throw new Error("变更流翻了一万页还没到头");
  }

  /** 从 cursor 起收集全部变更（到 has_more=false 为止）。 */
  async changesSince(cursor: string | null): Promise<{ changes: any[]; cursor: string | null }> {
    const all: any[] = [];
    let current = cursor;
    for (let page = 0; page < 1000; page++) {
      const response = await this.changes(current, "limit=500");
      if (response.status !== 200) {
        throw new Error(`读变更流失败：HTTP ${response.status} ${response.text.slice(0, 200)}`);
      }
      all.push(...response.json.changes);
      current = response.json.next_cursor ?? current;
      if (!response.json.has_more) return { changes: all, cursor: current };
    }
    throw new Error("变更流翻了一千页还没到头");
  }

  /**
   * 删掉本次运行在命名空间下留下的全部文档。每轮都从第一页重新列：
   * AyanamiCloud 的列表游标是偏移量，边删边翻会跳过一半。
   */
  async cleanup(): Promise<void> {
    const query = new URLSearchParams({ prefix: `${this.namespace}/`, limit: "500" });
    for (let round = 0; round < 100; round++) {
      const response = await this.request("GET", this.appPath(`/documents?${query.toString()}`));
      if (response.status !== 200) return;
      const documents = response.json.documents as { key: string; revision: number }[];
      if (documents.length === 0) return;
      for (const doc of documents) await this.remove(doc.key, doc.revision);
    }
  }
}

export function newNamespace(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `contract/${Date.now().toString(36)}-${random}`;
}
