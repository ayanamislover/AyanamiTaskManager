import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverDaemon, wakeBridgePath } from "../src/runtime.js";

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
      version: "9.9.9",
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
      version: "9.9.9",
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

  it("wakes through the bridge shipped with this executable, not the data-root copy", () => {
    // The data root is refreshed only when the desktop starts; after an update it can
    // still hold an old bridge whose stdio loop runs as soon as it is required.
    const exe =
      "C:\\Users\\x\\AppData\\Local\\AyanamiTaskManagerDesktop\\app-9.9.9\\AyanamiTaskManager.exe";
    expect(wakeBridgePath(exe)).toBe(
      join(
        "C:\\Users\\x\\AppData\\Local\\AyanamiTaskManagerDesktop\\app-9.9.9",
        "resources",
        "mcp-stdio.cjs",
      ),
    );
    expect(wakeBridgePath(exe, "D:\\packaged\\resources")).toBe(
      join("D:\\packaged\\resources", "mcp-stdio.cjs"),
    );
    const source = readFileSync(join(process.cwd(), "packages/cli/src/runtime.ts"), "utf8");
    expect(source).not.toMatch(/join\(\s*dataDir\s*,\s*"mcp-stdio\.cjs"\s*\)/u);
  });

  it("rejects a non-loopback explicit override before any request", async () => {
    await expect(
      discoverDaemon({ endpoint: "https://example.test", token: "must-not-leak" }),
    ).rejects.toThrow("ATM_RUNTIME_ENDPOINT_INVALID");
  });
});
