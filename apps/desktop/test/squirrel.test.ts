import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleSquirrelStartup } from "../src/squirrel.js";
import { updateFeedDir, updateFeedReady } from "../src/updater.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const execPath = "C:\\Users\\x\\AppData\\Local\\AyanamiTaskManagerDesktop\\app-1.0.6\\ATM.exe";
const updateExe = "C:\\Users\\x\\AppData\\Local\\AyanamiTaskManagerDesktop\\Update.exe";

function capture() {
  const calls: Array<{ exe: string; args: string[] }> = [];
  return {
    calls,
    run: (exe: string, args: string[]) => {
      calls.push({ exe, args });
    },
  };
}

describe("Squirrel 生命周期事件", () => {
  // Electron 应用带 Squirrel-aware 标记，Squirrel 因此把创建快捷方式的责任交给
  // 应用。应用不接管，两边就都不做——1.0.5 装完开始菜单里什么都没有。
  it("安装与更新时建快捷方式，卸载时删", () => {
    for (const event of ["--squirrel-install", "--squirrel-updated"]) {
      const { calls, run } = capture();
      expect(handleSquirrelStartup([execPath, event, "1.0.6"], execPath, run)).toBe(true);
      expect(calls).toEqual([{ exe: updateExe, args: ["--createShortcut", "ATM.exe"] }]);
    }
    const removal = capture();
    expect(
      handleSquirrelStartup([execPath, "--squirrel-uninstall", "1.0.6"], execPath, removal.run),
    ).toBe(true);
    expect(removal.calls).toEqual([{ exe: updateExe, args: ["--removeShortcut", "ATM.exe"] }]);
  });

  it("obsolete 安静退出，不动快捷方式", () => {
    const { calls, run } = capture();
    expect(handleSquirrelStartup([execPath, "--squirrel-obsolete", "1.0.5"], execPath, run)).toBe(
      true,
    );
    expect(calls).toEqual([]);
  });

  // 装完之后用户第一次点图标，Squirrel 会带上 --squirrel-firstrun。把它当成
  // 生命周期事件一起退掉，表现就是「装完点图标没反应」。
  it("firstrun 必须正常启动，不能被当成生命周期事件退掉", () => {
    const { calls, run } = capture();
    expect(handleSquirrelStartup([execPath, "--squirrel-firstrun"], execPath, run)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("普通启动参数不受影响", () => {
    const { calls, run } = capture();
    expect(handleSquirrelStartup([execPath], execPath, run)).toBe(false);
    expect(handleSquirrelStartup([execPath, "--background"], execPath, run)).toBe(false);
    expect(handleSquirrelStartup([execPath, "--mcp-stdio"], execPath, run)).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("本地目录更新源", () => {
  it("没有 RELEASES 就是没有更新源，必须安静地什么都不做", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-feed-"));
    temporary.push(dataDir);
    expect(updateFeedDir(dataDir)).toBe(join(dataDir, "updates"));
    // 还没发过任何更新是正常状态：指向不存在的源会抛错，不能让它变成用户面前的报错。
    expect(updateFeedReady(dataDir)).toBe(false);
  });

  it("投递了 RELEASES 之后才算就绪", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-feed-ready-"));
    temporary.push(dataDir);
    const feed = updateFeedDir(dataDir);
    mkdirSync(feed, { recursive: true });
    // 目录在、RELEASES 不在，仍然不算就绪——半截的 feed 会让 autoUpdater 抛错。
    expect(updateFeedReady(dataDir)).toBe(false);
    writeFileSync(
      join(feed, "RELEASES"),
      "0000 AyanamiTaskManagerDesktop-1.0.6-full.nupkg 123",
      "utf8",
    );
    expect(updateFeedReady(dataDir)).toBe(true);
  });
});
