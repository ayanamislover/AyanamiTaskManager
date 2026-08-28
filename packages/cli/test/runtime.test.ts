import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverDaemon } from "../src/runtime.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function writeRuntime(dataDir: string, endpoint: string, token: string): void {
  const runtimeDir = join(dataDir, "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(
    join(runtimeDir, "daemon.json"),
    JSON.stringify({
      endpoint,
      token,
      pid: process.pid,
      instanceId: "0123456789abcdef0123456789abcdef",
      version: "1.0.18",
      startedAt: "2026-08-28T12:00:00.000Z",
    }),
    "utf8",
  );
}

describe("CLI daemon discovery", () => {
  it("returns the canonical descriptor only after the authenticated daemon responds", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-cli-runtime-"));
    temporary.push(dataDir);
    const server = createServer((request, response) => {
      expect(request.headers.authorization).toBe("Bearer healthy-token");
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TEST_ADDRESS_MISSING");
    const endpoint = `http://127.0.0.1:${address.port}`;
    writeRuntime(dataDir, endpoint, "healthy-token");

    await expect(discoverDaemon({ dataDir })).resolves.toEqual({
      endpoint,
      token: "healthy-token",
      pid: process.pid,
      instanceId: "0123456789abcdef0123456789abcdef",
      version: "1.0.18",
      startedAt: "2026-08-28T12:00:00.000Z",
    });
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });

  it("rejects stale and non-loopback descriptors instead of returning their secrets", async () => {
    for (const [endpoint, token] of [
      ["http://127.0.0.1:1", "stale-secret"],
      ["https://example.test", "remote-secret"],
    ] as const) {
      const dataDir = mkdtempSync(join(tmpdir(), "atm-cli-invalid-runtime-"));
      temporary.push(dataDir);
      writeRuntime(dataDir, endpoint, token);
      let message = "";
      try {
        await discoverDaemon({ dataDir, waitMs: 1 });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("AyanamiTaskManager 服务未运行");
      expect(message).not.toContain(token);
      expect(message).not.toContain(endpoint);
    }
  });

  it("rejects a non-loopback explicit override before any request", async () => {
    await expect(
      discoverDaemon({ endpoint: "https://example.test", token: "must-not-leak" }),
    ).rejects.toThrow("ATM_RUNTIME_ENDPOINT_INVALID");
  });
});
