import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loginItemRestorePlan } from "../../../scripts/login-item-guard.js";

const production =
  "C:\\Users\\x\\AppData\\Local\\AyanamiTaskManager\\current\\AyanamiTaskManager.exe --background";
const smoke = "R:\\repo\\output\\packaged-smoke-data\\current\\AyanamiTaskManager.exe --background";

describe("packaged smoke must not damage the real autostart entry", () => {
  /**
   * Observed 2026-09-23: the Run value was gone while StartupApproved still listed the
   * app. The smoke's app instance toggles autostart on (overwriting the real value with
   * its isolated path) and restores "off" (deleting the value outright).
   */
  it("puts back an entry the smoke overwrote and then deleted", () => {
    expect(loginItemRestorePlan({ AyanamiTaskManager: production }, {})).toEqual([
      { action: "set", name: "AyanamiTaskManager", data: production },
    ]);
    expect(
      loginItemRestorePlan({ AyanamiTaskManager: production }, { AyanamiTaskManager: smoke }),
    ).toEqual([{ action: "set", name: "AyanamiTaskManager", data: production }]);
  });

  it("removes an entry the smoke added where the user had none", () => {
    expect(loginItemRestorePlan({}, { AyanamiTaskManager: smoke })).toEqual([
      { action: "delete", name: "AyanamiTaskManager" },
    ]);
  });

  it("does nothing when the smoke left the key as it found it", () => {
    expect(
      loginItemRestorePlan({ AyanamiTaskManager: production }, { AyanamiTaskManager: production }),
    ).toEqual([]);
    expect(loginItemRestorePlan({}, {})).toEqual([]);
  });

  it("the packaged smoke snapshots the key first and always restores it", () => {
    const smokeSource = readFileSync(join(process.cwd(), "scripts/packaged-smoke.ts"), "utf8");
    // Snapshot must be taken before the app that flips the switch is started.
    const snapshot = smokeSource.indexOf("readRunEntries()");
    expect(snapshot).toBeGreaterThan(0);
    expect(snapshot).toBeLessThan(smokeSource.indexOf("await waitForRuntime(app)"));
    // A failing smoke must still restore, so the call belongs in a finally block.
    expect(smokeSource).toMatch(
      /\}\s*finally\s*\{\s*applyRunRestore\(loginItemRestorePlan\(runEntriesBeforeSmoke, readRunEntries\(\)\)\);\s*\}/u,
    );
  });

  it("never touches another application's entries, including ones added meanwhile", () => {
    const before = { OneDrive: "C:\\OneDrive.exe /background", AyanamiTaskManager: production };
    const after = { Teams: "C:\\Teams.exe" };
    expect(loginItemRestorePlan(before, after)).toEqual([
      { action: "set", name: "AyanamiTaskManager", data: production },
    ]);
  });
});
