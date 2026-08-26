import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Forge 脚本入口", () => {
  it("package 与 make 共用受测的 Forge API package 路径", () => {
    const root = process.cwd();
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const packageEntry = readFileSync(join(root, "scripts", "forge-package.ts"), "utf8");
    const makeEntry = readFileSync(join(root, "scripts", "forge-make.ts"), "utf8");

    expect(packageJson.scripts.package).toBe("pnpm build && tsx scripts/forge-package.ts");
    expect(packageEntry).toContain("packageApplication");
    expect(makeEntry).toContain("packageApplication");
    expect(packageJson.scripts.package).not.toContain("electron-forge package");
  });
});
