import { describe, expect, it } from "vitest";
import { RelayError, generateSpace, type FetchLike } from "@ayanami-task/sync-protocol";
import { RelayBackend } from "../src/data/relay-backend.js";

const BASE = "https://relay.test";

type Reply = { status: number; body: unknown };

/** 假中继：探测总是成功；/changes 按调用顺序依次回 replies 里的应答，并记下每次的 cursor。 */
function fakeRelay(replies: Reply[]) {
  const cursors: Array<string | null> = [];
  const fetchImpl: FetchLike = async (url) => {
    const parsed = new URL(url);
    let reply: Reply;
    if (parsed.pathname === "/v1/apps/atm") {
      reply = { status: 200, body: { id: "atm", relay: { long_poll: true, max_wait: 25 } } };
    } else if (parsed.pathname === "/v1/apps/atm/changes") {
      cursors.push(parsed.searchParams.get("cursor"));
      const next = replies.shift();
      if (!next) throw new Error("意外的 /changes 请求");
      reply = next;
    } else {
      throw new Error(`意外的请求 ${url}`);
    }
    const text = JSON.stringify(reply.body);
    return { status: reply.status, headers: { get: () => null }, text: async () => text };
  };
  return { fetchImpl, cursors };
}

async function backend(fetchImpl: FetchLike) {
  const space = generateSpace();
  return RelayBackend.create(
    { v: 1, u: BASE, a: "atm", t: "atr_test_token", s: space.spaceId, k: space.secret, n: "PC" },
    fetchImpl,
  );
}

const badCursor: Reply = {
  status: 400,
  body: { error: { code: "BAD_CURSOR", message: "游标无效" } },
};
const empty = (cursor: string): Reply => ({
  status: 200,
  body: { changes: [], next_cursor: cursor, has_more: false },
});

describe("RelayBackend.nextChanges 游标失效", () => {
  it("旧游标回 400 时从空游标重建一次变更流，返回 reset 让引擎全量重读", async () => {
    const relay = fakeRelay([badCursor, empty("c-new")]);
    const store = await backend(relay.fetchImpl);
    await store.connect("c-from-other-relay");
    const batch = await store.nextChanges(new AbortController().signal);
    expect(batch).toMatchObject({ reset: true, cursor: "c-new", changes: [] });
    expect(relay.cursors).toEqual(["c-from-other-relay", null]);
  });

  it("重建后仍然 400 就把错误交给引擎，不再无限重试", async () => {
    const relay = fakeRelay([badCursor, badCursor]);
    const store = await backend(relay.fetchImpl);
    await store.connect("c-stale");
    const failure = await store
      .nextChanges(new AbortController().signal)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RelayError);
    expect((failure as RelayError).status).toBe(400);
    expect(relay.cursors).toEqual(["c-stale", null]);
  });

  it("本来就是空游标时 400 直接报错，不重建", async () => {
    const relay = fakeRelay([badCursor]);
    const store = await backend(relay.fetchImpl);
    await store.connect(null);
    await expect(store.nextChanges(new AbortController().signal)).rejects.toBeInstanceOf(
      RelayError,
    );
    expect(relay.cursors).toEqual([null]);
  });

  it("其它错误（如 401）不当作游标失效", async () => {
    const relay = fakeRelay([{ status: 401, body: { error: { code: "UNAUTHORIZED" } } }]);
    const store = await backend(relay.fetchImpl);
    await store.connect("c-ok");
    await expect(store.nextChanges(new AbortController().signal)).rejects.toMatchObject({
      status: 401,
    });
    expect(relay.cursors).toEqual(["c-ok"]);
  });
});
