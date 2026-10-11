import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ATM-R-475 / W8d-3：一条命令发版在用户自己的机器上跑。3.x 起它不卸载用户的安装，按已有安装
// 的世代装上候选，运行文件、lifecycle 日志与本地更新源都从 3.0 根 N 读。
const source = readFileSync(join(process.cwd(), "scripts", "release-and-install.ts"), "utf8");

describe("release-and-install（3.x）", () => {
  it("从不卸载、不清场、不再借 distribution-smoke 的跳过开关", () => {
    expect(source).not.toMatch(/["']--uninstall["']/u);
    expect(source).not.toMatch(/clearInstallation|needsCleanRoom|stopInstalledShims/u);
    expect(source).not.toContain("ATM_DISTRIBUTION_SKIP_INSTALLED");
  });

  it("运行文件、lifecycle 日志与更新源都在 N", () => {
    expect(source).toContain('const v3Root = join(localAppData, "AyanamiTaskManager3");');
    expect(source).toContain('const runtimePath = join(v3Root, "runtime", "daemon.json");');
    expect(source).toContain('const lifecycleLog = join(v3Root, "logs", "lifecycle.ndjson");');
    expect(source).toContain("const feed = updateFeedDir(v3Root);");
    // 旧的 2.x 位置一个都不剩。
    expect(source).not.toMatch(/lifecycle-core\.ndjson|join\(dataRoot|const dataRoot/u);
    // 3.x 的 Agent HTTP 拒绝带 Sec-Fetch-* 的请求：不用全局 fetch。
    expect(source).not.toMatch(/(?<![A-Za-z])fetch\(/u);
    expect(source).toContain("await agentFetch(`${runtime.endpoint}/api/v1/system/status`");
  });

  it("按已有安装的世代走：3.x 更新、2.x 用候选 setup install、Electron install --force", () => {
    const v3 = source.indexOf('if (existing === "v3") {');
    const update = source.indexOf('join(installRoot, "atm-setup.exe"), [\n    "--update",');
    const install = source.indexOf('run(releaseFile("setup"), [\n    "install",');
    expect(v3).toBeGreaterThan(0);
    expect(update).toBeGreaterThan(v3);
    expect(install).toBeGreaterThan(update);
    expect(source).toContain('...(existing === "electron" ? ["--force"] : []),');
  });

  it("只发 3.x 的候选，判据与 install-state 的 is_v3 一致（主版本 ≥ 3），在升版本号之前拒绝", () => {
    const rust = readFileSync(
      join(process.cwd(), "apps/desktop/native/install-state/src/startup.rs"),
      "utf8",
    );
    expect(rust).toMatch(/\.split\(\['\.', '-', '\+'\]\)[\s\S]{0,200}major >= 3/u);
    expect(source).toContain("const major = Number(version.split(/[.\\-+]/u)[0]);");
    expect(source).toContain("return Number.isSafeInteger(major) && major >= 3;");
    expect(source.indexOf("TARGET_NOT_V3")).toBeLessThan(source.indexOf("bumpVersion(root"));
  });
});
