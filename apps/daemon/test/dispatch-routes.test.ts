import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { AtmError } from "@ayanami-task/errors";
import { buildAyanamiServer, type DispatchController } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const AGENT = "agent-token-from-daemon-json";
const USER = "user-token-held-in-main-process";
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** 与 agent-dispatch 的 DispatchError 同形：code / httpStatus / retryable / details。 */
class FakeDispatchError extends Error {
  readonly httpStatus: number;
  readonly retryable = false;
  constructor(
    readonly code: string,
    status: number,
    message: string,
    readonly details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.httpStatus = status;
  }
}

function fakeController() {
  const calls: Array<[string, unknown]> = [];
  const controller: DispatchController & { fail: Error | null } = {
    fail: null,
    async status() {
      calls.push(["status", null]);
      return { enabled: true, claude: { found: true, path: "C:/claude.exe" }, runs: [] };
    },
    async updateConfig(patch) {
      calls.push(["updateConfig", patch]);
      if (controller.fail) throw controller.fail;
      return { enabled: true, ...(patch as object) };
    },
    async enqueue(input) {
      calls.push(["enqueue", input]);
      if (controller.fail) throw controller.fail;
      return { run: "mg7x3k2a-1a2b3c4d", state: "queued", ...input };
    },
    async cancel(run) {
      calls.push(["cancel", run]);
      if (controller.fail) throw controller.fail;
      return { run, state: "cancelled" };
    },
  };
  return { controller, calls };
}

async function server(dispatch?: DispatchController) {
  const dataDir = mkdtempSync(join(tmpdir(), "atm-dispatch-routes-"));
  temporary.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  const app = await buildAyanamiServer({
    service,
    token: AGENT,
    userToken: USER,
    ...(dispatch === undefined ? {} : { dispatch }),
  });
  return {
    app,
    async close() {
      await app.close();
      service.close();
    },
  };
}

const DISPATCH_URL = "/api/v1/projects/DEMO/ui/work-items/DEMO-T-0001/dispatch";

describe("派单路由", () => {
  it("状态两种令牌都能读；写操作只认用户令牌，Agent 令牌 403 且控制器没被调用", async () => {
    const { controller, calls } = fakeController();
    const { app, close } = await server(controller);
    try {
      for (const token of [AGENT, USER]) {
        const status = await app.inject({
          method: "GET",
          url: "/api/v1/dispatch/status",
          headers: bearer(token),
        });
        expect(status.statusCode).toBe(200);
        expect(status.json()).toMatchObject({ enabled: true, claude: { found: true } });
      }
      calls.splice(0);

      const writes = [
        { method: "PUT" as const, url: "/api/v1/dispatch/config", payload: { enabled: true } },
        { method: "POST" as const, url: DISPATCH_URL, payload: {} },
        { method: "POST" as const, url: "/api/v1/dispatch/runs/mg7x3k2a-1a2b3c4d/cancel" },
      ];
      for (const write of writes) {
        const refused = await app.inject({ ...write, headers: bearer(AGENT) });
        expect(refused.statusCode, write.url).toBe(403);
        expect(refused.json().error).toMatchObject({ code: "USER_AUTHORIZATION_REQUIRED" });
      }
      expect(calls).toEqual([]);

      const config = await app.inject({ ...writes[0]!, headers: bearer(USER) });
      expect(config.statusCode).toBe(200);
      const queued = await app.inject({ ...writes[1]!, headers: bearer(USER) });
      expect(queued.statusCode).toBe(201);
      expect(queued.json()).toMatchObject({ run: "mg7x3k2a-1a2b3c4d", state: "queued" });
      const cancelled = await app.inject({ ...writes[2]!, headers: bearer(USER) });
      expect(cancelled.statusCode).toBe(200);
      expect(calls).toEqual([
        ["updateConfig", { enabled: true }],
        ["enqueue", { project: "DEMO", key: "DEMO-T-0001", origin: "desktop" }],
        ["cancel", "mg7x3k2a-1a2b3c4d"],
      ]);
    } finally {
      await close();
    }
  });

  it("派单错误按控制器给的状态码与错误码返回；其它错误走全局错误处理", async () => {
    const { controller } = fakeController();
    const { app, close } = await server(controller);
    try {
      controller.fail = new FakeDispatchError(
        "DISPATCH_TASK_NOT_READY",
        409,
        "任务已被会话 S1 领取",
        { claimedBySessionId: "S1" },
      );
      const refused = await app.inject({
        method: "POST",
        url: DISPATCH_URL,
        headers: bearer(USER),
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({
        error: {
          code: "DISPATCH_TASK_NOT_READY",
          message: "任务已被会话 S1 领取",
          retryable: false,
          details: { claimedBySessionId: "S1" },
        },
        request_id: expect.any(String),
      });

      controller.fail = new FakeDispatchError("DISPATCH_INVALID_ARGUMENT", 400, "派单配置不合法");
      const invalid = await app.inject({
        method: "PUT",
        url: "/api/v1/dispatch/config",
        headers: bearer(USER),
        payload: { maxConcurrent: 9 },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error).not.toHaveProperty("details");

      controller.fail = new AtmError("PROJECT_DB_UNAVAILABLE", { message: "库打不开" });
      const typed = await app.inject({
        method: "POST",
        url: "/api/v1/dispatch/runs/x/cancel",
        headers: bearer(USER),
      });
      expect(typed.statusCode).toBe(503);
      expect(typed.json().error).toMatchObject({ code: "PROJECT_DB_UNAVAILABLE" });

      // 不是 DISPATCH_ 前缀的「长得像」错误不会被当成派单错误透出。
      controller.fail = new FakeDispatchError("SOMETHING_ELSE", 418, "内部细节");
      const other = await app.inject({
        method: "POST",
        url: "/api/v1/dispatch/runs/x/cancel",
        headers: bearer(USER),
      });
      expect(other.statusCode).toBe(500);
      expect(other.json().error).toMatchObject({ code: "INTERNAL_ERROR" });
    } finally {
      await close();
    }
  });

  it("宿主没注入控制器：路由仍注册（权限守卫照常核对），统一 404 DISPATCH_UNAVAILABLE", async () => {
    const { app, close } = await server();
    try {
      const routes = app.atmRoutes.filter((route) => route.url.includes("dispatch"));
      expect(routes.map((route) => `${route.method} ${route.url} ${route.principal}`)).toEqual([
        "GET /api/v1/dispatch/status ANY",
        "HEAD /api/v1/dispatch/status ANY",
        "PUT /api/v1/dispatch/config USER",
        "POST /api/v1/projects/:code/ui/work-items/:taskKey/dispatch USER",
        "POST /api/v1/dispatch/runs/:run/cancel USER",
      ]);
      const status = await app.inject({
        method: "GET",
        url: "/api/v1/dispatch/status",
        headers: bearer(AGENT),
      });
      expect(status.statusCode).toBe(404);
      expect(status.json().error).toMatchObject({ code: "DISPATCH_UNAVAILABLE" });
      const refused = await app.inject({
        method: "POST",
        url: DISPATCH_URL,
        headers: bearer(AGENT),
      });
      expect(refused.statusCode).toBe(403);
      const unavailable = await app.inject({
        method: "POST",
        url: DISPATCH_URL,
        headers: bearer(USER),
      });
      expect(unavailable.statusCode).toBe(404);
      expect(unavailable.json().error).toMatchObject({ code: "DISPATCH_UNAVAILABLE" });
    } finally {
      await close();
    }
  });
});
