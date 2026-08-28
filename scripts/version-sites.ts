import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertReleaseChecklistIsDynamic as assertDynamicChecklistContent } from "./release-checklist-contract.js";

// 版本号散落的全部位置。漏改一处，Squirrel 会拿同名不同哈希的包当升级处理，
// 装出来的还是旧版——1.0.1 那次就是这么撞上的。
export const VERSIONED_FILES = [
  "package.json",
  // The daemon entrypoints consume this single source of truth rather than
  // carrying duplicate literals themselves.
  "apps/daemon/src/runtime-discovery.ts",
  "apps/daemon/test/mcp-http.test.ts",
  "packages/mcp/src/server.ts",
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

// 发布清单现在只保存稳定规则与证据入口；候选状态、测试数量和哈希都由 assembler
// 动态生成。升版时不能再“重置”出版本化待填小节，只验证静态文档没有退化成手填账本。
export function assertReleaseChecklistIsDynamic(root: string): void {
  const path = join(root, "docs", "release-checklist.md");
  const source = readFileSync(path, "utf8");
  assertDynamicChecklistContent(source);
}

export type GrepRunner = (args: string[]) => { status: number | null; stdout: string };

/**
 * 真正的版本站点在 .ts / .json 里一律是带引号的字符串字面量（`version: "1.2.3"`、
 * `"version": "1.2.3"`）。解释性注释里提到旧版本（「1.0.5 那次就是」）不是站点，
 * 但同样含有那串数字——历史注释越写越多，纯子串匹配的误报就越多，最后逼人
 * 去删注释来讨好检查。按引号判定把两者分开。
 *
 * 用例夹具仍然不该写真版本号：带引号的夹具值这条规则分不出来，也不该分——
 * 夹具用永不发布的号（9.9.9）即可。连这段注释里的举例也不能写真版本号。
 */
export function isVersionSiteLine(line: string, version: string): boolean {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`["'\`]${escaped}["'\`]`, "u").test(line);
}

// git grep 用退出码表达结果：0 有匹配，1 没有匹配，>1 才是真出错。把「没有匹配」
// 当失败，会让这条检查在版本号改得最干净的时候恰好挂掉——1.0.5 那次就是。
export function findVersionLeftovers(version: string, run: GrepRunner = defaultGrep): string[] {
  const result = run(["grep", "-n", "--fixed-strings", version, "--", "*.ts", "*.json"]);
  if (result.status === 1) return [];
  if (result.status !== 0) throw new Error(`GIT_GREP_FAILED: 退出码 ${result.status}`);
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .filter((line) => isVersionSiteLine(line, version));
}

function defaultGrep(args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync("git", args, { encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? "" };
}
