import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { treeDigest } from "../../../scripts/tree-digest.js";

// W8 关口 peer r18 P2-02：window-smoke 的报告要绑定候选——源码指纹与实际运行的 smoke 包的内容哈希，
// 跑完再核一次包没变。
describe("目录摘要与 window-smoke 的候选绑定", () => {
  it("文件改了、多了、改了名，摘要都变；与写入顺序无关", async () => {
    mkdirSync(join(process.cwd(), "output"), { recursive: true });
    const base = mkdtempSync(join(process.cwd(), "output", "tree-digest-test-"));
    try {
      const make = (name: string, files: Array<[string, string]>) => {
        const root = join(base, name);
        for (const [path, content] of files) {
          mkdirSync(join(root, path, ".."), { recursive: true });
          writeFileSync(join(root, path), content);
        }
        return root;
      };
      const a = make("a", [
        ["x.txt", "1"],
        ["renderer/index.html", "<html>"],
      ]);
      const b = make("b", [
        ["renderer/index.html", "<html>"],
        ["x.txt", "1"],
      ]);
      const first = await treeDigest(a);
      expect(first.files).toBe(2);
      expect(await treeDigest(b)).toEqual(first);
      writeFileSync(join(b, "x.txt"), "2");
      const changed = await treeDigest(b);
      expect(changed.sha256).not.toBe(first.sha256);
      writeFileSync(join(b, "x.txt"), "1");
      expect(await treeDigest(b)).toEqual(first);
      renameSync(join(b, "x.txt"), join(b, "y.txt"));
      expect((await treeDigest(b)).sha256).not.toBe(first.sha256);
      renameSync(join(b, "y.txt"), join(b, "x.txt"));
      writeFileSync(join(b, "renderer", "extra.js"), "");
      expect(await treeDigest(b)).toEqual({
        files: 3,
        sha256: expect.not.stringMatching(first.sha256),
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("window-smoke 的报告记下源码指纹、宿主与包的哈希、截图哈希，跑完核对包没变", () => {
    const source = readFileSync(join(process.cwd(), "scripts/window-smoke.ts"), "utf8");
    expect(source).toContain("const source = await computeReleaseFingerprint(process.cwd());");
    expect(source).toContain("executableSha256: sha256(await readFile(executable)),");
    expect(source).toContain("package: { root: packageRoot, ...(await treeDigest(packageRoot)) },");
    // 开跑前记下，跑完再算一次。
    expect(source.indexOf("const candidate = {")).toBeLessThan(
      source.indexOf("const host = startSmokeHost("),
    );
    expect(source).toMatch(
      /const packageAfter = await treeDigest\(packageRoot\);\s*log\.record\(\s*"跑完之后 smoke 包的内容与开跑前一致",\s*packageAfter\.sha256 === candidate\.package\.sha256,/u,
    );
    expect(source.indexOf("const packageAfter")).toBeLessThan(
      source.indexOf("const passed = error === undefined && log.failed.length === 0;"),
    );
    expect(source).toMatch(/const report = \{\s*passed,\s*executable,\s*candidate,/u);
    expect(source).toMatch(/completedAt: new Date\(\)\.toISOString\(\),\s*screenshots,/u);
  });
});
