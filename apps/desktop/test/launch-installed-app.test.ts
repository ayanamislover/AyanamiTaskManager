import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { launchThroughShell } from "../../../scripts/launch-installed-app.js";

const stub = "C:\\Users\\x\\AppData\\Local\\AyanamiTaskManagerDesktop\\AyanamiTaskManager.exe";

describe("正式版经桌面 shell 启动", () => {
  it("交给 explorer.exe，只带启动桩路径；explorer 成功时的退出码 1 不算失败", () => {
    const run = vi.fn().mockReturnValue({ status: 1, error: undefined });
    expect(() => launchThroughShell(stub, run)).not.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("explorer.exe", [stub], { windowsHide: true });
  });

  it("explorer 本身起不来时大声失败", () => {
    const run = vi.fn().mockReturnValue({ status: null, error: new Error("spawn ENOENT") });
    expect(() => launchThroughShell(stub, run)).toThrow(/SHELL_LAUNCH_FAILED: spawn ENOENT/u);
  });

  // 直接拉起的正式版留在 Agent 宿主的 Job 里、随宿主结束，还带着宿主的环境变量；
  // 只有 explorer 拉不起来时才允许回落，并且必须提示用户从开始菜单重启。
  it("release-and-install 首选 explorer，直接拉起只在没等到运行实例时回落", () => {
    const source = readFileSync("scripts/release-and-install.ts", "utf8");
    expect(source).not.toMatch(/\bspawn\(/u);
    expect(source).toMatch(
      /launchThroughShell\(installedLauncher\);\s*let status = await waitForStatus\(\d+\);\s*if \(!status\) \{/u,
    );
    const fallback = source.indexOf("launchDirect(installedLauncher)");
    expect(fallback).toBeGreaterThan(source.indexOf("if (!status) {"));
    expect(source.slice(source.indexOf("if (!status) {"), fallback)).toContain("从开始菜单启动");
    // 被 Agent 的桥抢先唤醒的实例同样在宿主里，验收时要认出来。
    expect(source).toContain("lastStartup?.agentWake === true");
  });
});
