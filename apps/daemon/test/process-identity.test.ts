import { describe, expect, it } from "vitest";
import { isDifferentProcess, readProcessIdentity } from "../src/process-identity.js";

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
});
