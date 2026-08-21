import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// 版本号散落的全部位置。漏改一处，Squirrel 会拿同名不同哈希的包当升级处理，
// 装出来的还是旧版——1.0.1 那次就是这么撞上的。
export const VERSIONED_FILES = [
  "package.json",
  "apps/daemon/src/index.ts",
  "apps/daemon/src/main.ts",
  "apps/daemon/test/mcp-http.test.ts",
  "packages/mcp/src/index.ts",
  "packages/storage-sqlite/src/manager.ts",
  "docs/user-guide.md",
] as const;

export function bumpVersion(root: string, from: string, to: string): string[] {
  const changed: string[] = [];
  for (const file of VERSIONED_FILES) {
    const path = join(root, file);
    const before = readFileSync(path, "utf8");
    const after = before.split(from).join(to);
    if (after === before) continue;
    writeFileSync(path, after, "utf8");
    changed.push(file);
  }
  return changed;
}

// 发布清单不能只换版本号：勾选必须清零（1.0.2 那份 32 个勾里有 6 条从来没有
// 对应用例），验收结果一节也必须清空——否则上一版的数字会顶着新版本号留在
// 文档里，变成看起来像本轮实测的假账。
export function resetReleaseChecklist(root: string, from: string, to: string): void {
  const path = join(root, "docs", "release-checklist.md");
  const source = readFileSync(path, "utf8").split(from).join(to);
  const lines = source
    .split("\n")
    .map((line) => (line.startsWith("- [x]") ? `- [ ]${line.slice(5)}` : line));
  const heading = `## ${to} 验收结果`;
  const index = lines.indexOf(heading);
  const head = (index >= 0 ? lines.slice(0, index) : lines).join("\n").replace(/\n+$/u, "");
  const pending = "本轮尚未完成，结果待填。在十阶段跑完并对安装版实测之前，此处不得写入任何数字。";
  writeFileSync(path, `${head}\n\n${heading}\n\n${pending}\n`, "utf8");
}

export type GrepRunner = (args: string[]) => { status: number | null; stdout: string };

// git grep 用退出码表达结果：0 有匹配，1 没有匹配，>1 才是真出错。把「没有匹配」
// 当失败，会让这条检查在版本号改得最干净的时候恰好挂掉——1.0.5 那次就是。
export function findVersionLeftovers(version: string, run: GrepRunner = defaultGrep): string[] {
  const result = run(["grep", "-n", "--fixed-strings", version, "--", "*.ts", "*.json"]);
  if (result.status === 1) return [];
  if (result.status !== 0) throw new Error(`GIT_GREP_FAILED: 退出码 ${result.status}`);
  return result.stdout.split("\n").filter(Boolean);
}

function defaultGrep(args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync("git", args, { encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? "" };
}
