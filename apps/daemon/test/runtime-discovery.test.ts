import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireDaemonRuntime,
  createDaemonToken,
  DAEMON_VERSION,
  readDaemonRuntime,
  resolveDaemonDataDirectory,
  type DaemonRuntimeDescriptor,
} from "../src/index.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(token: string, pid = 4321): DaemonRuntimeDescriptor {
  return {
    endpoint: "http://127.0.0.1:9999",
    token,
    pid,
    instanceId: "0123456789abcdef0123456789abcdef",
    version: DAEMON_VERSION,
    startedAt: "2026-08-28T12:00:00.000Z",
  };
}

describe("single-source daemon runtime discovery", () => {
  it("publishes daemon.json atomically and removes the legacy token only after success", () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "atm-runtime-source-"));
    temporary.push(runtimeDir);
    writeFileSync(join(runtimeDir, "local.token"), "legacy-secret", "utf8");
    const lease = acquireDaemonRuntime(runtimeDir, process.pid);

    lease.publish({
      ...fixture("first-secret", process.pid),
      instanceId: lease.instanceId,
    });
    expect(readDaemonRuntime(runtimeDir)).toMatchObject({
      ...fixture("first-secret", process.pid),
      instanceId: lease.instanceId,
    });
    expect(existsSync(join(runtimeDir, "local.token"))).toBe(false);

    lease.publish({
      ...fixture("second-secret", process.pid),
      instanceId: lease.instanceId,
    });
    expect(readDaemonRuntime(runtimeDir).token).toBe("second-secret");
    expect(readdirSync(runtimeDir).sort()).toEqual(["daemon.json", "daemon.lock"]);
    expect(readFileSync(join(runtimeDir, "daemon.json"), "utf8")).not.toContain("legacy-secret");
    lease.clear();
    lease.release();
  });

  it("rejects non-loopback or malformed descriptors without echoing token or path", () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "atm-runtime-invalid-"));
    temporary.push(runtimeDir);
    writeFileSync(
      join(runtimeDir, "daemon.json"),
      JSON.stringify({ ...fixture("must-not-leak"), endpoint: "https://example.test" }),
      "utf8",
    );
    let message = "";
    try {
      readDaemonRuntime(runtimeDir);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("ATM_RUNTIME_UNAVAILABLE");
    expect(message).not.toContain("must-not-leak");
    expect(message).not.toContain(runtimeDir);
  });

  it("uses an explicit development token or creates a fresh bounded token", () => {
    expect(createDaemonToken({ AYANAMI_TASK_TOKEN: " configured " })).toBe("configured");
    const generated = createDaemonToken({});
    expect(generated).toMatch(/^[A-Za-z0-9_-]{40,64}$/u);
  });

  it("uses ATM_DATA_DIR canonically while retaining the legacy alias only as fallback", () => {
    expect(
      resolveDaemonDataDirectory({
        ATM_DATA_DIR: "C:\\canonical-atm",
        AYANAMI_TASK_DATA_DIR: "C:\\legacy-atm",
      }),
    ).toBe("C:\\canonical-atm");
    expect(resolveDaemonDataDirectory({ AYANAMI_TASK_DATA_DIR: "C:\\legacy-atm" })).toBe(
      "C:\\legacy-atm",
    );
  });

  it("allows exactly one runtime owner and safely reclaims a malformed stale lock", () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "atm-runtime-lock-"));
    temporary.push(runtimeDir);
    const first = acquireDaemonRuntime(runtimeDir, process.pid);
    expect(() => acquireDaemonRuntime(runtimeDir, process.pid)).toThrow(
      "ATM_RUNTIME_ALREADY_ACTIVE",
    );
    first.release();

    writeFileSync(join(runtimeDir, "daemon.lock"), "not-json", "utf8");
    const recovered = acquireDaemonRuntime(runtimeDir, process.pid);
    expect(readdirSync(runtimeDir).filter((name) => name.includes("stale"))).toEqual([]);
    recovered.release();
    expect(existsSync(join(runtimeDir, "daemon.lock"))).toBe(false);
  });

  it("a released lease cannot clear the descriptor protected by its successor", () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "atm-runtime-owner-"));
    temporary.push(runtimeDir);
    const first = acquireDaemonRuntime(runtimeDir, process.pid);
    first.publish({ ...fixture("owned", process.pid), instanceId: first.instanceId });
    first.release();
    const successor = acquireDaemonRuntime(runtimeDir, process.pid);
    expect(() => first.clear()).toThrow("ATM_RUNTIME_LEASE_LOST");
    expect(readDaemonRuntime(runtimeDir).token).toBe("owned");
    successor.clear();
    successor.release();
    expect(existsSync(join(runtimeDir, "daemon.json"))).toBe(false);
  });

  it("does not accept an empty runtime directory", () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "atm-runtime-empty-"));
    temporary.push(runtimeDir);
    mkdirSync(runtimeDir, { recursive: true });
    expect(() => readDaemonRuntime(runtimeDir)).toThrow("ATM_RUNTIME_UNAVAILABLE");
  });
});
