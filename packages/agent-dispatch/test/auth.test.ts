import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAUDE_AUTH_CACHE_MS,
  CLAUDE_LOGIN_REQUIRED_MESSAGE,
  DispatchError,
} from "../src/index.js";
import { cleanupAll, type Fixture, fixture, waitFor } from "./support.js";

afterEach(cleanupAll);

/** 假 claude 的 `auth status` 由这个文件控制，每探一次在 <文件>.count 里记一行。 */
function authControl(f: Fixture) {
  const file = join(f.root, "auth.json");
  return {
    env: { ...process.env, FAKE_CLAUDE_AUTH_FILE: file },
    set(mode: "in" | "out" | "hang" | "garbage") {
      writeFileSync(file, JSON.stringify({ mode }));
    },
    probes() {
      if (!existsSync(`${file}.count`)) return 0;
      return readFileSync(`${file}.count`, "utf8").split("\n").filter(Boolean).length;
    },
  };
}

function clock() {
  let at = Date.parse("2026-09-30T12:00:00Z");
  return {
    now: () => new Date(at),
    advance(ms: number) {
      at += ms;
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<DispatchError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DispatchError);
  return error as DispatchError;
}

describe("claude 登录状态", () => {
  it("status 带 loggedIn/authMethod，结果缓存 5 分钟", async () => {
    const f = fixture();
    const auth = authControl(f);
    const time = clock();
    auth.set("in");
    const dispatcher = f.dispatcher({ baseEnv: auth.env, now: time.now });
    expect((await dispatcher.status()).claude).toMatchObject({
      found: true,
      loggedIn: true,
      authMethod: "claude.ai",
    });
    expect(auth.probes()).toBe(1);
    await dispatcher.status();
    time.advance(CLAUDE_AUTH_CACHE_MS - 1_000);
    await dispatcher.status();
    expect(auth.probes()).toBe(1);

    auth.set("out");
    time.advance(2_000);
    expect((await dispatcher.status()).claude).toMatchObject({
      loggedIn: false,
      authMethod: "none",
    });
    expect(auth.probes()).toBe(2);
  });

  it("缓存说未登录时，派单前强制重探：刚在终端登录的用户可以直接派单", async () => {
    const f = fixture();
    f.addTask("DEMO-T-0001");
    const auth = authControl(f);
    auth.set("out");
    const dispatcher = f.dispatcher({ baseEnv: auth.env });
    await dispatcher.updateConfig({ enabled: true });
    expect((await dispatcher.status()).claude.loggedIn).toBe(false);
    auth.set("in");
    const queued = await dispatcher.enqueue({
      project: "DEMO",
      key: "DEMO-T-0001",
      origin: "mobile",
    });
    expect(queued.state).toBe("queued");
    expect(auth.probes()).toBe(2);
    expect((await dispatcher.status()).claude.loggedIn).toBe(true);
    expect(auth.probes()).toBe(2);
  });

  it("重探后仍未登录：拒绝 DISPATCH_CLAUDE_NOT_LOGGED_IN，不排队；没有缓存时只探一次", async () => {
    const f = fixture();
    f.addTask("DEMO-T-0001");
    const auth = authControl(f);
    auth.set("out");
    const cached = f.dispatcher({ baseEnv: auth.env });
    await cached.updateConfig({ enabled: true });
    await cached.status();
    const refused = await rejection(
      cached.enqueue({ project: "DEMO", key: "DEMO-T-0001", origin: "mobile" }),
    );
    expect(refused).toMatchObject({
      code: "DISPATCH_CLAUDE_NOT_LOGGED_IN",
      message: CLAUDE_LOGIN_REQUIRED_MESSAGE,
      httpStatus: 503,
      details: { authMethod: "none" },
    });
    expect(auth.probes()).toBe(2);
    expect(cached.listRuns()).toEqual([]);

    const cold = f.dispatcher({ baseEnv: auth.env });
    expect(
      (await rejection(cold.enqueue({ project: "DEMO", key: "DEMO-T-0001", origin: "desktop" })))
        .code,
    ).toBe("DISPATCH_CLAUDE_NOT_LOGGED_IN");
    expect(auth.probes()).toBe(3);
  });

  it("探不出来（超时、输出看不懂）：loggedIn 为 null，不挡派单", async () => {
    const f = fixture();
    f.addTask("DEMO-T-0001");
    f.addTask("DEMO-T-0002");
    f.behave("slow", 60_000);
    const auth = authControl(f);
    auth.set("hang");
    const hanging = f.dispatcher({ baseEnv: auth.env, authProbeTimeoutMs: 300 });
    await hanging.updateConfig({ enabled: true, maxConcurrent: 2 });
    const status = await hanging.status();
    expect(status.claude.loggedIn).toBeNull();
    expect(status.claude).not.toHaveProperty("authMethod");
    expect(
      (await hanging.enqueue({ project: "DEMO", key: "DEMO-T-0001", origin: "desktop" })).state,
    ).toBe("queued");

    auth.set("garbage");
    const confused = f.dispatcher({ baseEnv: auth.env });
    expect((await confused.status()).claude.loggedIn).toBeNull();
    expect(
      (await confused.enqueue({ project: "DEMO", key: "DEMO-T-0002", origin: "desktop" })).state,
    ).toBe("queued");
  });

  it("会话因鉴权失败结束：run.error 是中文提示，登录缓存失效、下次状态重新探", async () => {
    const f = fixture();
    f.addTask("DEMO-T-0001");
    f.behave("auth-stderr");
    const auth = authControl(f);
    auth.set("in");
    const dispatcher = f.dispatcher({ baseEnv: auth.env });
    await dispatcher.updateConfig({ enabled: true });
    await dispatcher.enqueue({ project: "DEMO", key: "DEMO-T-0001", origin: "mobile" });
    expect(auth.probes()).toBe(1);
    const failed = await waitFor(() => {
      const run = dispatcher.runForTask("DEMO", "DEMO-T-0001");
      return run?.state === "failed" ? run : null;
    });
    expect(failed.error).toBe(CLAUDE_LOGIN_REQUIRED_MESSAGE);
    expect(failed.summary?.result).toBe("Invalid API key · Please run /login");
    auth.set("out");
    expect((await dispatcher.status()).claude.loggedIn).toBe(false);
    expect(auth.probes()).toBe(2);
  });

  it("与登录无关的失败保持原文（stderr 里的 MCP OAuth 提示不算）", async () => {
    const f = fixture();
    f.addTask("DEMO-T-0001");
    f.behave("api-error");
    const dispatcher = f.dispatcher();
    await dispatcher.updateConfig({ enabled: true });
    await dispatcher.enqueue({ project: "DEMO", key: "DEMO-T-0001", origin: "desktop" });
    const failed = await waitFor(() => {
      const run = dispatcher.runForTask("DEMO", "DEMO-T-0001");
      return run?.state === "failed" ? run : null;
    });
    expect(failed.error).toBe("API Error: 529 overloaded_error");
  });
});
