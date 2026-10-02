import { spawn } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configureProcessIdentityHelper,
  isDifferentProcess,
  readProcessIdentity,
} from "../src/process-identity.js";

afterEach(() => configureProcessIdentityHelper(null));

const observed = { createdAtTicks: "638000000000000000", startedAtMs: 1664403200000 };
describe("runtime owner birth identity", () => {
  it("keeps same-birth live owners and fails closed on lookup failure", () => {
    expect(isDifferentProcess(observed, observed, 0)).toBe(false);
    expect(isDifferentProcess(observed, null, 0)).toBe(false);
    expect(isDifferentProcess(undefined, null, 0)).toBe(false);
    expect(isDifferentProcess({ createdAtTicks: "corrupt" }, observed, 0)).toBe(false);
  });
  it("distinguishes PID reuse and conservatively handles legacy timestamps", () => {
    expect(isDifferentProcess({ createdAtTicks: "637000000000000000" }, observed, Date.now())).toBe(
      true,
    );
    expect(isDifferentProcess(undefined, observed, observed.startedAtMs - 10000)).toBe(true);
    expect(isDifferentProcess(undefined, observed, observed.startedAtMs + 10000)).toBe(false);
    expect(isDifferentProcess(undefined, observed, observed.startedAtMs - 1)).toBe(false);
    expect(isDifferentProcess(undefined, observed, Number.NaN)).toBe(false);
  });
  it("rejects invalid PIDs without launching a query", () => {
    for (const pid of [0, -1, NaN, Infinity, 1.5]) expect(readProcessIdentity(pid)).toBeNull();
  });
  it.runIf(process.platform === "win32")(
    "reads the real current process creation time with bounded scalar output",
    () => {
      const identity = readProcessIdentity(process.pid);
      expect(identity?.createdAtTicks).toMatch(/^\d{17,19}$/u);
      expect(identity!.startedAtMs).toBeLessThanOrEqual(Date.now());
      expect(identity!.startedAtMs).toBeGreaterThan(Date.now() - process.uptime() * 1000 - 5000);
    },
  );
  // 有宿主时问宿主（--process-identity）；宿主给不出答案就退回 PowerShell，答案与只问 PowerShell 相同。
  it.runIf(process.platform === "win32")(
    "falls back to PowerShell whenever the helper gives no answer",
    async () => {
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], {
        stdio: "ignore",
      });
      try {
        const direct = readProcessIdentity(child.pid!);
        expect(direct?.createdAtTicks).toMatch(/^\d{17,19}$/u);
        // 宿主不在、或起来了却不认这个参数（node.exe）：都退回 PowerShell，答案一样。
        configureProcessIdentityHelper(join(process.cwd(), "output", "no-such-helper.exe"));
        expect(readProcessIdentity(child.pid!)).toEqual(direct);
        configureProcessIdentityHelper(process.execPath);
        expect(readProcessIdentity(child.pid!)).toEqual(direct);
        // 进程不存在：哪条路都查不到。
        expect(readProcessIdentity(0x7ffffff0)).toBeNull();
      } finally {
        child.kill();
      }
    },
    20_000,
  );
});
