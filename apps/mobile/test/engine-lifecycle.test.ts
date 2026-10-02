import { beforeEach, describe, expect, it, vi } from "vitest";
import { ackKey } from "@ayanami-task/sync-protocol";
import { CommandStoreError, EngineStoppedError } from "../src/data/engine.js";
import { ScriptedBackend, change, settle, started, waitUntil } from "./support/scripted-backend.js";

// 本地存储换成内存表，并能按用例让写入失败（模拟 IndexedDB 打不开、额度满、事务被中止）。
const store = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  failWrites: false,
  /** 设上之后写入会卡在这里，直到用例放行：模拟一次慢的 IndexedDB 事务。 */
  gate: null as Promise<void> | null,
}));
vi.mock("../src/data/cache.js", () => ({
  cacheGet: async (key: string) => store.data.get(key) ?? null,
  cachePut: async (key: string, value: unknown) => {
    if (store.gate) await store.gate;
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
  store.gate = null;
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

describe("stop 终止实例", () => {
  it("落盘中的 submit 遇上 stop：stop 等它写完，旧引擎不会被拉起来接着联网", async () => {
    const backend = new ScriptedBackend();
    const engine = await started(backend);
    await waitUntil(() => backend.polling === 1, "长轮询");
    let release!: () => void;
    store.gate = new Promise<void>((resolve) => (release = resolve));
    const pending = engine.submit({ type: "task.create", body: createBody });
    await Promise.resolve();
    let stopped = false;
    const stopping = engine.stop().then(() => (stopped = true));
    // 从调用 stop 起，这个实例就不该再联网读任何东西。
    const reads = backend.reads;
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 写入还卡着：stop 不能先返回，否则调用方清缓存会和这次写交错。
    expect(stopped).toBe(false);
    release();
    await stopping;
    const id = await pending;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect({
      polling: backend.polling,
      written: backend.written.length,
      reads: backend.reads,
    }).toEqual({ polling: 0, written: 0, reads });
    // 命令已经存下，同一配对的下一台引擎会接着发。
    const saved = store.data.get("commands") as Array<{ doc: { id: string } }>;
    expect(saved.map((command) => command.doc.id)).toEqual([id]);
  });

  it("stop 之后再发：明确报错，不写缓存也不联网", async () => {
    const backend = new ScriptedBackend();
    const engine = await started(backend);
    await settle(engine, (phase) => phase === "live");
    await engine.stop();
    const reads = backend.reads;
    await expect(engine.submit({ type: "task.create", body: createBody })).rejects.toBeInstanceOf(
      EngineStoppedError,
    );
    engine.start();
    engine.refresh();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.data.get("commands")).toBeUndefined();
    expect({ polling: backend.polling, reads: backend.reads }).toEqual({ polling: 0, reads });
  });

  it("pause 不是终止：回前台照常恢复，能发命令", async () => {
    const backend = new ScriptedBackend();
    const engine = await started(backend);
    await settle(engine, (phase) => phase === "live");
    engine.pause();
    engine.start();
    await settle(engine, (phase) => phase === "live");
    const id = await engine.submit({ type: "task.create", body: createBody });
    await waitUntil(() => backend.written.some((doc) => doc.id === id), "恢复后发出");
    await engine.stop();
  });
});
