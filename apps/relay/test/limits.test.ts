// 限额：请求体、data、文档数、存储量、限流、长轮询名额，以及长轮询的生命周期（断开、关闭）。
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, limitsFromEnv } from "../src/limits.js";
import { TokenBucketLimiter, WaiterGate } from "../src/rate-limit.js";
import { createToken } from "../src/tokens.js";
import { call, cleanupHarness, startTestRelay } from "./support/relay-harness.js";

afterEach(cleanupHarness);

const doc = (key: string) => `/v1/apps/atm/documents/${encodeURIComponent(key)}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("体积与配额", () => {
  it("请求体超过上限 413；data 超过上限但请求体未超 413；都不落库", async () => {
    const relay = await startTestRelay({ limits: { maxBodyBytes: 2048, maxDataBytes: 1024 } });
    const bodyTooBig = await call(relay, "PUT", doc("a"), {
      body: { expected_revision: 0, data: "x".repeat(3000) },
    });
    expect(bodyTooBig.status).toBe(413);
    expect(bodyTooBig.json.error.code).toBe("PAYLOAD_TOO_LARGE");

    const wayTooBig = await call(relay, "PUT", doc("a"), {
      body: { expected_revision: 0, data: "x".repeat(20_000) },
    });
    expect(wayTooBig.status).toBe(413);

    const dataTooBig = await call(relay, "PUT", doc("a"), {
      body: { expected_revision: 0, data: "x".repeat(1100) },
    });
    expect(dataTooBig.status).toBe(413);
    expect(dataTooBig.json.error.message).toMatch(/1 KiB/);
    expect((await call(relay, "GET", doc("a"))).status).toBe(404);

    // 同一连接上被拒之后，下一个请求照常处理（稍超限的体被读完，没有残留字节）。
    const ok = await call(relay, "PUT", doc("a"), { body: { expected_revision: 0, data: "ok" } });
    expect(ok.status).toBe(201);
  });

  it("每 app 文档数与总字节到顶 507 INSUFFICIENT_STORAGE；更新已有文档不受文档数限制", async () => {
    const relay = await startTestRelay({ limits: { maxDocumentsPerApp: 2, maxBytesPerApp: 100 } });
    const first = await call(relay, "PUT", doc("d1"), {
      body: { expected_revision: 0, data: "a".repeat(30) },
    });
    await call(relay, "PUT", doc("d2"), { body: { expected_revision: 0, data: 1 } });
    const third = await call(relay, "PUT", doc("d3"), { body: { expected_revision: 0, data: 1 } });
    expect(third.status).toBe(507);
    expect(third.json.error.code).toBe("INSUFFICIENT_STORAGE");

    const update = await call(relay, "PUT", doc("d1"), {
      body: { expected_revision: first.json.revision, data: "b".repeat(40) },
    });
    expect(update.status).toBe(200);
    const bloated = await call(relay, "PUT", doc("d1"), {
      body: { expected_revision: update.json.revision, data: "c".repeat(120) },
    });
    expect(bloated.status).toBe(507);
  });
});

describe("限流", () => {
  it("每 token 每秒请求数超限 429 RATE_LIMITED，带 retry_after 与 Retry-After", async () => {
    const relay = await startTestRelay({ limits: { requestsPerSecond: 3 } });
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => call(relay, "GET", "/v1/apps/atm/documents")),
    );
    const limited = responses.filter((r) => r.status === 429);
    expect(responses.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(3);
    expect(limited.length).toBeGreaterThan(0);
    expect(limited[0]!.json.error.code).toBe("RATE_LIMITED");
    expect(limited[0]!.json.error.retry_after).toBeGreaterThanOrEqual(1);
    expect(limited[0]!.headers.get("retry-after")).toBe(String(limited[0]!.json.error.retry_after));

    // 另一枚 token 有自己的桶。
    const other = createToken(relay.relay.db, "atm", "另一台").plaintext;
    expect((await call(relay, "GET", "/v1/apps/atm", { token: other })).status).toBe(200);
  });

  it("未认证请求按来源地址限流：乱试 token 很快被 429 挡住", async () => {
    const relay = await startTestRelay({ limits: { requestsPerSecond: 2 } });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await call(relay, "GET", "/v1/apps/atm", { token: `atr_guess${i}` })).status);
    }
    expect(statuses).toContain(401);
    expect(statuses).toContain(429);
  });

  it("令牌桶按时间回填；名额按 token 与全局两级计数", () => {
    let now = 0;
    const limiter = new TokenBucketLimiter(2, () => now);
    expect([limiter.take("k"), limiter.take("k"), limiter.take("k")]).toEqual([0, 0, 1]);
    now += 500;
    expect(limiter.take("k")).toBe(0);
    expect(limiter.take("k")).toBe(1);

    const gate = new WaiterGate(1, 2);
    expect(gate.acquire("a")).toBe(true);
    expect(gate.acquire("a")).toBe(false);
    expect(gate.acquire("b")).toBe(true);
    expect(gate.acquire("c")).toBe(false);
    gate.release("a");
    expect(gate.acquire("c")).toBe(true);
    expect(gate.active).toBe(2);
  });

  it("限额环境变量：合法值覆盖默认，非法值直接报错", () => {
    expect(limitsFromEnv({})).toEqual(DEFAULT_LIMITS);
    const custom = limitsFromEnv({
      ATM_RELAY_RATE_PER_SECOND: "80",
      ATM_RELAY_MAX_DOCUMENTS: " 10 ",
    });
    expect(custom.requestsPerSecond).toBe(80);
    expect(custom.maxDocumentsPerApp).toBe(10);
    expect(() => limitsFromEnv({ ATM_RELAY_MAX_BODY_BYTES: "300k" })).toThrow(
      /ATM_RELAY_MAX_BODY_BYTES/,
    );
    expect(() => limitsFromEnv({ ATM_RELAY_WAITERS_GLOBAL: "0" })).toThrow();
    expect(() => limitsFromEnv({ ATM_RELAY_MAX_WAIT_SECONDS: "120" })).toThrow();
  });
});

describe("长轮询", () => {
  it("每 token 名额用尽 429 TOO_MANY_WAITERS；名额释放后可再挂起", async () => {
    const relay = await startTestRelay({ limits: { waitersPerToken: 1 } });
    const first = call(relay, "GET", "/v1/apps/atm/changes?wait=2");
    await sleep(200);
    const second = await call(relay, "GET", "/v1/apps/atm/changes?wait=2");
    expect(second.status).toBe(429);
    expect(second.json.error.code).toBe("TOO_MANY_WAITERS");
    expect(second.json.error.retry_after).toBe(1);
    expect((await first).status).toBe(200);
    const third = call(relay, "GET", "/v1/apps/atm/changes?wait=1");
    expect((await third).status).toBe(200);
  });

  it("全局名额跨 token 计数", async () => {
    const relay = await startTestRelay({ limits: { waitersGlobal: 1 } });
    const other = createToken(relay.relay.db, "atm", "另一台").plaintext;
    const first = call(relay, "GET", "/v1/apps/atm/changes?wait=2");
    await sleep(200);
    const blocked = await call(relay, "GET", "/v1/apps/atm/changes?wait=2", { token: other });
    expect(blocked.status).toBe(429);
    expect(blocked.json.error.code).toBe("TOO_MANY_WAITERS");
    await first;
  });

  it("客户端中途断开会立即归还名额", async () => {
    const relay = await startTestRelay({ limits: { waitersPerToken: 1 } });
    const abort = new AbortController();
    const dropped = call(relay, "GET", "/v1/apps/atm/changes?wait=20", { signal: abort.signal });
    await sleep(200);
    abort.abort();
    await expect(dropped).rejects.toThrow();
    await sleep(200);
    const next = call(relay, "GET", "/v1/apps/atm/changes?wait=1");
    expect((await next).status).toBe(200);
  });

  it("wait 超过上限按上限处理；不是整数 400", async () => {
    const relay = await startTestRelay({ limits: { maxWaitSeconds: 1 } });
    const clamped = await call(relay, "GET", "/v1/apps/atm/changes?wait=30");
    expect(clamped.status).toBe(200);
    expect(clamped.elapsedMs).toBeGreaterThanOrEqual(800);
    expect(clamped.elapsedMs).toBeLessThan(5000);
    const bad = await call(relay, "GET", "/v1/apps/atm/changes?wait=abc");
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("INVALID_ARGUMENT");
  });

  it("别的 app 的写入不唤醒本 app 的长轮询", async () => {
    const relay = await startTestRelay();
    const { createApp } = await import("../src/tokens.js");
    createApp(relay.relay.db, "other", "别的应用");
    const otherToken = createToken(relay.relay.db, "other", "x").plaintext;
    const pending = call(relay, "GET", "/v1/apps/atm/changes?wait=2");
    await sleep(200);
    await call(relay, "PUT", "/v1/apps/other/documents/k", {
      token: otherToken,
      body: { expected_revision: 0, data: 1 },
    });
    const response = await pending;
    expect(response.json.changes).toEqual([]);
    expect(response.elapsedMs).toBeGreaterThanOrEqual(1500);
  });

  it("关闭中继时挂起的长轮询立即以空页返回，库随后关闭", async () => {
    const relay = await startTestRelay();
    const pending = call(relay, "GET", "/v1/apps/atm/changes?wait=20");
    await sleep(200);
    const started = performance.now();
    await relay.stop();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.json.changes).toEqual([]);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(() => relay.relay.db.prepare("SELECT 1").get()).toThrow();
  });
});
