import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { AtmError } from "@ayanami-task/errors";
import { buildAyanamiServer, type SyncController } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const AGENT = "agent-token-from-daemon-json";
const USER = "user-token-held-in-main-process";
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const RELAY_TOKEN = "relay-token-never-in-status";
const PAIRING_CODE = "atm1:pairing-code-carries-token-and-secret";

/** 形状照 @ayanami-task/sync 的 SyncConnector；状态里不放任何密钥。 */
function fakeSync() {
  const calls: Array<[string, unknown]> = [];
  const controller: SyncController & { fail: Error | null } = {
    fail: null,
    async status() {
      calls.push(["status", null]);
      return {
        enabled: true,
        configured: true,
        relayUrl: "https://relay.example.com",
        appId: "atm",
        deviceName: "工作站",
        state: "online",
        lastError: null,
        lastSyncAt: null,
        longPoll: true,
        secretStore: "safeStorage",
        paired: [],
        pendingCommands: 0,
      };
    },
    async updateConfig(patch) {
      calls.push(["updateConfig", patch]);
      if (controller.fail) throw controller.fail;
      return controller.status();
    },
    async testRelay(candidate) {
      calls.push(["testRelay", candidate]);
      return { ok: true, latencyMs: 12, longPoll: true, server: "atm-relay 1.0.0" };
    },
    async createPairing() {
      calls.push(["createPairing", null]);
      return { pairingCode: PAIRING_CODE, spaceId: "0123456789abcdef01234567" };
    },
    async resetSpace() {
      calls.push(["resetSpace", null]);
      return { spaceId: "fedcba9876543210fedcba98", removed: 3 };
    },
  };
  return { controller, calls };
}

async function server(sync?: SyncController) {
  const dataDir = mkdtempSync(join(tmpdir(), "atm-sync-routes-"));
  temporary.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  const app = await buildAyanamiServer({
    service,
    token: AGENT,
    userToken: USER,
    ...(sync === undefined ? {} : { sync }),
  });
  return {
    app,
    async close() {
      await app.close();
      service.close();
    },
  };
}

const WRITES = [
  { method: "PUT", url: "/api/v1/sync/config", payload: { enabled: true, token: RELAY_TOKEN } },
  { method: "POST", url: "/api/v1/sync/test", payload: { relayUrl: "https://relay.example.com" } },
  { method: "POST", url: "/api/v1/sync/pairing", payload: {} },
  { method: "POST", url: "/api/v1/sync/reset", payload: {} },
] as const;

describe("手机同步路由", () => {
  it("写路由全部只认用户凭证；Agent 令牌 403 且不触达连接器", async () => {
    const { controller, calls } = fakeSync();
    const { app, close } = await server(controller);
    try {
      const syncRoutes = app.atmRoutes.filter((route) => route.url.startsWith("/api/v1/sync/"));
      expect(syncRoutes.map((route) => `${route.method} ${route.url}`).sort()).toEqual([
        "GET /api/v1/sync/status",
        "HEAD /api/v1/sync/status",
        "POST /api/v1/sync/pairing",
        "POST /api/v1/sync/reset",
        "POST /api/v1/sync/test",
        "PUT /api/v1/sync/config",
      ]);
      for (const route of syncRoutes.filter((entry) => !["GET", "HEAD"].includes(entry.method)))
        expect(route.principal, `${route.method} ${route.url}`).toBe("USER");

      for (const write of WRITES) {
        const refused = await app.inject({ ...write, headers: bearer(AGENT) });
        expect(refused.statusCode, write.url).toBe(403);
        expect(refused.json().error).toMatchObject({ code: "USER_AUTHORIZATION_REQUIRED" });
      }
      expect(calls).toEqual([]);
    } finally {
      await close();
    }
  });

  it("用户凭证能改配置、测中继、取配对码、重置；配对码响应不缓存", async () => {
    const { controller, calls } = fakeSync();
    const { app, close } = await server(controller);
    try {
      for (const write of WRITES) {
        const accepted = await app.inject({ ...write, headers: bearer(USER) });
        expect(accepted.statusCode, write.url).toBe(200);
      }
      expect(calls.map(([name]) => name)).toEqual([
        "updateConfig",
        "status",
        "testRelay",
        "createPairing",
        "resetSpace",
      ]);
      expect(calls[0]![1]).toEqual({ enabled: true, token: RELAY_TOKEN });
      const pairing = await app.inject({
        method: "POST",
        url: "/api/v1/sync/pairing",
        headers: bearer(USER),
        payload: {},
      });
      expect(pairing.json()).toEqual({
        pairingCode: PAIRING_CODE,
        spaceId: "0123456789abcdef01234567",
      });
      expect(pairing.headers["cache-control"]).toBe("no-store");
    } finally {
      await close();
    }
  });

  it("状态两种令牌都能读，内容里没有 token 与配对码", async () => {
    const { controller } = fakeSync();
    const { app, close } = await server(controller);
    try {
      for (const token of [AGENT, USER]) {
        const response = await app.inject({
          method: "GET",
          url: "/api/v1/sync/status",
          headers: bearer(token),
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ state: "online", configured: true });
        expect(response.body).not.toContain(RELAY_TOKEN);
        expect(response.body).not.toContain(PAIRING_CODE);
      }
      expect(
        (await app.inject({ method: "GET", url: "/api/v1/sync/status", headers: bearer("x") }))
          .statusCode,
      ).toBe(401);
    } finally {
      await close();
    }
  });

  it("连接器的校验错误按 AtmError 原样回给界面", async () => {
    const { controller } = fakeSync();
    controller.fail = new AtmError("INVALID_ARGUMENT", {
      message: "中继地址必须是 https",
      details: { field: "relayUrl" },
    });
    const { app, close } = await server(controller);
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/api/v1/sync/config",
        headers: bearer(USER),
        payload: { relayUrl: "http://relay.example.com" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatchObject({
        code: "INVALID_ARGUMENT",
        message: "中继地址必须是 https",
      });
    } finally {
      await close();
    }
  });

  it("宿主没有注入连接器：路由照样注册（权限照样生效），调用得到 404 SYNC_UNAVAILABLE", async () => {
    const { app, close } = await server();
    try {
      const status = await app.inject({
        method: "GET",
        url: "/api/v1/sync/status",
        headers: bearer(AGENT),
      });
      expect(status.statusCode).toBe(404);
      expect(status.json().error).toMatchObject({ code: "SYNC_UNAVAILABLE" });
      const refused = await app.inject({
        method: "POST",
        url: "/api/v1/sync/pairing",
        headers: bearer(AGENT),
        payload: {},
      });
      expect(refused.statusCode).toBe(403);
      const missing = await app.inject({
        method: "POST",
        url: "/api/v1/sync/pairing",
        headers: bearer(USER),
        payload: {},
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await close();
    }
  });
});
