import { describe, expect, it } from "vitest";

import { RelayClient, type FetchLike } from "../src/index.js";

/** 一直不回的中继：只有请求的 signal 中止时才失败，并记下收到的 signal。 */
function silentRelay() {
  const signals: AbortSignal[] = [];
  const fetchImpl: FetchLike = (_url, init) => {
    const signal = init.signal;
    if (signal) signals.push(signal);
    return new Promise((_resolve, reject) => {
      if (!signal) return;
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  return { fetchImpl, signals };
}

describe("RelayClient 的生命周期 signal（连接器停下时掐断整个会话）", () => {
  it("中止后在途请求立即失败，之后的请求不再等", async () => {
    const relay = silentRelay();
    const lifetime = new AbortController();
    const client = new RelayClient({
      baseUrl: "https://relay.example.com",
      appId: "atm",
      token: "lifetime-test-token",
      fetchImpl: relay.fetchImpl,
      signal: lifetime.signal,
    });
    const probing = client.probe();
    const listing = client.getDocument("atm1/0123456789abcdef01234567/head");
    lifetime.abort();
    await expect(probing).rejects.toBeDefined();
    await expect(listing).rejects.toBeDefined();
    const began = performance.now();
    await expect(client.probe()).rejects.toBeDefined();
    expect(performance.now() - began).toBeLessThan(100);
    expect(relay.signals.length).toBeGreaterThanOrEqual(2);
    expect(relay.signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("不传生命周期时照旧只受单次超时与调用方 signal 约束", async () => {
    const relay = silentRelay();
    const client = new RelayClient({
      baseUrl: "https://relay.example.com",
      appId: "atm",
      token: "lifetime-test-token",
      fetchImpl: relay.fetchImpl,
      timeoutMs: 50,
    });
    await expect(client.probe()).rejects.toBeDefined();
    expect(relay.signals[0]?.aborted).toBe(true);
  });
});
