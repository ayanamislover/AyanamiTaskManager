import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findRunEntry,
  loginItemRestorePlan,
  RUN_VALUE,
  type RunSnapshot,
} from "../../../scripts/login-item-guard.js";
import { parseRegistryJson } from "../../../scripts/windows-text.js";

/** readRunSnapshot 读到的形状：windows-text.ts 的注册表脚本输出。 */
const runKey = (
  values: Record<string, { type: string; code: number; data: string; raw: string }>,
) => parseRegistryJson(JSON.stringify(values));
/** 字符串值的原始字节：UTF-16LE，带结尾的 NUL（多字符串的文字自己再带一个）。 */
const utf16 = (text: string) => Buffer.from(`${text}\0`, "utf16le").toString("hex").toUpperCase();

const productionExe =
  "C:\\Users\\x\\AppData\\Local\\AyanamiTaskManagerDesktop\\AyanamiTaskManager.exe";
const smokeExe = "R:\\repo\\output\\package-smoke\\app-9.9.9\\AyanamiTaskManager.exe";
const production = `"${productionExe}" --background --random-startup-delay`;
const smoke = `"${smokeExe}" --background --random-startup-delay`;
const NAME = "com.squirrel.AyanamiTaskManagerDesktop.AyanamiTaskManager";
const sz = (data: string) => ({ type: "REG_SZ", code: 1, data, raw: utf16(data) });
const owned = { executables: [smokeExe], deleted: [NAME] };

describe("smokes must not damage the real autostart entry", () => {
  /**
   * The value name is shared with the real install. The entry found missing on 2026-09-23
   * was at least partly removed by Kaspersky remediating a PDM detection, not by the smoke
   * alone (ATM-R-228); the mechanism follows from the shared value name and stands on its own.
   */
  it("puts back an entry this run overwrote, or the very name this run deleted", () => {
    expect(loginItemRestorePlan({ [NAME]: sz(production) }, { [NAME]: sz(smoke) }, owned)).toEqual([
      { action: "set", name: NAME, value: sz(production) },
    ]);
    expect(loginItemRestorePlan({ [NAME]: sz(production) }, {}, owned)).toEqual([
      { action: "set", name: NAME, value: sz(production) },
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
    ).toEqual([{ action: "set", name: NAME, value: sz(production) }]);
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

  // peer r18 P2-01：还原照快照的类型码与原始字节写回，不经 reg.exe 的文字（多字符串的文字不是一一对应的）。
  it("restores the type code and bytes as snapshotted, not their text", () => {
    // 两个不同的多字符串：一个元素里有字面的「\0」，一个是两个元素。reg.exe 的写法下它们是同一串文字。
    const text = `${smokeExe}\\0x`;
    const literal = { type: "REG_MULTI_SZ", code: 7, data: text, raw: utf16(`${smokeExe}\\0x\0`) };
    const split = { type: "REG_MULTI_SZ", code: 7, data: text, raw: utf16(`${smokeExe}\0x\0`) };
    expect(literal.raw).not.toBe(split.raw);
    expect(loginItemRestorePlan({ [NAME]: literal }, { [NAME]: split }, owned)).toEqual([
      { action: "set", name: NAME, value: literal },
    ]);
    // 默认值（空名字）也照样写回。
    expect(loginItemRestorePlan({ "": sz(production) }, { "": sz(smoke) }, owned)).toEqual([
      { action: "set", name: "", value: sz(production) },
    ]);
    const source = readFileSync(join(process.cwd(), "scripts/login-item-guard.ts"), "utf8");
    expect(source).not.toMatch(/reg\.exe"|execFileSync/u);
    expect(source).toContain("registrySet(RUN_KEY, step.name, step.value)");
    expect(source).toContain("registryDelete(RUN_KEY, step.name)");
  });

  it("keeps the registry type on restore", () => {
    const data = "%LOCALAPPDATA%\\AyanamiTaskManagerDesktop\\x.exe";
    const expand = { type: "REG_EXPAND_SZ", code: 2, data, raw: utf16(data) };
    expect(loginItemRestorePlan({ [NAME]: expand }, { [NAME]: sz(smoke) }, owned)).toEqual([
      { action: "set", name: NAME, value: expand },
    ]);
    expect(runKey({ [NAME]: expand })).toEqual({ [NAME]: expand });
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
      { action: "set", name: NAME, value: sz(production) },
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

  // 分发烟测的安装验收不碰已有的同名自启：验收前有这个值就不做（和同名安装同一口径），
  // 于是收尾只删本轮新加的、从不放回或复活什么。
  it("distribution-smoke installs only where the shared Run value is absent, and never restores one", () => {
    expect(RUN_VALUE).toBe(NAME);
    const source = readFileSync(join(process.cwd(), "scripts/distribution-installed.ts"), "utf8");
    const precondition = "findRunEntry(runBefore, RUN_VALUE) !== undefined && `Run ${RUN_VALUE}`,";
    expect(source).toContain(precondition);
    expect(source).not.toMatch(/RUN_VALUE in |\[RUN_VALUE\]/u);
    expect(source.indexOf(precondition)).toBeLessThan(source.indexOf('run(setup, ["install"'));
    expect(source).toMatch(/deleted: \[\],/u);
    expect(source).not.toContain("uninstallDeletes");
    // 值本不存在时，计划只会删本轮安装写下的那一条。
    const ours = sz(`"${smokeExe}" --background`);
    expect(loginItemRestorePlan({}, { [NAME]: ours }, { ...owned, deleted: [] })).toEqual([
      { action: "delete", name: NAME },
    ]);
  });

  // 注册表的值名不区分大小写（Codex R7-P2-2）：便携版或管理脚本写下的同名值大小写不同，
  // 也是同一个值。安装会改写它、卸载会删它。
  it("treats value names that differ only in case as the same value", () => {
    const upper = NAME.toUpperCase();
    const snapshot = runKey({ [upper]: sz(production) });
    expect(findRunEntry(snapshot, RUN_VALUE)).toEqual(sz(production));
    expect(findRunEntry(snapshot, "SomethingElse")).toBeUndefined();
    // 本轮把同一个值改写成了自己的：放回用户原来的，而不是当成本轮新加的删掉。
    expect(loginItemRestorePlan({ [upper]: sz(production) }, { [NAME]: sz(smoke) }, owned)).toEqual(
      [{ action: "set", name: upper, value: sz(production) }],
    );
    // 本轮删的名字与快照里的大小写不同，仍是同一个值。
    expect(loginItemRestorePlan({ [upper]: sz(production) }, {}, owned)).toEqual([
      { action: "set", name: upper, value: sz(production) },
    ]);
    // 没变就什么都不做。
    expect(
      loginItemRestorePlan({ [upper]: sz(production) }, { [NAME]: sz(production) }, owned),
    ).toEqual([]);
  });
});
