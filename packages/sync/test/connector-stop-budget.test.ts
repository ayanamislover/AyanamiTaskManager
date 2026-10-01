import { afterEach, describe, expect, it } from "vitest";
import type { AyanamiTaskService } from "@ayanami-task/application";
import type { FetchLike, FetchLikeInit } from "@ayanami-task/sync-protocol";
import {
  RELAY_URL,
  cleanupFixtures,
  connect,
  openFixture,
  phoneFor,
  seedProject,
  waitFor,
} from "./support/fixture.js";
import type { MemoryRelay } from "./support/memory-relay.js";

afterEach(cleanupFixtures);

/** 测试夹具给连接器的停止预算（fixture.ts 的 stopTimeoutMs）。 */
const BUDGET_MS = 1000;
/** 预算用完、掐断请求后再等在途任务落定的时间（connector.ts 的 ABORT_SETTLE_MS）。 */
const SETTLE_MS = 500;

/**
 * 让匹配的请求挂住，直到被中止为止（像一个迟迟不响应的中继）。记下它们的 signal，
 * 用来断言停下时确实被掐断，而不是等它们自己超时。
 */
function hanging(relay: MemoryRelay, match: (url: string, init: FetchLikeInit) => boolean) {
  const held: AbortSignal[] = [];
  let holding = false;
  const fetch: FetchLike = async (url, init) => {
    if (!holding || !match(url, init)) return relay.fetch(url, init);
    const signal = init.signal;
    if (!signal) throw new Error("请求没有带 signal，停下时掐不断");
    held.push(signal);
    return new Promise((_resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  return {
    fetch,
    held,
    hold() {
      holding = true;
    },
  };
}

describe("连接器停下的总预算（原生宿主只给 core 8 s 退出）", () => {
  it("还在探测中继时停下：立即掐断探测，不等它自己超时（peer R1-02 的复现）", async () => {
    const fixture = await openFixture();
    try {
      const probe = hanging(
        fixture.relay,
        (url, init) => init.method === "GET" && new URL(url).pathname === "/v1/apps/atm",
      );
      probe.hold();
      const connector = fixture.connector({ fetchImpl: probe.fetch });
      await connector.updateConfig({
        enabled: true,
        relayUrl: RELAY_URL,
        token: fixture.relay.token,
      });
      await connector.start();
      await waitFor(() => probe.held.length > 0, "探测已发出");
      const began = performance.now();
      await connector.stop();
      expect(performance.now() - began).toBeLessThan(BUDGET_MS / 2);
      expect(probe.held.every((signal) => signal.aborted)).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  it("在线时中继写操作卡住：预算内停下，在途请求全部被掐断，也不再写离线状态", async () => {
    const fixture = await openFixture();
    try {
      const writes = hanging(fixture.relay, (_url, init) => init.method === "PUT");
      const connector = fixture.connector({ fetchImpl: writes.fetch });
      await connect(connector, fixture.relay);
      writes.hold();
      await seedProject(fixture.service, "SLOW");
      await waitFor(() => writes.held.length > 0, "发布卡在中继");
      const heldBefore = writes.held.length;
      const began = performance.now();
      await connector.stop();
      const elapsed = performance.now() - began;
      expect(elapsed).toBeLessThan(BUDGET_MS + SETTLE_MS + 300);
      expect(writes.held.every((signal) => signal.aborted)).toBe(true);
      // 中继已经不响应：没有再去写离线状态（那也只会再卡一次）。
      expect(writes.held.length).toBe(heldBefore);
    } finally {
      await fixture.close();
    }
  });

  it("在线、手头没活，但写离线状态时中继卡住：用剩下的预算写，到点掐断", async () => {
    const fixture = await openFixture();
    try {
      // 只挂住本机设备文档（`<空间>/dev/<设备>`）的写入，也就是在线 / 离线状态。
      const presence = hanging(
        fixture.relay,
        (url, init) => init.method === "PUT" && url.includes("%2Fdev%2F"),
      );
      const connector = fixture.connector({ fetchImpl: presence.fetch });
      await connect(connector, fixture.relay);
      presence.hold();
      const began = performance.now();
      await connector.stop();
      const elapsed = performance.now() - began;
      expect(elapsed).toBeLessThan(BUDGET_MS + 300);
      expect(presence.held.length).toBe(1);
      expect(presence.held[0]!.aborted).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  it("停下以后，卡在半路的手机命令放行时不再碰 service（core 随后就关库）", async () => {
    const fixture = await openFixture();
    try {
      await seedProject(fixture.service, "GATE");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let gating = false;
      let entered = false;
      let stopped = false;
      const lateCalls: string[] = [];
      // 只拦两件事：让命令卡在「找目标」上；停下以后谁再调 service 都记下来。
      const real = fixture.service;
      const service = new Proxy(real, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property, target);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (stopped) lateCalls.push(String(property));
            const call = () => (value as (...a: unknown[]) => unknown).apply(target, args);
            if (property === "listObjectives" && gating) {
              entered = true;
              return gate.then(call);
            }
            return call();
          };
        },
      }) as AyanamiTaskService;
      const connector = fixture.connector({ service });
      const pairing = await connect(connector, fixture.relay);
      const phone = await phoneFor(fixture.relay, pairing.pairingCode);
      gating = true;
      await phone.store.sendCommand(phone.device, {
        type: "task.create",
        body: { project: "GATE", title: "停下时还没建完的任务" },
      });
      await waitFor(() => entered, "命令卡在找目标上");
      await connector.stop();
      stopped = true;
      release();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(lateCalls).toEqual([]);
      expect(await real.listWorkItemsForUi("GATE", {})).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("设置页「测试连接」还在等中继时停下：一并掐断，不拖住退出", async () => {
    const fixture = await openFixture();
    try {
      const probe = hanging(
        fixture.relay,
        (url, init) => init.method === "GET" && new URL(url).pathname === "/v1/apps/atm",
      );
      const connector = fixture.connector({ fetchImpl: probe.fetch });
      await connector.start();
      probe.hold();
      const testing = connector.testRelay({ relayUrl: RELAY_URL, token: fixture.relay.token });
      await waitFor(() => probe.held.length > 0, "测试连接已发出");
      await connector.stop();
      const began = performance.now();
      const result = await testing;
      expect(performance.now() - began).toBeLessThan(200);
      expect(result.ok).toBe(false);
      expect(probe.held.every((signal) => signal.aborted)).toBe(true);
    } finally {
      await fixture.close();
    }
  });
});
