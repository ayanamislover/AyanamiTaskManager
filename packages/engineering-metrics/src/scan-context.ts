import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { runGit } from "./git-command.js";

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** 同时读多少个文件。libuv 默认只有 4 个线程，再高也只是多攥几份全文在内存里。 */
export const READ_CONCURRENCY = 16;

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

export function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function extension(path: string): string {
  const name = normalizePath(path).split("/").at(-1) ?? "";
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index).toLowerCase();
}

export function included(path: string): boolean {
  const normalized = normalizePath(path);
  if (!normalized || LOCK_FILES.has(normalized.split("/").at(-1) ?? "")) return false;
  return !normalized.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

export function codeKind(path: string): "source" | "test" | null {
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

export function lineCount(content: string): number {
  if (!content) return 0;
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

export function dependencyNamesFromJson(content: string): string[] {
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

function memoize<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => (pending ??= load());
}

/**
 * 有并发上限的 map。
 *
 * 一次 `Promise.all(paths.map(readFile))` 在大仓上会同时挂起上万次读取，而且把每个文件的
 * 全文一起攥在手里等 all 落地——我们要的只是行数。这里边读边收敛，内存里同时只有上限那么多份。
 */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * 一次扫描的共享上下文。
 *
 * 同一次扫描里 `ls-files`、`rev-parse HEAD`、依赖清单原本各被求值两到三次，每次都是一个
 * git 子进程：scanProjectMetrics 光 `ls-files` 就跑三遍。同一次扫描内这些结果不会变，
 * 所以在这里各算一次。
 */
export type ScanContext = {
  readonly directory: string;
  run(args: string[]): Promise<string>;
  /** 当前 HEAD；仓库还没有首个 commit 时是空树。 */
  head(): Promise<string>;
  /** 工作区里参与统计的文件（已跟踪 + 未忽略的新文件）。 */
  files(): Promise<string[]>;
  /** 已跟踪路径，用来区分「新建」和「修改」。 */
  trackedPaths(): Promise<Set<string>>;
  /** 工作区当前的依赖名集合。 */
  dependencies(): Promise<Set<string>>;
  /** 读取工作区内的文本文件；越界、不存在或二进制返回 null。 */
  readText(relativePath: string): Promise<string | null>;
};

export function createScanContext(directory: string): ScanContext {
  const run = (args: string[]) => runGit(directory, args);
  const root = `${resolve(directory)}${sep}`.toLowerCase();

  const readText = async (relativePath: string): Promise<string | null> => {
    const absolute = resolve(directory, ...normalizePath(relativePath).split("/"));
    if (!absolute.toLowerCase().startsWith(root)) return null;
    let buffer: Buffer;
    try {
      buffer = await readFile(absolute);
    } catch {
      return null;
    }
    return buffer.includes(0) ? null : buffer.toString("utf8");
  };

  const files = memoize(async () =>
    (await run(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]))
      .split("\0")
      .map(normalizePath)
      .filter((path) => path && included(path)),
  );

  const trackedPaths = memoize(
    async () => new Set((await run(["ls-files", "--cached", "-z"])).split("\0").map(normalizePath)),
  );

  const head = memoize(async () => {
    try {
      return await run(["rev-parse", "HEAD"]);
    } catch (error) {
      if ((await run(["rev-parse", "--is-inside-work-tree"])) === "true") return EMPTY_TREE;
      throw error;
    }
  });

  const dependencies = memoize(async () => {
    const manifests = (await files()).filter((path) => path.endsWith("package.json"));
    const result = new Set<string>();
    await mapLimited(manifests, READ_CONCURRENCY, async (path) => {
      const content = await readText(path);
      if (content)
        for (const dependency of dependencyNamesFromJson(content)) result.add(dependency);
    });
    return result;
  });

  return { directory, run, head, files, trackedPaths, dependencies, readText };
}
