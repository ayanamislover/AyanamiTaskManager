import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectGitContext } from "../src/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function repository(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  roots.push(root);
  const cwd = join(root, "main");
  git(root, ["init", cwd]);
  git(cwd, ["config", "user.email", "atm@example.test"]);
  git(cwd, ["config", "user.name", "ATM Test"]);
  writeFileSync(join(cwd, "tracked.txt"), "baseline\n", "utf8");
  git(cwd, ["add", "tracked.txt"]);
  git(cwd, ["commit", "-m", "baseline"]);
  return cwd;
}

describe("deterministic Git context", () => {
  it("识别普通主工作树", () => {
    const cwd = repository("atm-git-main");
    const canonicalCwd = realpathSync.native(cwd);
    expect(inspectGitContext(cwd)).toMatchObject({
      available: true,
      repoRoot: canonicalCwd,
      worktreeRoot: canonicalCwd,
      isLinkedWorktree: false,
      detached: false,
      dirty: false,
    });
  });

  it("识别 linked worktree", () => {
    const cwd = repository("atm-git-linked");
    const linked = join(cwd, "..", "linked");
    git(cwd, ["worktree", "add", "--detach", linked, "HEAD"]);
    expect(inspectGitContext(linked)).toMatchObject({
      available: true,
      repoRoot: realpathSync.native(cwd),
      worktreeRoot: realpathSync.native(linked),
      isLinkedWorktree: true,
    });
  });

  it("识别 detached HEAD", () => {
    const cwd = repository("atm-git-detached");
    git(cwd, ["checkout", "--detach", "HEAD"]);
    expect(inspectGitContext(cwd)).toMatchObject({ available: true, branch: null, detached: true });
  });

  it("识别 dirty working tree", () => {
    const cwd = repository("atm-git-dirty");
    writeFileSync(join(cwd, "tracked.txt"), "changed\n", "utf8");
    expect(inspectGitContext(cwd)).toMatchObject({ available: true, dirty: true });
  });

  it("把非 Git 项目作为正常 unavailable 返回", () => {
    const cwd = mkdtempSync(join(tmpdir(), "atm-not-git-"));
    roots.push(cwd);
    expect(inspectGitContext(cwd)).toMatchObject({ available: false, error: "NOT_GIT" });
  });

  it("工作树已删除时不抛异常", () => {
    const cwd = mkdtempSync(join(tmpdir(), "atm-missing-worktree-"));
    rmSync(cwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
    expect(inspectGitContext(cwd)).toMatchObject({
      available: false,
      error: "WORKTREE_MISSING",
    });
  });

  it("Session 中途 branch/head 变化可被下一次观察捕获", () => {
    const cwd = repository("atm-git-refresh");
    const first = inspectGitContext(cwd);
    git(cwd, ["checkout", "--detach", "HEAD"]);
    writeFileSync(join(cwd, "second.txt"), "second\n", "utf8");
    git(cwd, ["add", "second.txt"]);
    git(cwd, ["commit", "-m", "second"]);
    const second = inspectGitContext(cwd);
    expect(second.head).not.toBe(first.head);
    expect(second).toMatchObject({ branch: null, detached: true });
  });

  it("Git command 超时只返回错误状态", () => {
    const cwd = mkdtempSync(join(tmpdir(), "atm-git-timeout-"));
    roots.push(cwd);
    expect(
      inspectGitContext(cwd, {
        runner: () => ({
          status: null,
          stdout: "",
          stderr: "",
          signal: "SIGTERM",
          error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
        }),
      }),
    ).toMatchObject({ available: false, error: "COMMAND_TIMEOUT" });
  });
});
