import { describe, expect, it, vi } from "vitest";
import { proxyRuntimeRequest } from "../src/runtime-request.js";

describe("renderer runtime request capability", () => {
  it("the page bridge and renderer never expose the daemon descriptor or raw token", () => {
    const desktop = join(process.cwd(), "apps", "desktop");
    const bridge = readFileSync(join(desktop, "native", "host", "src", "bridge.rs"), "utf8");
    const renderer = readFileSync(join(desktop, "src", "renderer.tsx"), "utf8");
    expect(bridge).toContain("pub const INIT_SCRIPT");
    expect(bridge).not.toMatch(/getRuntime|atm:get-runtime/u);
    expect(bridge).not.toMatch(/\bruntime\s*[:,]/u);
    expect(renderer).not.toContain("desktop?.runtime");
    expect(renderer).toContain("desktop.runtimeRequest");
  });

  it("keeps the real token in main and forwards only bounded local API requests", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await proxyRuntimeRequest(
      { endpoint: "http://127.0.0.1:9999", token: "main-only-secret" },
      {
        path: "/api/v1/system/status?compact=true",
        method: "GET",
        headers: { authorization: "Bearer renderer-fake", accept: "application/json" },
      },
      fetchImpl,
    );
    expect(result).toMatchObject({ status: 200, body: '{"ok":true}' });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:9999/api/v1/system/status?compact=true"),
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ authorization: "Bearer main-only-secret" }),
      }),
    );
  });

  it("rejects cross-origin, non-API, unsupported method and oversized body inputs", async () => {
    const runtime = { endpoint: "http://127.0.0.1:9999", token: "secret" };
    await expect(
      proxyRuntimeRequest(runtime, { path: "https://example.test/api/v1/status" }),
    ).rejects.toThrow("ATM_RENDERER_PATH_REJECTED");
    await expect(proxyRuntimeRequest(runtime, { path: "/mcp" })).rejects.toThrow(
      "ATM_RENDERER_PATH_REJECTED",
    );
    await expect(
      proxyRuntimeRequest(runtime, { path: "/api/v1/status", method: "CONNECT" }),
    ).rejects.toThrow("ATM_RENDERER_METHOD_REJECTED");
    await expect(
      proxyRuntimeRequest(runtime, { path: "/api/v1/status", body: "x".repeat(2_097_153) }),
    ).rejects.toThrow("ATM_RENDERER_BODY_TOO_LARGE");
  });
});
import { readFileSync } from "node:fs";
import { join } from "node:path";
