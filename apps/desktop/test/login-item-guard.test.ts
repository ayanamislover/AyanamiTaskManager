import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loginItemRestorePlan,
  parseRunQuery,
  type RunSnapshot,
} from "../../../scripts/login-item-guard.js";

const productionExe =
  "C:\\Users\\x\\AppData\\Local\\AyanamiTaskManagerDesktop\\AyanamiTaskManager.exe";
const smokeExe = "R:\\repo\\output\\package-smoke\\app-9.9.9\\AyanamiTaskManager.exe";
const production = `"${productionExe}" --background --random-startup-delay`;
const smoke = `"${smokeExe}" --background --random-startup-delay`;
const NAME = "com.squirrel.AyanamiTaskManagerDesktop.AyanamiTaskManager";
const sz = (data: string) => ({ type: "REG_SZ", data });
const owned = { executables: [smokeExe], mayRestoreDeleted: true };

describe("smokes must not damage the real autostart entry", () => {
  /**
   * The value name is shared with the real install. The entry found missing on 2026-09-23
   * was at least partly removed by Kaspersky remediating a PDM detection, not by the smoke
   * alone (ATM-R-228); the mechanism follows from the shared value name and stands on its own.
   */
  it("puts back an entry this run overwrote, or deleted when it is a run that deletes", () => {
    expect(loginItemRestorePlan({ [NAME]: sz(production) }, { [NAME]: sz(smoke) }, owned)).toEqual([
      { action: "set", name: NAME, type: "REG_SZ", data: production },
    ]);
    expect(loginItemRestorePlan({ [NAME]: sz(production) }, {}, owned)).toEqual([
      { action: "set", name: NAME, type: "REG_SZ", data: production },
    ]);
    // A run that never switches autostart off did not delete it: the gap is not ours.
    expect(
      loginItemRestorePlan({ [NAME]: sz(production) }, {}, { ...owned, mayRestoreDeleted: false }),
    ).toEqual([]);
  });

  it("removes an entry this run added where the user had none", () => {
    expect(loginItemRestorePlan({}, { [NAME]: sz(smoke) }, owned)).toEqual([
      { action: "delete", name: NAME },
    ]);
  });

  // 烟测期间用户在真实 ATM 里改了自启：现在的值不是本轮写的，就不动它。
  it("leaves a value the user changed meanwhile", () => {
    const changed = `"${productionExe}" --background`;
    expect(
      loginItemRestorePlan({ [NAME]: sz(production) }, { [NAME]: sz(changed) }, owned),
    ).toEqual([]);
    expect(loginItemRestorePlan({}, { [NAME]: sz(production) }, owned)).toEqual([]);
  });

  it("keeps the registry type on restore", () => {
    const expand = {
      type: "REG_EXPAND_SZ",
      data: "%LOCALAPPDATA%\\AyanamiTaskManagerDesktop\\x.exe",
    };
    expect(loginItemRestorePlan({ [NAME]: expand }, { [NAME]: sz(smoke) }, owned)).toEqual([
      { action: "set", name: NAME, type: "REG_EXPAND_SZ", data: expand.data },
    ]);
    expect(
      parseRunQuery(
        `\r\nHKEY_CURRENT_USER\\...\\Run\r\n    ${NAME}    REG_EXPAND_SZ    ${expand.data}\r\n`,
      ),
    ).toEqual({ [NAME]: expand });
  });

  it("does nothing when the key is as it was", () => {
    expect(
      loginItemRestorePlan({ [NAME]: sz(production) }, { [NAME]: sz(production) }, owned),
    ).toEqual([]);
    expect(loginItemRestorePlan({}, {}, owned)).toEqual([]);
  });

  it("never touches another application's entries, including ones added meanwhile", () => {
    const before: RunSnapshot = {
      OneDrive: sz("C:\\OneDrive.exe /background"),
      [NAME]: sz(production),
    };
    const after: RunSnapshot = { Teams: sz("C:\\Teams.exe"), [NAME]: sz(smoke) };
    expect(loginItemRestorePlan(before, after, owned)).toEqual([
      { action: "set", name: NAME, type: "REG_SZ", data: production },
    ]);
  });

  it("the packaged smoke snapshots the key first and always restores its own changes", () => {
    const smokeSource = readFileSync(join(process.cwd(), "scripts/packaged-smoke.ts"), "utf8");
    // Snapshot must be taken before the app that flips the switch is started.
    const snapshot = smokeSource.indexOf("readRunSnapshot()");
    expect(snapshot).toBeGreaterThan(0);
    expect(snapshot).toBeLessThan(smokeSource.indexOf("await waitForRuntime(app)"));
    // A failing smoke must still restore, so the call belongs in a finally block.
    expect(smokeSource).toMatch(
      /\}\s*finally\s*\{\s*applyRunRestore\(\s*loginItemRestorePlan\(runEntriesBeforeSmoke, readRunSnapshot\(\), \{\s*executables: \[executable\],\s*mayRestoreDeleted: true,\s*\}\),?\s*\);\s*\}/u,
    );
    // 共享入口：快照读不到就不跑（readRunSnapshot 失败即抛），只认本轮拉起的宿主。
    const host = readFileSync(join(process.cwd(), "scripts/smoke-host.ts"), "utf8");
    expect(host).toContain("const before = readRunSnapshot();");
    expect(host).not.toContain("readRunEntries");
  });
});
