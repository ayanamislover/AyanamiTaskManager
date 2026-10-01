import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentGuideBuild } from "../apps/desktop/src/agent-guide-stamp.js";

/**
 * 打包用的构建身份：package.json 的版本 + HEAD 的 12 位短哈希。工作区有未提交的已跟踪改动时
 * 加 `-dirty`，本机调试包因此一眼能和正式构建区分开。取不到 commit 就让打包失败，
 * 不盖一个说不清来历的戳。
 */
export function resolveAgentGuideBuild(
  dir: string,
  git: (args: string[]) => string = (args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }),
): AgentGuideBuild {
  const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    version: string;
  };
  const head = git(["rev-parse", "--short=12", "HEAD"]).trim();
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]).trim() !== "";
  return { version, commit: dirty ? `${head}-dirty` : head };
}
