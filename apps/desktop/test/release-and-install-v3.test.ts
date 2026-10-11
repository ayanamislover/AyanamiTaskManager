import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isV3 } from "../../../scripts/version-sites.js";

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
    for (const version of ["3.2.1", "3.4.0-rc.1", "3.1.0+build", "10.0.0"])
      expect(isV3(version), version).toBe(true);
    for (const version of ["2.0.0", "2.99.99", "0.3.0", "", "v3.0.0", "x.y.z"])
      expect(isV3(version), version).toBe(false);
    // 判据只有 version-sites 一份：这里引用它，不再自己写一遍。
    expect(source).toMatch(/^\s+isV3,$/mu);
    expect(source).not.toMatch(/function isV3\(/u);
    expect(source).toContain("if (!isV3(target)) throw new Error(`TARGET_NOT_V3: ");
    expect(source.indexOf("TARGET_NOT_V3")).toBeLessThan(source.indexOf("bumpVersion(root"));
  });

  // release.ts 与 assemble-release 也只认 3.x：前者在跑任何阶段之前拒，后者在读任何报告之前拒。
  it("发布流水线与组装用同一个 isV3，在动手之前拒绝 2.x 的版本号", () => {
    const release = readFileSync(join(process.cwd(), "scripts", "release.ts"), "utf8");
    const assemble = readFileSync(join(process.cwd(), "scripts", "assemble-release.ts"), "utf8");
    for (const [text, first] of [
      [release, "const releaseMode = parseReleaseRunMode("],
      [assemble, 'const output = join(root, "output");'],
    ] as const) {
      expect(text).toContain('import { isV3 } from "./version-sites.js";');
      expect(text).not.toContain(".split(/[.\\-+]/u)");
      const refusal = text.search(
        /if \(!isV3\([^)]+\)\)\s+throw new Error\(`RELEASE_VERSION_NOT_V3: /u,
      );
      expect(refusal).toBeGreaterThan(0);
      expect(refusal).toBeLessThan(text.indexOf(first));
    }
  });
});
