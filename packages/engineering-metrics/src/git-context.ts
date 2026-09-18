import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  defaultGitCommandRunner,
  type GitCommandResult,
  type GitCommandRunner,
} from "./git-command.js";

export type GitContextError = "NOT_GIT" | "WORKTREE_MISSING" | "COMMAND_TIMEOUT" | "COMMAND_FAILED";

export type GitContext = {
  available: boolean;
  repoRoot: string | null;
  worktreeRoot: string | null;
  gitCommonDir: string | null;
  isLinkedWorktree: boolean | null;
  branch: string | null;
  head: string | null;
  detached: boolean | null;
  dirty: boolean | null;
  error: GitContextError | null;
};

function unavailable(error: GitContextError): GitContext {
  return {
    available: false,
    repoRoot: null,
    worktreeRoot: null,
    gitCommonDir: null,
    isLinkedWorktree: null,
    branch: null,
    head: null,
    detached: null,
    dirty: null,
    error,
  };
}

function gitContextFailure(result: GitCommandResult): GitContextError {
  if (result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM") return "COMMAND_TIMEOUT";
  return /not a git repository/iu.test(`${result.stderr}\n${result.stdout}`)
    ? "NOT_GIT"
    : "COMMAND_FAILED";
}

function absoluteGitPath(cwd: string, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const absolute = resolve(cwd, trimmed);
  try {
    // Windows may expose cwd through an 8.3 alias while Git returns the long path.
    // Canonicalize every observed Git path so identity and linked-worktree checks
    // compare the same filesystem object instead of two textual spellings.
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

export async function inspectGitContext(
  cwd: string,
  options: { timeoutMs?: number; runner?: GitCommandRunner } = {},
): Promise<GitContext> {
  if (!existsSync(cwd)) return unavailable("WORKTREE_MISSING");
  const timeoutMs = Math.max(100, Math.min(10_000, options.timeoutMs ?? 1500));
  const runner = options.runner ?? defaultGitCommandRunner;
  const run = (args: string[]) => runner(args, cwd, timeoutMs);
  const rootResult = await run(["rev-parse", "--show-toplevel"]);
  if (rootResult.status !== 0) return unavailable(gitContextFailure(rootResult));

  const worktreeRoot = absoluteGitPath(cwd, rootResult.stdout);
  if (!worktreeRoot) return unavailable("COMMAND_FAILED");
  // 这六条互不依赖，一起发出去；反正 daemon 在等的这段时间本来也能答别的请求。
  const [gitDirResult, commonDirResult, headResult, branchResult, statusResult, worktreesResult] =
    await Promise.all([
      run(["rev-parse", "--absolute-git-dir"]),
      run(["rev-parse", "--git-common-dir"]),
      run(["rev-parse", "HEAD"]),
      run(["branch", "--show-current"]),
      run(["status", "--porcelain", "--untracked-files=normal"]),
      run(["worktree", "list", "--porcelain"]),
    ]);
  const gitDir = gitDirResult.status === 0 ? absoluteGitPath(cwd, gitDirResult.stdout) : null;
  const gitCommonDir =
    commonDirResult.status === 0 ? absoluteGitPath(cwd, commonDirResult.stdout) : null;
  const worktrees =
    worktreesResult.status === 0
      ? worktreesResult.stdout
          .split(/\r?\n/gu)
          .filter((line) => line.startsWith("worktree "))
          .map((line) => absoluteGitPath(cwd, line.slice("worktree ".length)))
          .filter((path): path is string => Boolean(path))
      : [];
  const branch = branchResult.status === 0 ? branchResult.stdout.trim() || null : null;
  const head = headResult.status === 0 ? headResult.stdout.trim() || null : null;
  return {
    available: true,
    repoRoot: worktrees[0] ?? worktreeRoot,
    worktreeRoot,
    gitCommonDir,
    isLinkedWorktree:
      gitDir && gitCommonDir ? gitDir.toLowerCase() !== gitCommonDir.toLowerCase() : null,
    branch,
    head,
    detached: head ? branch === null : null,
    dirty: statusResult.status === 0 ? statusResult.stdout.trim().length > 0 : null,
    error: null,
  };
}
