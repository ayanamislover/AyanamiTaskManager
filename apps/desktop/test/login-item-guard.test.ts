import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loginItemRestorePlan,
  parseRunQuery,
  RUN_VALUE,
  uninstallDeletes,
  type RunSnapshot,
} from "../../../scripts/login-item-guard.js";

const productionExe =
  "C:\\Users\\x\\AppData\\Local\\AyanamiTaskManagerDesktop\\AyanamiTaskManager.exe";
const smokeExe = "R:\\repo\\output\\package-smoke\\app-9.9.9\\AyanamiTaskManager.exe";
const production = `"${productionExe}" --background --random-startup-delay`;
const smoke = `"${smokeExe}" --background --random-startup-delay`;
const NAME = "com.squirrel.AyanamiTaskManagerDesktop.AyanamiTaskManager";
const sz = (data: string) => ({ type: "REG_SZ", data });
const owned = { executables: [smokeExe], deleted: [NAME] };

describe("smokes must not damage the real autostart entry", () => {
  /**
   * The value name is shared with the real install. The entry found missing on 2026-09-23
   * was at least partly removed by Kaspersky remediating a PDM detection, not by the smoke
   * alone (ATM-R-228); the mechanism follows from the shared value name and stands on its own.
   */
  it("puts back an entry this run overwrote, or the very name this run deleted", () => {
    expect(loginItemRestorePlan({ [NAME]: sz(production) }, { [NAME]: sz(smoke) }, owned)).toEqual([
      { action: "set", name: NAME, type: "REG_SZ", data: production },
    ]);
    expect(loginItemRestorePlan({ [NAME]: sz(production) }, {}, owned)).toEqual([
      { action: "set", name: NAME, type: "REG_SZ", data: production },
    ]);
    // Not yet at the step that deletes (an earlier check failed), or the user switched
    // autostart off meanwhile: the gap is not ours.
    expect(loginItemRestorePlan({ [NAME]: sz(production) }, {}, { ...owned, deleted: [] })).toEqual(
      [],
    );
    // Deleting one name does not license bringing back another ATM entry someone removed.
    const other = "AyanamiTaskManager-legacy";
    expect(
      loginItemRestorePlan({ [NAME]: sz(production), [other]: sz(production) }, {}, owned),
    ).toEqual([{ action: "set", name: NAME, type: "REG_SZ", data: production }]);
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
    // Snapshot before anything is started: a failed query starts nothing.
    const snapshot = smokeSource.indexOf("const runEntriesBeforeSmoke = readRunSnapshot();");
    expect(snapshot).toBeGreaterThan(0);
    expect(snapshot).toBeLessThan(smokeSource.indexOf("let app = startApp();"));
    // A deletion is ours only from the step that deletes, and is undone right there.
    const push = smokeSource.indexOf("runDeletedBySmoke.push(AUTOSTART_VALUE);");
    expect(push).toBeGreaterThan(0);
    expect(push).toBeLessThan(smokeSource.indexOf('desktopCall("setAutoLaunch", false)'));
    expect(smokeSource).toContain("deleted: runDeletedBySmoke.splice(0),");
    // A failing smoke must still restore, so the call belongs in a finally block.
    expect(smokeSource).toMatch(
      /\}\s*finally\s*\{\s*applyRunRestore\(\s*loginItemRestorePlan\(runEntriesBeforeSmoke, readRunSnapshot\(\), \{\s*executables: \[executable\],\s*deleted: runDeletedBySmoke,\s*\}\),?\s*\);\s*\}/u,
    );
    // 共享入口：快照读不到就不跑（readRunSnapshot 失败即抛），只认本轮拉起的宿主。
    const host = readFileSync(join(process.cwd(), "scripts/smoke-host.ts"), "utf8");
    expect(host).toContain("const before = readRunSnapshot();");
    expect(host).not.toContain("readRunEntries");
  });

  // 卸载期间别人删掉的名称不归本轮：只认卸载器删的固定名称，且它指向本轮安装根的启动器。
  it("distribution-smoke counts as its own deletion only the value its install wrote", () => {
    expect(RUN_VALUE).toBe(NAME);
    const installRoot = "C:\\sandbox\\Local\\AyanamiTaskManagerDesktop\\";
    const ours = sz(
      `"C:\\sandbox\\Local\\AyanamiTaskManagerDesktop\\AyanamiTaskManager.exe" --background`,
    );
    expect(uninstallDeletes({ [NAME]: ours }, installRoot)).toEqual([NAME]);
    // 指向别处（用户真实安装、便携版）、或根本没有：不归本轮。
    expect(uninstallDeletes({ [NAME]: sz(production) }, installRoot)).toEqual([]);
    expect(uninstallDeletes({}, installRoot)).toEqual([]);
    // 同属本应用的其他名称即便指向本轮安装根，卸载器也不删它：不列入。
    expect(
      uninstallDeletes({ [NAME]: ours, "AyanamiTaskManager-legacy": ours }, installRoot),
    ).toEqual([NAME]);
    // 调用方在卸载前就定下名单（中途失败也覆盖），不再拿卸载前后的快照差集。
    const source = readFileSync(join(process.cwd(), "scripts/distribution-smoke.ts"), "utf8");
    const decided = source.indexOf(
      "runDeletedByUninstall = uninstallDeletes(readRunSnapshot(), installRoot);",
    );
    expect(decided).toBeGreaterThan(0);
    expect(decided).toBeLessThan(source.indexOf('"--uninstall"'));
    expect(source).not.toMatch(/Object\.keys\(runBefore/u);
  });
});
