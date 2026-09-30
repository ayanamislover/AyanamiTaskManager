import { describe, expect, it } from "vitest";

import {
  ChangeFeed,
  PART_CHARS,
  RelayClient,
  RelayError,
  SpaceStore,
  deriveSpaceKeys,
  generateSpace,
  newDeviceId,
  sealObject,
  toBase64Url,
  type HeadDoc,
  type ProjectDoc,
} from "../src/index.js";
import { MemoryRelay } from "./support/memory-relay.js";

async function setup(options: { longPoll?: boolean } = {}) {
  const relay = new MemoryRelay(options);
  const space = generateSpace();
  const keys = await deriveSpaceKeys(space.secret);
  const client = new RelayClient({
    baseUrl: "https://relay.example.com",
    appId: "atm",
    token: relay.token,
    fetchImpl: relay.fetch,
  });
  const sleeps: number[] = [];
  const store = new SpaceStore({
    client,
    keys,
    spaceId: space.spaceId,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { relay, space, keys, client, store, sleeps };
}

function head(): HeadDoc {
  return {
    v: 1,
    host: { id: "pc-0123456789ab", name: "工作站", app: "1.3.0" },
    at: new Date().toISOString(),
    dispatch: { enabled: true, mode: "auto", running: 0 },
    projects: [],
  };
}

function randomText(length: number): string {
  const bytes = new Uint8Array(Math.ceil((length * 3) / 4));
  globalThis.crypto.getRandomValues(bytes);
  return toBase64Url(bytes).slice(0, length);
}

// 描述用随机内容，压不下去，保证会分成多片。
function bigProject(extra = 0): ProjectDoc {
  const tasks = Array.from({ length: 300 }, (_, index) => ({
    key: `ATM-T-${String(index + 1).padStart(4, "0")}`,
    title: `任务 ${index} 版本 ${extra}`,
    type: "TASK" as const,
    status: "READY" as const,
    priority: "NORMAL" as const,
    progress: 0,
    updatedAt: new Date(0).toISOString(),
    desc: randomText(1500),
  }));
  return { v: 1, code: "ATM", name: "ATM", at: new Date().toISOString(), tasks };
}

describe("SpaceStore", () => {
  it("写入对象后中继里只有密文，读回与原文一致", async () => {
    const { relay, store } = await setup();
    const written = head();
    await store.writeHead(written);
    const stored = [...relay.docs.values()];
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored[0]?.data)).not.toContain("工作站");
    expect(await store.readHead()).toEqual(written);
  });

  it("修订号缓存失效（例如进程重启）时靠 409 的 current 重试一次", async () => {
    const { store, client, keys, space } = await setup();
    await store.writeHead(head());
    const fresh = new SpaceStore({ client, keys, spaceId: space.spaceId });
    await fresh.writeHead({ ...head(), at: "2030-01-01T00:00:00.000Z" });
    expect((await store.readHead())?.at).toBe("2030-01-01T00:00:00.000Z");
  });

  it("大项目分片写入：先写其余片、最后写第 0 片；缩小后删掉多余旧片", async () => {
    const { relay, store } = await setup();
    const hash = await store.projectHash("ATM");
    await store.writeProject(hash, bigProject());
    const puts = relay.requests
      .filter((r) => r.method === "PUT")
      .map((r) => decodeURIComponent(r.url));
    expect(puts.length).toBeGreaterThan(1);
    expect(puts.at(-1)?.endsWith(`/p/${hash}`)).toBe(true);
    expect((await store.readProject(hash))?.tasks).toHaveLength(300);

    await store.writeProject(hash, { ...bigProject(), tasks: [] });
    const left = [...relay.docs.keys()].filter((key) => key.includes(`/p/${hash}`));
    expect(left).toEqual([expect.stringMatching(new RegExp(`/p/${hash}$`))]);
    expect((await store.readProject(hash))?.tasks).toEqual([]);
  });

  it("读到写了一半的分片对象会等一下重读", async () => {
    const { relay, store, keys, space, client } = await setup();
    const hash = await store.projectHash("ATM");
    await store.writeProject(hash, bigProject());
    // 模拟写入方刚写完新版本的其余片、还没写第 0 片。
    const logical = `atm1/${space.spaceId}/p/${hash}`;
    const next = await sealObject(keys, logical, bigProject(1));
    for (const part of next.slice(1)) {
      const current = relay.docs.get(part.key);
      await client.putDocument(part.key, current?.revision ?? 0, part.data);
    }
    let finished = false;
    const reader = new SpaceStore({
      client,
      keys,
      spaceId: space.spaceId,
      sleep: async () => {
        if (finished) return;
        finished = true;
        const current = relay.docs.get(logical);
        await client.putDocument(logical, current?.revision ?? 0, next[0]!.data);
      },
    });
    const doc = await reader.readProject(hash);
    expect(finished).toBe(true);
    expect(doc?.tasks[0]?.title).toBe(bigProject(1).tasks[0]?.title);
  });

  it("命令：ID 唯一、按新建写入；ack 往返；删除后读为空", async () => {
    const { store } = await setup();
    const device = { id: newDeviceId("m"), name: "OnePlus 9" };
    const command = await store.sendCommand(device, {
      type: "task.create",
      body: { project: "ATM", title: "修一下登录页", dispatch: true },
    });
    expect((await store.readCommand(command.id))?.body).toMatchObject({ title: "修一下登录页" });
    await store.writeAck({
      v: 1,
      id: command.id,
      at: new Date().toISOString(),
      ok: true,
      result: { project: "ATM", key: "ATM-T-0600" },
    });
    await store.deleteCommand(command.id);
    expect(await store.readCommand(command.id)).toBeNull();
    expect((await store.readAck(command.id))?.ok).toBe(true);
    expect(await store.listKeys("ack")).toHaveLength(1);
  });

  it("删除后重建：修订号跨删除单调，缓存里旧修订号不会导致失败", async () => {
    const { store, relay } = await setup();
    const device = { id: newDeviceId("m"), name: "手机" };
    const doc = {
      v: 1 as const,
      id: device.id,
      name: "手机",
      kind: "android" as const,
      role: "client" as const,
      app: "1.0.0",
      at: new Date().toISOString(),
      state: "online" as const,
    };
    await store.writeDevice(doc);
    await store.deleteDevice(device.id);
    await store.writeDevice({ ...doc, state: "offline" });
    expect((await store.readDevice(device.id))?.state).toBe("offline");
    const revisions = relay.changes.filter((c) => c.key.endsWith(device.id)).map((c) => c.revision);
    expect(revisions).toEqual([1, 2, 3]);
  });

  it("token 错误：RelayError 标记为鉴权失败", async () => {
    const { relay, keys, space } = await setup();
    const client = new RelayClient({
      baseUrl: "https://relay.example.com",
      appId: "atm",
      token: "wrong-token",
      fetchImpl: relay.fetch,
    });
    const store = new SpaceStore({ client, keys, spaceId: space.spaceId });
    const failure = await store.readHead().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RelayError);
    expect((failure as RelayError).isAuthFailure).toBe(true);
  });
});

describe("ChangeFeed", () => {
  it("首轮建立游标并要求全量；之后只给本空间的增量；空批次后按间隔等待", async () => {
    const { relay, store, client, space } = await setup();
    await store.writeHead(head());
    const naps: number[] = [];
    const feed = new ChangeFeed({
      client,
      spaceId: space.spaceId,
      cursor: null,
      longPoll: false,
      intervalMs: 3000,
      sleep: async (ms) => {
        naps.push(ms);
      },
    });
    expect(await feed.next()).toMatchObject({ reset: true, changes: [] });
    expect(feed.cursor).toBe(String(relay.seq));

    await client.putDocument("atm1/ffffffffffffffffffffffff/head", 0, { foreign: true });
    await store.writeHead({ ...head(), at: "2031-01-01T00:00:00.000Z" });
    const batch = await feed.next();
    expect(batch.reset).toBe(false);
    expect(batch.changes.map((c) => c.key)).toEqual([`atm1/${space.spaceId}/head`]);
    expect(naps).toEqual([]);

    expect((await feed.next()).changes).toEqual([]);
    expect(naps).toEqual([]);
    await feed.next();
    expect(naps).toEqual([3000]);
  });

  it("游标过期（410）时自动重建并要求全量", async () => {
    const { relay, store, client, space } = await setup();
    await store.writeHead(head());
    const feed = new ChangeFeed({
      client,
      spaceId: space.spaceId,
      cursor: "1",
      longPoll: false,
      intervalMs: 10,
    });
    for (let index = 0; index < 5; index += 1)
      await store.writeHead({ ...head(), at: `2031-01-0${index + 1}T00:00:00.000Z` });
    relay.prune(2);
    const batch = await feed.next();
    expect(batch.reset).toBe(true);
    expect(feed.cursor).toBe(String(relay.seq));
  });

  it("中继声明长轮询时带 wait 参数、不在本地睡", async () => {
    const { relay, client, space } = await setup({ longPoll: true });
    const probe = await client.probe();
    expect(probe.longPoll).toBe(true);
    const feed = new ChangeFeed({
      client,
      spaceId: space.spaceId,
      cursor: "0",
      longPoll: probe.longPoll,
      maxWait: probe.maxWait,
      intervalMs: 3000,
      sleep: async () => {
        throw new Error("长轮询模式不应该本地等待");
      },
    });
    await feed.next();
    await feed.next();
    expect(
      relay.requests
        .filter((r) => r.url.includes("/changes"))
        .every((r) => r.url.includes("wait=25")),
    ).toBe(true);
  });

  it("超大单对象被拒绝，不会写出半截", async () => {
    const { store, relay } = await setup();
    const hash = await store.projectHash("HUGE");
    // 随机字节不可压缩：约 8 MiB 的 base64 压不下去，加密后超过 64 片。
    const bytes = new Uint8Array(8 * 1024 * 1024);
    for (let offset = 0; offset < bytes.length; offset += 65536) {
      globalThis.crypto.getRandomValues(bytes.subarray(offset, offset + 65536));
    }
    const noise = toBase64Url(bytes);
    expect(noise.length).toBeGreaterThan(64 * PART_CHARS);
    await expect(
      store.writeObject(`atm1/${store.spaceId}/p/${hash}`, { noise }),
    ).rejects.toMatchObject({
      code: "OBJECT_TOO_LARGE",
    });
    expect(relay.docs.size).toBe(0);
  });
});
