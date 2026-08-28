import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";

export const AGENT_GUIDE_FILENAME = "ATM_AGENT_GUIDE.md";

export type AgentDocumentationManifestEntry = Readonly<{
  path: string;
  bytes: number;
  sha256: string;
}>;

export type AgentDocumentationManifest = Readonly<{
  version: 1;
  entries: readonly AgentDocumentationManifestEntry[];
}>;

export type AgentDocumentationLayout = "bundled" | "installed";

export type AgentDocumentationManifestMismatch = Readonly<{
  kind: "missing" | "extra" | "content";
  path: string;
  expected?: AgentDocumentationManifestEntry;
  actual?: AgentDocumentationManifestEntry;
}>;

export type AgentDocumentationComponentPaths = Readonly<{
  guidePath: string;
  docsPath: string;
  skillsPath: string;
}>;

function requireDirectory(path: string, label: string): void {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch {
    throw new Error(`${label}_MISSING: ${path}`);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label}_INVALID: ${path}`);
  }
}

function requireFile(path: string, label: string): void {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch {
    throw new Error(`${label}_MISSING: ${path}`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${label}_INVALID: ${path}`);
  }
}

function relativeManifestPath(root: string, path: string): string {
  const rootPath = resolve(root);
  const pathPath = resolve(path);
  const value = relative(rootPath, pathPath);
  if (!value || value === ".." || value.startsWith(`..${sep}`)) {
    throw new Error(`AGENT_DOCUMENTATION_PATH_INVALID: ${path}`);
  }
  return value.split(sep).join("/");
}

function collectFiles(root: string, current: string, result: string[]): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`AGENT_DOCUMENTATION_SYMLINK_UNSUPPORTED: ${path}`);
    }
    if (entry.isDirectory()) {
      collectFiles(root, path, result);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`AGENT_DOCUMENTATION_ENTRY_UNSUPPORTED: ${path}`);
    }
    result.push(relativeManifestPath(root, path));
  }
}

function hashFile(path: string): Omit<AgentDocumentationManifestEntry, "path"> {
  const content = readFileSync(path);
  return {
    bytes: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

export function buildAgentDocumentationManifestFromPaths(
  paths: AgentDocumentationComponentPaths,
): AgentDocumentationManifest {
  requireFile(paths.guidePath, "AGENT_GUIDE");
  requireDirectory(paths.docsPath, "AGENT_DOCS");
  requireDirectory(paths.skillsPath, "AGENT_SKILLS");

  const entries: AgentDocumentationManifestEntry[] = [
    { ...hashFile(paths.guidePath), path: AGENT_GUIDE_FILENAME },
  ];
  const docsFiles: string[] = [];
  collectFiles(paths.docsPath, paths.docsPath, docsFiles);
  for (const relativePath of docsFiles) {
    entries.push({
      ...hashFile(join(paths.docsPath, relativePath.replaceAll("/", sep))),
      path: `docs/${relativePath}`,
    });
  }

  const skillsFiles: string[] = [];
  collectFiles(paths.skillsPath, paths.skillsPath, skillsFiles);
  for (const relativePath of skillsFiles) {
    entries.push({
      ...hashFile(join(paths.skillsPath, relativePath.replaceAll("/", sep))),
      path: `skills/${relativePath}`,
    });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return { version: 1, entries };
}

/** Computes a stable, non-generated manifest for package-owned Agent files. */
export function buildAgentDocumentationManifest(
  root: string,
  layout: AgentDocumentationLayout,
): AgentDocumentationManifest {
  return buildAgentDocumentationManifestFromPaths({
    guidePath: join(root, AGENT_GUIDE_FILENAME),
    docsPath: join(root, "docs"),
    skillsPath: join(root, ...(layout === "bundled" ? ["integrations", "skills"] : ["skills"])),
  });
}

export function compareAgentDocumentationManifests(
  expected: AgentDocumentationManifest,
  actual: AgentDocumentationManifest,
): AgentDocumentationManifestMismatch[] {
  const expectedByPath = new Map(expected.entries.map((entry) => [entry.path, entry]));
  const actualByPath = new Map(actual.entries.map((entry) => [entry.path, entry]));
  const paths = new Set([...expectedByPath.keys(), ...actualByPath.keys()]);
  const mismatches: AgentDocumentationManifestMismatch[] = [];
  for (const path of [...paths].sort()) {
    const expectedEntry = expectedByPath.get(path);
    const actualEntry = actualByPath.get(path);
    if (!expectedEntry) {
      if (!actualEntry) throw new Error(`AGENT_DOCUMENTATION_MANIFEST_INVALID: ${path}`);
      mismatches.push({ kind: "extra", path, actual: actualEntry });
    } else if (!actualEntry) {
      mismatches.push({ kind: "missing", path, expected: expectedEntry });
    } else if (
      expectedEntry.bytes !== actualEntry.bytes ||
      expectedEntry.sha256 !== actualEntry.sha256
    ) {
      mismatches.push({ kind: "content", path, expected: expectedEntry, actual: actualEntry });
    }
  }
  return mismatches;
}

export function assertAgentDocumentationManifest(
  expected: AgentDocumentationManifest,
  actual: AgentDocumentationManifest,
): void {
  const mismatches = compareAgentDocumentationManifests(expected, actual);
  if (mismatches.length === 0) return;
  const summary = mismatches
    .slice(0, 8)
    .map((mismatch) => `${mismatch.kind}:${mismatch.path}`)
    .join(",");
  const suffix = mismatches.length > 8 ? `,+${mismatches.length - 8}` : "";
  throw new Error(`AGENT_DOCUMENTATION_MANIFEST_MISMATCH: ${summary}${suffix}`);
}
