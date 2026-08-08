import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withTemporaryDirectory } from "@ayanami-task/testing";
import { gitHead, scanProjectMetrics, scanWorkItemChanges } from "../src/index.js";

function git(directory: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();
}

function commit(directory: string, message: string, at: Date): void {
  git(directory, ["add", "-A"]);
  const timestamp = at.toISOString();
  git(directory, ["commit", "-m", message], {
    GIT_AUTHOR_DATE: timestamp,
    GIT_COMMITTER_DATE: timestamp,
  });
}

describe("轻量工程统计扫描器", () => {
  it("尚无首个 commit 的 Git 工作树仍可使用空树 baseline 统计", async () => {
    await withTemporaryDirectory("metrics-unborn", (directory) => {
      git(directory, ["init"]);
      mkdirSync(join(directory, "src"));
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({ dependencies: { react: "1" } }),
      );
      writeFileSync(join(directory, "src", "main.ts"), "export const main = true;\n");
      const metrics = scanProjectMetrics(directory);
      expect(metrics).toMatchObject({ sourceLoc: 1, testLoc: 0, netLoc7d: 1, netLoc30d: 1 });
      expect(metrics.head).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
      expect(scanWorkItemChanges(directory, metrics.head)).toMatchObject({
        filesCreated: 2,
        sourceLinesAdded: 1,
        dependenciesAdded: ["react"],
      });
    });
  });

  it("从真实 Git 仓库计算项目规模、近期净 LOC、最大文件和 churn", async () => {
    await withTemporaryDirectory("metrics-project", (directory) => {
      git(directory, ["init"]);
      git(directory, ["config", "user.email", "atm@example.test"]);
      git(directory, ["config", "user.name", "ATM Test"]);
      mkdirSync(join(directory, "src"));
      mkdirSync(join(directory, "test"));
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({ dependencies: { react: "1.0.0" } }, null, 2),
      );
      writeFileSync(
        join(directory, "src", "large.ts"),
        "export const one = 1;\nexport const two = 2;\n",
      );
      writeFileSync(join(directory, "test", "large.test.ts"), "describe('one', () => {});\n");
      const now = new Date();
      commit(directory, "baseline", new Date(now.valueOf() - 10 * 86_400_000));

      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({ dependencies: { react: "1.0.0", vitest: "1.0.0" } }, null, 2),
      );
      writeFileSync(
        join(directory, "src", "large.ts"),
        "export const one = 1;\nexport const two = 2;\nexport const three = 3;\n",
      );
      writeFileSync(join(directory, "src", "small.ts"), "export const small = true;\n");
      writeFileSync(
        join(directory, "test", "large.test.ts"),
        "describe('one', () => {});\nit('works', () => {});\n",
      );
      commit(directory, "recent growth", new Date(now.valueOf() - 2 * 86_400_000));

      const metrics = scanProjectMetrics(directory, { now, topN: 3 });
      expect(metrics).toMatchObject({ sourceLoc: 4, testLoc: 2, dependencyCount: 2, netLoc7d: 3 });
      expect(metrics.fileCount).toBeGreaterThanOrEqual(4);
      expect(metrics.netLoc30d).toBeGreaterThanOrEqual(6);
      expect(metrics.largestFiles[0]).toMatchObject({ path: "src/large.ts", loc: 3 });
      expect(metrics.highChurnFiles.some((item) => item.path === "src/large.ts")).toBe(true);
      expect(metrics.head).toMatch(/^[0-9a-f]{40}$/u);
    });
  });

  it("相对任务 baseline 统计修改、新建、删除、行数和新增依赖", async () => {
    await withTemporaryDirectory("metrics-work-item", (directory) => {
      git(directory, ["init"]);
      git(directory, ["config", "user.email", "atm@example.test"]);
      git(directory, ["config", "user.name", "ATM Test"]);
      mkdirSync(join(directory, "src"));
      mkdirSync(join(directory, "test"));
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({ dependencies: { react: "1.0.0" } }, null, 2),
      );
      writeFileSync(join(directory, "src", "main.ts"), "export const main = 1;\n");
      writeFileSync(join(directory, "test", "main.test.ts"), "it('main', () => {});\n");
      commit(directory, "baseline", new Date());
      const baseline = gitHead(directory);

      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({ dependencies: { react: "1.0.0", zod: "1.0.0" } }, null, 2),
      );
      writeFileSync(
        join(directory, "src", "main.ts"),
        "export const main = 1;\nexport const next = 2;\n",
      );
      writeFileSync(join(directory, "src", "new.ts"), "export const created = true;\n");
      rmSync(join(directory, "test", "main.test.ts"));

      expect(scanWorkItemChanges(directory, baseline)).toMatchObject({
        filesChanged: 2,
        filesCreated: 1,
        filesDeleted: 1,
        linesAdded: 2,
        linesDeleted: 1,
        netLines: 1,
        sourceLinesAdded: 2,
        testLinesAdded: 0,
        dependenciesAdded: ["zod"],
      });
    });
  });
});
