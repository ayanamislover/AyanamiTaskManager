import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STAGE_INPUTS } from "../../../scripts/release-fingerprint.js";

// W8 关口在 CI 上：e2e 的服务要从零编译时（新机器、冷缓存），编译算进 Playwright webServer 的 120 s，
// 就超时了。编译放在 Playwright 之前单独跑（scripts/build-e2e.ts），webServer 只等服务起来。
const root = process.cwd();

function e2eScript(packageJson: string): string {
  return (JSON.parse(packageJson) as { scripts: Record<string, string> }).scripts["test:e2e"] ?? "";
}

/** start-e2e.ts 里直接起 cargo 的地方：编译应当只经 build-e2e.ts。 */
function directCargo(source: string): string[] {
  return source.match(/spawnSync\(\s*"cargo"/gu) ?? [];
}

describe("e2e 先编译、再起 Playwright", () => {
  it("pnpm test:e2e 先跑 build-e2e.ts，再 playwright test", () => {
    const packageJson = readFileSync(join(root, "package.json"), "utf8");
    expect(e2eScript(packageJson)).toBe("tsx scripts/build-e2e.ts && playwright test");
    // 阳性对照：改回只起 Playwright 会被认出来。
    const mutated = packageJson.replace(
      '"tsx scripts/build-e2e.ts && playwright test"',
      '"playwright test"',
    );
    expect(e2eScript(mutated)).toBe("playwright test");
  });

  it("webServer 的脚本只经 build-e2e.ts 编译", () => {
    const source = readFileSync(join(root, "scripts", "start-e2e.ts"), "utf8");
    expect(directCargo(source)).toEqual([]);
    expect(source).toContain("buildE2eBinaries(workspace)");
    expect(directCargo('const build = spawnSync(\n  "cargo",\n  ["build"]);')).toHaveLength(1);
  });

  it("改了 build-e2e.ts，e2e 阶段不复用", () => {
    expect(STAGE_INPUTS.e2e?.include).toContain("scripts/build-e2e.ts");
  });
});
