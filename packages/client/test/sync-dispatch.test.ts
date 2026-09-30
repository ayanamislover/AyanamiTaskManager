import { describe, expect, it } from "vitest";
import { AyanamiClient, AyanamiClientError } from "../src/index.js";

type Captured = { url: string; method: string; body: unknown; headers: Record<string, string> };

/** 注入 fetch：记下每次请求，按顺序回放给定的响应体。 */
function recordingClient(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: String(init?.method),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: { ...(init?.headers as Record<string, string>) },
    });
    const next = responses.shift() ?? { body: {} };
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const client = new AyanamiClient({
    endpoint: "http://127.0.0.1:4394/",
    token: "user-token",
    fetchImpl,
  });
  return { client, calls };
}

describe("手机同步 REST 客户端", () => {
  it("状态、配置、测试、配对、重置打到 §7 规定的路径与方法", async () => {
    const status = {
      enabled: true,
      configured: true,
      relayUrl: "https://relay.example.com",
      appId: "atm",
      deviceName: "书房电脑",
      state: "online",
      lastError: null,
      lastSyncAt: "2026-09-30T10:00:00.000Z",
      longPoll: true,
      secretStore: "safeStorage",
      paired: [],
      pendingCommands: 0,
    };
    const { client, calls } = recordingClient([
      { body: status },
      { body: status },
      { body: { ok: true, latencyMs: 42, longPoll: true } },
      { body: { ok: true, latencyMs: 40, longPoll: false } },
      { body: { pairingCode: "atm1:abc", spaceId: "0123456789abcdef01234567" } },
      { body: { spaceId: "fedcba9876543210fedcba98" } },
    ]);

    await expect(client.getSyncStatus()).resolves.toMatchObject({ state: "online" });
    await client.updateSyncConfig({ enabled: true, relayUrl: "https://r.example", token: "" });
    await expect(
      client.testSyncRelay({ relayUrl: "https://r.example", appId: "atm", token: "t" }),
    ).resolves.toMatchObject({ latencyMs: 42 });
    await client.testSyncRelay();
    await expect(client.createSyncPairing()).resolves.toEqual({
      pairingCode: "atm1:abc",
      spaceId: "0123456789abcdef01234567",
    });
    await client.resetSyncSpace();

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET http://127.0.0.1:4394/api/v1/sync/status",
      "PUT http://127.0.0.1:4394/api/v1/sync/config",
      "POST http://127.0.0.1:4394/api/v1/sync/test",
      "POST http://127.0.0.1:4394/api/v1/sync/test",
      "POST http://127.0.0.1:4394/api/v1/sync/pairing",
      "POST http://127.0.0.1:4394/api/v1/sync/reset",
    ]);
    expect(calls[0]!.body).toBeUndefined();
    // 空字符串 token 表示清除，必须原样发出去，不能被当成「没传」丢掉。
    expect(calls[1]!.body).toEqual({ enabled: true, relayUrl: "https://r.example", token: "" });
    expect(calls[2]!.body).toEqual({ relayUrl: "https://r.example", appId: "atm", token: "t" });
    expect(calls[3]!.body).toEqual({});
    expect(calls.every((call) => call.headers.authorization === "Bearer user-token")).toBe(true);
  });
});

describe("Claude 派单 REST 客户端", () => {
  it("状态、配置、派单、结束打到 §7 规定的路径，路径段做编码", async () => {
    const { client, calls } = recordingClient([
      {
        body: {
          enabled: false,
          permissionMode: "auto",
          maxConcurrent: 1,
          model: null,
          effort: null,
          claude: { found: true, path: "C:/bin/claude.exe", version: "2.1.0" },
          runs: [],
        },
      },
      { body: {} },
      { body: { run: "r1", state: "queued" } },
      { body: { run: "r/1", state: "cancelled" } },
    ]);

    await expect(client.getDispatchStatus()).resolves.toMatchObject({
      claude: { found: true },
    });
    await client.updateDispatchConfig({ enabled: true, model: null, effort: "high" });
    await expect(client.dispatchTask("ATM", "ATM-T-0546")).resolves.toMatchObject({ run: "r1" });
    await client.cancelDispatchRun("r/1");

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET http://127.0.0.1:4394/api/v1/dispatch/status",
      "PUT http://127.0.0.1:4394/api/v1/dispatch/config",
      "POST http://127.0.0.1:4394/api/v1/projects/ATM/ui/work-items/ATM-T-0546/dispatch",
      "POST http://127.0.0.1:4394/api/v1/dispatch/runs/r%2F1/cancel",
    ]);
    // null 是「改回跟随默认」，JSON 里必须保留。
    expect(calls[1]!.body).toEqual({ enabled: true, model: null, effort: "high" });
    expect(calls[2]!.body).toEqual({});
  });

  it("派单被拒时保留服务端的中文原因与 HTTP 状态", async () => {
    const { client } = recordingClient([
      {
        status: 409,
        body: { error: { code: "DISPATCH_DISABLED", message: "派单未开启", retryable: false } },
      },
    ]);
    const failure = await client.dispatchTask("ATM", "ATM-T-1").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AyanamiClientError);
    expect(failure).toMatchObject({ status: 409, message: "派单未开启" });
  });
});
