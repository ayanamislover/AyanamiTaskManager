import { beforeEach, describe, expect, it, vi } from "vitest";
import { ackKey } from "@ayanami-task/sync-protocol";
import { CommandStoreError } from "../src/data/engine.js";
import { ScriptedBackend, change, settle, started, waitUntil } from "./support/scripted-backend.js";

// 本地存储换成内存表，并能按用例让写入失败（模拟 IndexedDB 打不开、额度满、事务被中止）。
const store = vi.hoisted(() => ({ data: new Map<string, unknown>(), failWrites: false }));
vi.mock("../src/data/cache.js", () => ({
  cacheGet: async (key: string) => store.data.get(key) ?? null,
  cachePut: async (key: string, value: unknown) => {
    if (store.failWrites) return false;
    store.data.set(key, structuredClone(value));
    return true;
  },
  cacheClear: async () => {
    store.data.clear();
    return true;
  },
  debouncedWriter: () => ({
    write() {},
    flush: () => Promise.resolve(),
    cancel() {},
  }),
}));

const createBody = { project: "DEMO", title: "从手机发的任务", priority: "NORMAL" as const };

beforeEach(() => {
  store.data.clear();
  store.failWrites = false;
});

describe("同步循环", () => {
  it("后台切回前台（pause 紧接 start）时同一时刻只有一个循环在等变更", async () => {
    const backend = new ScriptedBackend();
    backend.abortLagMs = 20;
    const engine = await started(backend);
    await waitUntil(() => backend.polling === 1, "第一次长轮询");
    for (let round = 0; round < 3; round += 1) {
      engine.pause();
      engine.start();
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    await waitUntil(() => backend.polling === 1, "恢复后的长轮询");
    expect(backend.maxPolling).toBe(1);
    await engine.stop();
    expect(backend.polling).toBe(0);
  });
});

describe("命令队列落盘", () => {
  it("存不进手机：submit 报错、队列不变、什么都不发", async () => {
    const backend = new ScriptedBackend();
    const engine = await started(backend);
    await settle(engine, (phase) => phase === "live");
    store.failWrites = true;
    await expect(engine.submit({ type: "task.create", body: createBody })).rejects.toBeInstanceOf(
      CommandStoreError,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(engine.getState().commands).toEqual([]);
    expect(backend.written).toEqual([]);
    await engine.stop();
  });

  it("存得进：先落盘再发出，重启后能从本地恢复", async () => {
    const backend = new ScriptedBackend();
    const engine = await started(backend);
    await settle(engine, (phase) => phase === "live");
    const id = await engine.submit({ type: "task.create", body: createBody });
    await waitUntil(() => backend.written.some((doc) => doc.id === id), "命令发到中继");
    const saved = store.data.get("commands") as Array<{ doc: { id: string } }>;
    expect(saved.map((command) => command.doc.id)).toEqual([id]);
    await engine.stop();
  });

  it("回执没存下来：不删中继上的回执，留到下次再读", async () => {
    const backend = new ScriptedBackend();
    const engine = await started(backend);
    await settle(engine, (phase) => phase === "live");
    const id = await engine.submit({ type: "task.create", body: createBody });
    await waitUntil(() => engine.getState().commands[0]?.state === "sent", "命令已发出");
    store.failWrites = true;
    backend.acks.set(id, {
      v: 1,
      id,
      at: new Date().toISOString(),
      ok: true,
      result: { project: "DEMO", key: "DEMO-T-0001" },
    });
    backend.batches.push([change(ackKey(backend.spaceId, id), "put", 1)]);
    engine.refresh();
    await settle(engine, (phase) => phase === "offline");
    expect(engine.getState().lastError).toContain("本地存储");
    expect(backend.deletedAcks).toEqual([]);
    expect(engine.getState().commands[0]?.state).toBe("sent");
    await engine.stop();
  });
});
