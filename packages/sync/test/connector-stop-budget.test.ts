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
  seedTask,
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

/**
 * 包一层 service：方法照常执行，但指定方法的结果要等放行才交回（像一次慢查询）。
 * 停下（markStopped）之后新进来的任何调用都记下——停下的会话不该再碰 service。
 */
function slowService(real: AyanamiTaskService, method: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let holding = false;
  let entered = false;
  let stopped = false;
  const late: string[] = [];
  const service = new Proxy(real, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (stopped) late.push(String(property));
        const result: unknown = Reflect.apply(value as (...a: unknown[]) => unknown, target, args);
        if (!holding || property !== method) return result;
        entered = true;
        return gate.then(() => result);
      };
    },
  }) as AyanamiTaskService;
  return {
    service,
    late,
    release,
    hold: () => void (holding = true),
    entered: () => entered,
    markStopped: () => void (stopped = true),
  };
}

/** 停下、放行慢查询，给迟到的任务一点时间，看它们有没有再碰 service。 */
async function stopThenRelease(slow: ReturnType<typeof slowService>, stop: () => Promise<void>) {
  await waitFor(slow.entered, "慢查询已进入");
  await stop();
  slow.markStopped();
  slow.release();
  await new Promise((resolve) => setTimeout(resolve, 150));
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
      expect(elapsed).toBeLessThan(BUDGET_MS + SETTLE_MS + 500);
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
      expect(elapsed).toBeLessThan(BUDGET_MS + 500);
      expect(presence.held.length).toBe(1);
      expect(presence.held[0]!.aborted).toBe(true);
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
      expect(performance.now() - began).toBeLessThan(500);
      expect(result.ok).toBe(false);
      expect(probe.held.every((signal) => signal.aborted)).toBe(true);
    } finally {
      await fixture.close();
    }
  });
});

describe("停下的会话不再碰 service（core 随后就关库；peer R2-01 / R2-02）", () => {
  it("手机建任务卡在找目标上：停下后放行，不再建任务", async () => {
    const fixture = await openFixture();
    const slow = slowService(fixture.service, "listObjectives");
    try {
      await seedProject(fixture.service, "GATE");
      const connector = fixture.connector({ service: slow.service });
      const pairing = await connect(connector, fixture.relay);
      const phone = await phoneFor(fixture.relay, pairing.pairingCode);
      slow.hold();
      await phone.store.sendCommand(phone.device, {
        type: "task.create",
        body: { project: "GATE", title: "停下时还没建完的任务" },
      });
      await stopThenRelease(slow, () => connector.stop());
      expect(slow.late).toEqual([]);
      expect(await fixture.service.listWorkItemsForUi("GATE", {})).toEqual([]);
    } finally {
      slow.release();
      await fixture.close();
    }
  });

  it("项目还没有目标：停下后放行，不会再补建目标（辅助函数缓存了 service 也拦得住）", async () => {
    const fixture = await openFixture();
    const slow = slowService(fixture.service, "listObjectives");
    try {
      await seedProject(fixture.service, "ROOT", { objective: false });
      const connector = fixture.connector({ service: slow.service });
      const pairing = await connect(connector, fixture.relay);
      const phone = await phoneFor(fixture.relay, pairing.pairingCode);
      slow.hold();
      await phone.store.sendCommand(phone.device, {
        type: "task.create",
        body: { project: "ROOT", title: "需要先补目标的任务" },
      });
      await stopThenRelease(slow, () => connector.stop());
      expect(slow.late).toEqual([]);
      expect(await fixture.service.listObjectives("ROOT")).toEqual([]);
    } finally {
      slow.release();
      await fixture.close();
    }
  });

  it("发布快照卡在读任务上：停下后放行，快照的后续读取不再发生", async () => {
    const fixture = await openFixture();
    const slow = slowService(fixture.service, "listWorkItemsForUi");
    try {
      const objective = await seedProject(fixture.service, "SNAP");
      const connector = fixture.connector({ service: slow.service });
      await connect(connector, fixture.relay);
      slow.hold();
      await seedTask(fixture.service, "SNAP", objective!, { title: "触发一次发布" });
      await stopThenRelease(slow, () => connector.stop());
      expect(slow.late).toEqual([]);
    } finally {
      slow.release();
      await fixture.close();
    }
  });

  it("停用同步正在停旧会话时又要退出：stop 等那次停止作废完旧会话才返回", async () => {
    const fixture = await openFixture();
    const slow = slowService(fixture.service, "listObjectives");
    let disabling: Promise<unknown> | undefined;
    try {
      await seedProject(fixture.service, "RACE");
      const connector = fixture.connector({ service: slow.service });
      const pairing = await connect(connector, fixture.relay);
      const phone = await phoneFor(fixture.relay, pairing.pairingCode);
      slow.hold();
      await phone.store.sendCommand(phone.device, {
        type: "task.create",
        body: { project: "RACE", title: "停用时还在建的任务" },
      });
      await waitFor(slow.entered, "命令卡在找目标上");
      disabling = connector.updateConfig({ enabled: false });
      await waitFor(async () => !(await connector.status()).enabled, "停用已开始停旧会话");
      const began = performance.now();
      const stopping = connector.stop();
      // 重复调用拿到的是同一次停止。
      expect(connector.stop()).toBe(stopping);
      await stopping;
      // 旧会话的命令卡着、排不干：stop 跟着那次停止等满预算（而不是立刻返回）。
      expect(performance.now() - began).toBeGreaterThan(BUDGET_MS / 2);
      slow.markStopped();
      slow.release();
      await disabling;
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(slow.late).toEqual([]);
      expect(await fixture.service.listWorkItemsForUi("RACE", {})).toEqual([]);
    } finally {
      slow.release();
      await disabling;
      await fixture.close();
    }
  });
});
