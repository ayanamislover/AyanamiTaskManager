import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { prunePackagedAgentResourcePlaceholders } from "../../../scripts/forge-api.js";

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
    const forgeApi = readFileSync(join(root, "scripts", "forge-api.ts"), "utf8");
    expect(forgeApi).toMatch(
      /await api\.package\([\s\S]*?await prunePackagedAgentResourcePlaceholders\(dir\)/u,
    );
  });

  it("清除 Agent 资源空目录，避免 portable ZIP 生成 manifest 外占位项", async () => {
    const root = await mkdtemp(join(tmpdir(), "atm-forge-resources-"));
    const resources = join(root, "out", "AyanamiTaskManager-win32-x64", "resources");
    const emptyDocs = join(resources, "docs", "performance", "nested");
    const keptDocs = join(resources, "docs", "generated");
    const emptySkills = join(resources, "integrations", "skills", "unused");
    const keptSkill = join(resources, "integrations", "skills", "atm-task", "SKILL.md");
    try {
      await mkdir(emptyDocs, { recursive: true });
      await mkdir(keptDocs, { recursive: true });
      await mkdir(emptySkills, { recursive: true });
      await mkdir(dirname(keptSkill), { recursive: true });
      await writeFile(join(keptDocs, "contract.md"), "contract\n", "utf8");
      await writeFile(keptSkill, "skill\n", "utf8");

      await prunePackagedAgentResourcePlaceholders(root);

      expect(existsSync(join(resources, "docs", "performance"))).toBe(false);
      expect(existsSync(emptySkills)).toBe(false);
      expect(readFileSync(join(keptDocs, "contract.md"), "utf8")).toBe("contract\n");
      expect(readFileSync(keptSkill, "utf8")).toBe("skill\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
