import type { FetchLike, FetchLikeInit, FetchLikeResponse } from "@ayanami-task/sync-protocol";

// 与 packages/sync-protocol/test/support/memory-relay.ts 同一语义（不跨包引用测试目录），
// 另外加了离线开关与请求记录里的请求体，方便断言「摘要不变不写」。

type StoredDoc = { key: string; revision: number; data: unknown; updatedAt: string };
type StoredChange = {
  seq: number;
  key: string;
  revision: number;
  op: "put" | "delete";
  at: string;
};

function response(status: number, body?: unknown): FetchLikeResponse {
  const text = body === undefined ? "" : JSON.stringify(body);
  return { status, headers: { get: () => null }, text: async () => text };
}

function error(status: number, code: string, extra: Record<string, unknown> = {}) {
  return response(status, { error: { code, message: code }, ...extra });
}

/**
 * 按 AyanamiCloud 应用数据语义实现的内存中继，只给单测用：
 * 修订号跨删除单调、409 带 current、变更游标、裁剪后 410。
 */
export class MemoryRelay {
  readonly docs = new Map<string, StoredDoc>();
  readonly lastRevision = new Map<string, number>();
  changes: StoredChange[] = [];
  seq = 0;
  requests: Array<{ method: string; url: string; key: string | null }> = [];
  longPoll = false;
  /** 为真时所有请求都像断网一样抛错。 */
  offline = false;
  token = "test-relay-token-7c1f";
  appId = "atm";

  constructor(options: { longPoll?: boolean } = {}) {
    this.longPoll = options.longPoll ?? false;
  }

  prune(keep: number): void {
    this.changes = this.changes.slice(-keep);
  }

  /** 某个时刻之后写入（PUT）过的键。 */
  putsSince(index: number): string[] {
    return this.requests
      .slice(index)
      .filter((request) => request.method === "PUT" && request.key !== null)
      .map((request) => request.key!);
  }

  #meta(doc: StoredDoc) {
    return {
      key: doc.key,
      schema_version: 1,
      revision: doc.revision,
      updated_at: doc.updatedAt,
      updated_by_device: null,
      size_bytes: JSON.stringify(doc.data).length,
    };
  }

  #record(key: string, revision: number, op: "put" | "delete") {
    this.seq += 1;
    this.changes.push({ seq: this.seq, key, revision, op, at: new Date().toISOString() });
  }

  readonly fetch: FetchLike = async (url: string, init: FetchLikeInit) => {
    const parsed = new URL(url);
    const prefix = `/v1/apps/${this.appId}`;
    const rest = parsed.pathname.startsWith(prefix) ? parsed.pathname.slice(prefix.length) : "";
    const key = rest.startsWith("/documents/")
      ? decodeURIComponent(rest.slice("/documents/".length))
      : null;
    this.requests.push({ method: init.method, url, key });
    if (this.offline) throw new TypeError("fetch failed");
    if (init.headers.Authorization !== `Bearer ${this.token}`) return error(401, "UNAUTHORIZED");
    if (!parsed.pathname.startsWith(prefix)) return error(404, "NOT_FOUND");
    if (rest === "" && init.method === "GET") {
      return response(200, {
        id: this.appId,
        name: "ATM",
        ...(this.longPoll
          ? { relay: { name: "memory", version: "0", long_poll: true, max_wait: 25 } }
          : {}),
      });
    }
    if (rest === "/documents" && init.method === "GET") {
      const wanted = parsed.searchParams.get("prefix") ?? "";
      const documents = [...this.docs.values()]
        .filter((doc) => doc.key.startsWith(wanted))
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((doc) => this.#meta(doc));
      return response(200, { documents, next_cursor: null });
    }
    if (rest === "/changes" && init.method === "GET") {
      // 别家中继的游标格式对不上：像 atm-relay 一样回 400。
      const raw = parsed.searchParams.get("cursor");
      if (raw && !/^\d+$/u.test(raw)) return error(400, "INVALID_CURSOR");
      const cursor = Number(raw || "0");
      const limit = Number(parsed.searchParams.get("limit") || "100");
      if (cursor > 0 && this.changes.length > 0 && !this.changes.some((c) => c.seq <= cursor)) {
        return error(410, "CURSOR_EXPIRED");
      }
      const after = this.changes.filter((change) => change.seq > cursor);
      const page = after.slice(0, limit);
      const last = page.at(-1);
      return response(200, {
        changes: page.map((c) => ({ ...c, device_id: null })),
        next_cursor: last ? String(last.seq) : cursor > 0 ? String(cursor) : null,
        has_more: after.length > limit,
      });
    }
    if (key !== null) {
      const current = this.docs.get(key);
      if (init.method === "GET") {
        return current
          ? response(200, { ...this.#meta(current), data: current.data })
          : error(404, "NOT_FOUND");
      }
      if (init.method === "PUT") {
        const body = JSON.parse(init.body ?? "{}") as { expected_revision: number; data: unknown };
        const have = current?.revision ?? 0;
        if (body.expected_revision !== have) {
          return error(
            409,
            "REVISION_CONFLICT",
            current ? { current: { ...this.#meta(current), data: current.data } } : {},
          );
        }
        const revision = (this.lastRevision.get(key) ?? 0) + 1;
        this.lastRevision.set(key, revision);
        const doc = { key, revision, data: body.data, updatedAt: new Date().toISOString() };
        this.docs.set(key, doc);
        this.#record(key, revision, "put");
        return response(current ? 200 : 201, { ...this.#meta(doc), data: doc.data });
      }
      if (init.method === "DELETE") {
        if (!current) return error(404, "NOT_FOUND");
        if (Number(parsed.searchParams.get("expected_revision")) !== current.revision) {
          return error(409, "REVISION_CONFLICT");
        }
        const revision = (this.lastRevision.get(key) ?? 0) + 1;
        this.lastRevision.set(key, revision);
        this.docs.delete(key);
        this.#record(key, revision, "delete");
        return response(204);
      }
    }
    return error(404, "NOT_FOUND");
  };
}
