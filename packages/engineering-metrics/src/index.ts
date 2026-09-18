import {
  codeKind,
  createScanContext,
  dependencyNamesFromJson,
  EMPTY_TREE,
  included,
  lineCount,
  mapLimited,
  normalizePath,
  READ_CONCURRENCY,
  type ScanContext,
} from "./scan-context.js";

export type { GitCommandResult, GitCommandRunner } from "./git-command.js";
export { defaultGitCommandRunner } from "./git-command.js";
export { inspectGitContext, type GitContext, type GitContextError } from "./git-context.js";

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

async function numstat(
  scan: ScanContext,
  baseline: string,
): Promise<Array<{ path: string; added: number; deleted: number }>> {
  const output = await scan.run(["diff", "--numstat", "--no-renames", baseline, "--"]);
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

async function baselineBefore(scan: ScanContext, cutoff: Date): Promise<string> {
  if ((await scan.head()) === EMPTY_TREE) return EMPTY_TREE;
  return (
    (await scan.run(["rev-list", "-1", `--before=${cutoff.toISOString()}`, "HEAD"])) || EMPTY_TREE
  );
}

async function netCodeLines(scan: ScanContext, cutoff: Date): Promise<number> {
  const changes = await numstat(scan, await baselineBefore(scan, cutoff));
  return changes.reduce(
    (sum, item) => (codeKind(item.path) ? sum + item.added - item.deleted : sum),
    0,
  );
}

async function baselineDependencies(scan: ScanContext, baseline: string): Promise<Set<string>> {
  const paths = (await scan.run(["ls-tree", "-r", "--name-only", baseline]))
    .split(/\r?\n/u)
    .filter((path) => path.endsWith("package.json") && included(path));
  const result = new Set<string>();
  // 每个清单一个 `git show`，monorepo 里可能有上百个：要并发，但不能一口气全放出去。
  await mapLimited(paths, READ_CONCURRENCY, async (path) => {
    let content = "";
    try {
      content = await scan.run(["show", `${baseline}:${normalizePath(path)}`]);
    } catch {
      return;
    }
    for (const dependency of dependencyNamesFromJson(content)) result.add(dependency);
  });
  return result;
}

async function untrackedCode(scan: ScanContext): Promise<Array<{ path: string; added: number }>> {
  const tracked = await scan.trackedPaths();
  const candidates = (await scan.files()).filter(
    (path) => !tracked.has(path) && codeKind(path) !== null,
  );
  const measured = await mapLimited(candidates, READ_CONCURRENCY, async (path) => {
    const content = await scan.readText(path);
    return content === null ? null : { path, added: lineCount(content) };
  });
  return measured.filter((item): item is NonNullable<typeof item> => item !== null);
}

export async function gitHead(directory: string): Promise<string> {
  return createScanContext(directory).head();
}

export async function scanProjectMetrics(
  directory: string,
  options: { now?: Date; topN?: number } = {},
): Promise<ProjectEngineeringMetrics> {
  const scan = createScanContext(directory);
  const now = options.now ?? new Date();
  const topN = Math.min(20, Math.max(1, options.topN ?? 8));
  const head = await scan.head();
  const paths = await scan.files();
  // 只留行数：全文读一个丢一个，别为了统计几个数字把整个仓库攥在内存里。
  const measured = await mapLimited(paths, READ_CONCURRENCY, async (path) => {
    const kind = codeKind(path);
    if (!kind) return null;
    const content = await scan.readText(path);
    return content === null ? null : { path, kind, loc: lineCount(content) };
  });
  const locFiles = measured.filter((item): item is NonNullable<typeof item> => item !== null);
  const sourceLoc = locFiles
    .filter((item) => item.kind === "source")
    .reduce((sum, item) => sum + item.loc, 0);
  const testLoc = locFiles
    .filter((item) => item.kind === "test")
    .reduce((sum, item) => sum + item.loc, 0);

  const [log, dependencies, netLoc7d, netLoc30d] = await Promise.all([
    head === EMPTY_TREE
      ? ""
      : scan.run([
          "log",
          `--since=${new Date(now.valueOf() - 30 * 86_400_000).toISOString()}`,
          "--numstat",
          "--format=",
          "--no-renames",
        ]),
    scan.dependencies(),
    head === EMPTY_TREE
      ? sourceLoc + testLoc
      : netCodeLines(scan, new Date(now.valueOf() - 7 * 86_400_000)),
    head === EMPTY_TREE
      ? sourceLoc + testLoc
      : netCodeLines(scan, new Date(now.valueOf() - 30 * 86_400_000)),
  ]);

  const churn = new Map<string, { added: number; deleted: number }>();
  for (const line of log.split(/\r?\n/u).filter(Boolean)) {
    const [added, deleted, ...pathParts] = line.split("\t");
    const path = normalizePath(pathParts.join("\t"));
    if (!codeKind(path) || added === "-" || deleted === "-") continue;
    const current = churn.get(path) ?? { added: 0, deleted: 0 };
    current.added += Number(added);
    current.deleted += Number(deleted);
    churn.set(path, current);
  }

  return {
    sourceLoc,
    testLoc,
    fileCount: paths.length,
    dependencyCount: dependencies.size,
    netLoc7d,
    netLoc30d,
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

export async function scanWorkItemChanges(
  directory: string,
  baseline: string,
): Promise<WorkItemEngineeringMetrics> {
  const scan = createScanContext(directory);
  const [trackedChanges, untracked, statusOutput, tracked, paths, baselineDependenciesSet, head] =
    await Promise.all([
      numstat(scan, baseline),
      untrackedCode(scan),
      scan.run(["diff", "--name-status", "--no-renames", baseline, "--"]),
      scan.trackedPaths(),
      scan.files(),
      baselineDependencies(scan, baseline),
      scan.head(),
    ]);
  const statuses = statusOutput
    .split(/\r?\n/u)
    .filter(Boolean)
    .flatMap((line) => {
      const [status, ...parts] = line.split("\t");
      const path = normalizePath(parts.join("\t"));
      return status && path && included(path) ? [{ status, path }] : [];
    });
  const untrackedPaths = paths
    .filter((path) => !tracked.has(path))
    .map((path) => ({ status: "A", path }));
  const unique = new Map<string, string>();
  for (const item of [...statuses, ...untrackedPaths]) unique.set(item.path, item.status);
  const codeChanges = [
    ...trackedChanges.filter((item) => codeKind(item.path)),
    ...untracked.map((item) => ({ ...item, deleted: 0 })),
  ];
  const linesAdded = codeChanges.reduce((sum, item) => sum + item.added, 0);
  const linesDeleted = codeChanges.reduce((sum, item) => sum + item.deleted, 0);
  const dependenciesAdded = [...(await scan.dependencies())]
    .filter((dependency) => !baselineDependenciesSet.has(dependency))
    .sort();
  return {
    baseline,
    head,
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
