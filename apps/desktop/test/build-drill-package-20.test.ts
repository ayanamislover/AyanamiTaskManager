import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertUnderOutput,
  package20Files,
  package20Ready,
  RELEASE_20_COMMIT,
} from "../../../scripts/build-drill-package-20.js";
import { LEGACY_VERSION } from "../../../scripts/version-sites.js";

// install-drill 的 2.x ⇄ 3.0 场景要 2.0 时代的 drill 包；CI 是干净的检出，没有它，release 的
// install-drill 阶段就会因为缺包而红——所以它由脚本从 2.0.0 的提交打出来，并且排在 release 之前。
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(process.cwd(), "output", "drill-package-20-test-"));
  temporary.push(dir);
  return dir;
}

describe("2.0 演练包", () => {
  it("三个文件齐、清单的版本就是 2.0 的号才算现成的", () => {
    const dir = scratch();
    expect(package20Files()).toEqual([
      "atm-setup.exe",
      `atm-${LEGACY_VERSION}-win-x64.json`,
      `atm-${LEGACY_VERSION}-win-x64.zip`,
    ]);
    expect(package20Ready(dir)).toBe(false);
    for (const name of package20Files()) writeFileSync(join(dir, name), "x");
    // 清单坏了不算。
    expect(package20Ready(dir)).toBe(false);
    const manifest = join(dir, `atm-${LEGACY_VERSION}-win-x64.json`);
    writeFileSync(manifest, JSON.stringify({ version: "9.0.0" }));
    expect(package20Ready(dir)).toBe(false);
    writeFileSync(manifest, JSON.stringify({ version: LEGACY_VERSION }));
    expect(package20Ready(dir)).toBe(true);
    rmSync(join(dir, "atm-setup.exe"));
    expect(package20Ready(dir)).toBe(false);
  });

  it("包和临时检出只落在本仓库的 output/ 下", () => {
    const root = process.cwd();
    expect(assertUnderOutput(root, "output/drill/package-x")).toBe(
      join(root, "output", "drill", "package-x"),
    );
    for (const outside of ["output", "release/drill", "../output/drill", join(root, "..", "x")])
      expect(() => assertUnderOutput(root, outside), outside).toThrow(
        /DRILL_PACKAGE_OUTSIDE_OUTPUT/u,
      );
  });

  it("从固定的 2.0.0 提交打，临时检出用完即摘", () => {
    expect(RELEASE_20_COMMIT).toMatch(/^[0-9a-f]{40}$/u);
    const source = readFileSync("scripts/build-drill-package-20.ts", "utf8");
    expect(source).toContain(
      'run("git", ["worktree", "add", "--detach", source, RELEASE_20_COMMIT], root);',
    );
    expect(source).toMatch(/\} finally \{\s+removeSource\(root, source\);\s+\}/u);
    // 装工具链不许顺带自更新 rustup（改调用者的机器；替换 rustup.exe 时再调它会 EBUSY）。
    const rustup = source.match(/run\(\s*"rustup",\s*\[[^\]]*\]/gu) ?? [];
    expect(rustup).toHaveLength(2);
    for (const call of rustup) expect(call).toContain('"--no-self-update"');
    // 只用 drill setup 的那份构建：生产 2.0 的 setup 没有沙箱。
    expect(source).toContain('"scripts/package-native.ts", "--drill", built]');
  });

  it("CI 在 release 之前打好它", () => {
    const workflow = readFileSync(".github/workflows/windows-release-validation.yml", "utf8");
    const build = workflow.indexOf("run: pnpm exec tsx scripts/build-drill-package-20.ts");
    expect(build).toBeGreaterThan(0);
    expect(build).toBeLessThan(workflow.indexOf("run: pnpm release --full"));
  });
});

describe("2.0 演练包在本机", () => {
  it("install-drill 读的就是这个脚本写的位置", () => {
    const drill = readFileSync("scripts/install-drill.ts", "utf8");
    expect(drill).toContain('setup: join(drillRoot, "package-2.0.0", "atm-setup.exe"),');
    expect(drill).toContain("scripts/build-drill-package-20.ts");
    expect(join("output", "drill", `package-${LEGACY_VERSION}`)).toBe(
      join("output", "drill", "package-2.0.0"),
    );
  });
});
