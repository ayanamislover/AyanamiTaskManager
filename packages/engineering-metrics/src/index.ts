import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const CODE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".lua",
  ".mjs",
  ".php",
  ".ps1",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".swift",
  ".ts",
  ".tsx",
  ".vue",
]);
const EXCLUDED_SEGMENTS = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "output",
  "release",
  "target",
  "vendor",
]);
const LOCK_FILES = new Set([
  "bun.lock",
  "bun.lockb",
  "composer.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "uv.lock",
  "yarn.lock",
]);

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

export type GitCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  signal?: string | null;
  error?: Error & { code?: string };
};

export type GitCommandRunner = (args: string[], cwd: string, timeoutMs: number) => GitCommandResult;

function defaultGitCommandRunner(args: string[], cwd: string, timeoutMs: number): GitCommandResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    signal: result.signal,
    ...(result.error ? { error: result.error } : {}),
  };
}

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

export function inspectGitContext(
  cwd: string,
  options: { timeoutMs?: number; runner?: GitCommandRunner } = {},
): GitContext {
  if (!existsSync(cwd)) return unavailable("WORKTREE_MISSING");
  const timeoutMs = Math.max(100, Math.min(10_000, options.timeoutMs ?? 1500));
  const runner = options.runner ?? defaultGitCommandRunner;
  const run = (args: string[]) => runner(args, cwd, timeoutMs);
  const rootResult = run(["rev-parse", "--show-toplevel"]);
  if (rootResult.status !== 0) return unavailable(gitContextFailure(rootResult));

  const worktreeRoot = absoluteGitPath(cwd, rootResult.stdout);
  if (!worktreeRoot) return unavailable("COMMAND_FAILED");
  const gitDirResult = run(["rev-parse", "--absolute-git-dir"]);
  const commonDirResult = run(["rev-parse", "--git-common-dir"]);
  const headResult = run(["rev-parse", "HEAD"]);
  const branchResult = run(["branch", "--show-current"]);
  const statusResult = run(["status", "--porcelain", "--untracked-files=normal"]);
  const worktreesResult = run(["worktree", "list", "--porcelain"]);
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

export type FileMetric = { path: string; loc: number };
export type ChurnMetric = { path: string; added: number; deleted: number; churn: number };

export type ProjectEngineeringMetrics = {
  sourceLoc: number;
  testLoc: number;
  fileCount: number;
  dependencyCount: number;
  netLoc7d: number;
  netLoc30d: number;
  largestFiles: FileMetric[];
  highChurnFiles: ChurnMetric[];
  head: string;
  capturedAt: string;
};

export type WorkItemEngineeringMetrics = {
  baseline: string;
  head: string;
  filesChanged: number;
  filesCreated: number;
  filesDeleted: number;
  linesAdded: number;
  linesDeleted: number;
  netLines: number;
  sourceLinesAdded: number;
  testLinesAdded: number;
  dependenciesAdded: string[];
  capturedAt: string;
};

function git(directory: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
    }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`GIT_METRICS_FAILED: ${message}`);
  }
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function extension(path: string): string {
  const name = normalizePath(path).split("/").at(-1) ?? "";
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index).toLowerCase();
}

function included(path: string): boolean {
  const normalized = normalizePath(path);
  if (!normalized || LOCK_FILES.has(normalized.split("/").at(-1) ?? "")) return false;
  return !normalized.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

function codeKind(path: string): "source" | "test" | null {
  const normalized = normalizePath(path).toLowerCase();
  if (
    !included(normalized) ||
    !CODE_EXTENSIONS.has(extension(normalized)) ||
    normalized.endsWith(".d.ts")
  )
    return null;
  const fileName = normalized.split("/").at(-1) ?? "";
  return normalized
    .split("/")
    .some((segment) => ["test", "tests", "__tests__", "spec", "specs"].includes(segment)) ||
    /(?:^|\.)(?:test|spec)\.[^.]+$/u.test(fileName)
    ? "test"
    : "source";
}

function lineCount(content: string): number {
  if (!content) return 0;
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

function readText(directory: string, relativePath: string): string | null {
  const absolute = resolve(directory, ...normalizePath(relativePath).split("/"));
  const root = `${resolve(directory)}${sep}`.toLowerCase();
  if (!absolute.toLowerCase().startsWith(root) || !existsSync(absolute)) return null;
  const buffer = readFileSync(absolute);
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

function files(directory: string): string[] {
  const output = git(directory, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  return output
    .split("\0")
    .map(normalizePath)
    .filter((path) => path && included(path));
}

function numstat(
  directory: string,
  baseline: string,
): Array<{ path: string; added: number; deleted: number }> {
  const output = git(directory, ["diff", "--numstat", "--no-renames", baseline, "--"]);
  return output
    .split(/\r?\n/u)
    .filter(Boolean)
    .flatMap((line) => {
      const [added, deleted, ...pathParts] = line.split("\t");
      const path = normalizePath(pathParts.join("\t"));
      if (!path || added === "-" || deleted === "-" || !included(path)) return [];
      return [{ path, added: Number(added), deleted: Number(deleted) }];
    });
}

function baselineBefore(directory: string, cutoff: Date): string {
  if (gitHead(directory) === EMPTY_TREE) return EMPTY_TREE;
  return (
    git(directory, ["rev-list", "-1", `--before=${cutoff.toISOString()}`, "HEAD"]) || EMPTY_TREE
  );
}

function netCodeLines(directory: string, baseline: string): number {
  return numstat(directory, baseline).reduce(
    (sum, item) => (codeKind(item.path) ? sum + item.added - item.deleted : sum),
    0,
  );
}

function dependencyNamesFromJson(content: string): string[] {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap(
      (key) =>
        parsed[key] && typeof parsed[key] === "object"
          ? Object.keys(parsed[key] as Record<string, unknown>)
          : [],
    );
  } catch {
    return [];
  }
}

function currentDependencies(directory: string): Set<string> {
  const result = new Set<string>();
  for (const path of files(directory).filter((path) => path.endsWith("package.json"))) {
    const content = readText(directory, path);
    if (content) for (const dependency of dependencyNamesFromJson(content)) result.add(dependency);
  }
  return result;
}

function baselineDependencies(directory: string, baseline: string): Set<string> {
  const result = new Set<string>();
  const paths = git(directory, ["ls-tree", "-r", "--name-only", baseline])
    .split(/\r?\n/u)
    .filter((path) => path.endsWith("package.json") && included(path));
  for (const path of paths) {
    let content = "";
    try {
      content = git(directory, ["show", `${baseline}:${normalizePath(path)}`]);
    } catch {
      continue;
    }
    for (const dependency of dependencyNamesFromJson(content)) result.add(dependency);
  }
  return result;
}

function untrackedCode(directory: string): Array<{ path: string; added: number }> {
  const tracked = new Set(
    git(directory, ["ls-files", "--cached", "-z"]).split("\0").map(normalizePath),
  );
  return files(directory).flatMap((path) => {
    if (tracked.has(path) || !codeKind(path)) return [];
    const content = readText(directory, path);
    return content === null ? [] : [{ path, added: lineCount(content) }];
  });
}

export function gitHead(directory: string): string {
  try {
    return git(directory, ["rev-parse", "HEAD"]);
  } catch (error) {
    if (git(directory, ["rev-parse", "--is-inside-work-tree"]) === "true") return EMPTY_TREE;
    throw error;
  }
}

export function scanProjectMetrics(
  directory: string,
  options: { now?: Date; topN?: number } = {},
): ProjectEngineeringMetrics {
  const now = options.now ?? new Date();
  const topN = Math.min(20, Math.max(1, options.topN ?? 8));
  const head = gitHead(directory);
  const locFiles = files(directory).flatMap((path) => {
    const kind = codeKind(path);
    if (!kind) return [];
    const content = readText(directory, path);
    return content === null ? [] : [{ path, kind, loc: lineCount(content) }];
  });
  const churn = new Map<string, { added: number; deleted: number }>();
  const log =
    head === EMPTY_TREE
      ? ""
      : git(directory, [
          "log",
          `--since=${new Date(now.valueOf() - 30 * 86_400_000).toISOString()}`,
          "--numstat",
          "--format=",
          "--no-renames",
        ]);
  for (const line of log.split(/\r?\n/u).filter(Boolean)) {
    const [added, deleted, ...pathParts] = line.split("\t");
    const path = normalizePath(pathParts.join("\t"));
    if (!codeKind(path) || added === "-" || deleted === "-") continue;
    const current = churn.get(path) ?? { added: 0, deleted: 0 };
    current.added += Number(added);
    current.deleted += Number(deleted);
    churn.set(path, current);
  }
  const sourceLoc = locFiles
    .filter((item) => item.kind === "source")
    .reduce((sum, item) => sum + item.loc, 0);
  const testLoc = locFiles
    .filter((item) => item.kind === "test")
    .reduce((sum, item) => sum + item.loc, 0);
  return {
    sourceLoc,
    testLoc,
    fileCount: files(directory).length,
    dependencyCount: currentDependencies(directory).size,
    netLoc7d:
      head === EMPTY_TREE
        ? sourceLoc + testLoc
        : netCodeLines(
            directory,
            baselineBefore(directory, new Date(now.valueOf() - 7 * 86_400_000)),
          ),
    netLoc30d:
      head === EMPTY_TREE
        ? sourceLoc + testLoc
        : netCodeLines(
            directory,
            baselineBefore(directory, new Date(now.valueOf() - 30 * 86_400_000)),
          ),
    largestFiles: locFiles
      .sort((left, right) => right.loc - left.loc || left.path.localeCompare(right.path))
      .slice(0, topN)
      .map(({ path, loc }) => ({ path, loc })),
    highChurnFiles: [...churn.entries()]
      .map(([path, value]) => ({ path, ...value, churn: value.added + value.deleted }))
      .sort((left, right) => right.churn - left.churn || left.path.localeCompare(right.path))
      .slice(0, topN),
    head,
    capturedAt: now.toISOString(),
  };
}

export function scanWorkItemChanges(
  directory: string,
  baseline: string,
): WorkItemEngineeringMetrics {
  const trackedChanges = numstat(directory, baseline);
  const untracked = untrackedCode(directory);
  const statuses = git(directory, ["diff", "--name-status", "--no-renames", baseline, "--"])
    .split(/\r?\n/u)
    .filter(Boolean)
    .flatMap((line) => {
      const [status, ...parts] = line.split("\t");
      const path = normalizePath(parts.join("\t"));
      return status && path && included(path) ? [{ status, path }] : [];
    });
  const trackedPaths = new Set(
    git(directory, ["ls-files", "--cached", "-z"]).split("\0").map(normalizePath),
  );
  const untrackedPaths = files(directory)
    .filter((path) => !trackedPaths.has(path))
    .map((path) => ({ status: "A", path }));
  const unique = new Map<string, string>();
  for (const item of [...statuses, ...untrackedPaths]) unique.set(item.path, item.status);
  const codeChanges = [
    ...trackedChanges.filter((item) => codeKind(item.path)),
    ...untracked.map((item) => ({ ...item, deleted: 0 })),
  ];
  const linesAdded = codeChanges.reduce((sum, item) => sum + item.added, 0);
  const linesDeleted = codeChanges.reduce((sum, item) => sum + item.deleted, 0);
  const baselineDependenciesSet = baselineDependencies(directory, baseline);
  const dependenciesAdded = [...currentDependencies(directory)]
    .filter((dependency) => !baselineDependenciesSet.has(dependency))
    .sort();
  return {
    baseline,
    head: gitHead(directory),
    filesChanged: [...unique.values()].filter(
      (status) => status.startsWith("M") || status.startsWith("T"),
    ).length,
    filesCreated: [...unique.values()].filter((status) => status.startsWith("A")).length,
    filesDeleted: [...unique.values()].filter((status) => status.startsWith("D")).length,
    linesAdded,
    linesDeleted,
    netLines: linesAdded - linesDeleted,
    sourceLinesAdded: codeChanges
      .filter((item) => codeKind(item.path) === "source")
      .reduce((sum, item) => sum + item.added, 0),
    testLinesAdded: codeChanges
      .filter((item) => codeKind(item.path) === "test")
      .reduce((sum, item) => sum + item.added, 0),
    dependenciesAdded,
    capturedAt: new Date().toISOString(),
  };
}
