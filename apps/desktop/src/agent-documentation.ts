import { copyFileSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  AGENT_GUIDE_FILENAME,
  assertAgentDocumentationManifest,
  buildAgentDocumentationManifest,
  buildAgentDocumentationManifestFromPaths,
  type AgentDocumentationComponentPaths,
} from "./agent-documentation-manifest.js";

export {
  AGENT_GUIDE_FILENAME,
  assertAgentDocumentationManifest,
  buildAgentDocumentationManifest,
  compareAgentDocumentationManifests,
  type AgentDocumentationComponentPaths,
  type AgentDocumentationLayout,
  type AgentDocumentationManifest,
  type AgentDocumentationManifestEntry,
  type AgentDocumentationManifestMismatch,
} from "./agent-documentation-manifest.js";

type InstallationComponent = Readonly<{
  name: "guide" | "docs" | "skills";
  targetPath: string;
  stagePath: string;
  backupPath: string;
  committedBackupPath: string;
}>;

export type AgentDocumentationFs = Readonly<{
  copyFile(source: string, target: string): void;
  rename(source: string, target: string): void;
  remove(path: string): void;
}>;

export type AgentDocumentationTestOptions = Readonly<{
  /** @internal deterministic filesystem seam for focused tests only. */
  fs?: Partial<AgentDocumentationFs>;
  /** @internal bounded retry delay override for focused tests only. */
  retryDelayMs?: number;
  /** @internal bounded retry attempt override for focused tests only. */
  retryAttempts?: number;
}>;

type RetryConfig = Readonly<{
  delayMs: number;
  attempts: number;
}>;

type RollbackState = {
  attempted: string[];
  succeeded: string[];
  failed: string[];
};

const MAX_FS_RETRY_ATTEMPTS = 4;
const FS_RETRY_DELAY_MS = 25;
const MAX_ROLLBACK_STATUS_ITEMS = 16;
const MAX_STALE_ARTIFACTS = 64;
const RETRYABLE_FS_CODES = new Set(["EACCES", "EBUSY", "ENOTEMPTY", "EPERM"]);
const ARTIFACT_NAME_PATTERN =
  /^(ATM_AGENT_GUIDE\.md|docs|skills)\.(staging|backup|backup-committed)-([a-f0-9]{16})$/u;

const productionFs: AgentDocumentationFs = {
  copyFile: copyFileSync,
  rename: renameSync,
  remove: (path) => rmSync(path, { recursive: true, force: true }),
};

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

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

function fsErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function boundedRetryConfig(options?: AgentDocumentationTestOptions): RetryConfig {
  const requestedAttempts = options?.retryAttempts;
  const requestedDelay = options?.retryDelayMs;
  const attempts = Number.isFinite(requestedAttempts)
    ? Math.min(MAX_FS_RETRY_ATTEMPTS, Math.max(1, Math.trunc(requestedAttempts ?? 1)))
    : MAX_FS_RETRY_ATTEMPTS;
  const delayMs = Number.isFinite(requestedDelay)
    ? Math.min(FS_RETRY_DELAY_MS, Math.max(0, Math.trunc(requestedDelay ?? 0)))
    : FS_RETRY_DELAY_MS;
  return { attempts, delayMs };
}

function waitForFsRetry(delayMs: number): void {
  if (delayMs <= 0) return;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, delayMs);
}

function withBoundedFsRetry<T>(operation: () => T, config: RetryConfig): T {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (attempt >= config.attempts || !RETRYABLE_FS_CODES.has(fsErrorCode(error) ?? "")) {
        throw error;
      }
      waitForFsRetry(config.delayMs);
    }
  }
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const compact = message.replace(/\s+/gu, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

function recordRollbackAttempt(state: RollbackState, label: string, operation: () => void): void {
  if (state.attempted.length < MAX_ROLLBACK_STATUS_ITEMS) state.attempted.push(label);
  try {
    operation();
    if (state.succeeded.length < MAX_ROLLBACK_STATUS_ITEMS) state.succeeded.push(label);
  } catch (error) {
    if (state.failed.length < MAX_ROLLBACK_STATUS_ITEMS) {
      state.failed.push(`${label}:${shortError(error)}`);
    }
  }
}

function errorWithRollbackState(error: unknown, state: RollbackState): Error {
  const original = error instanceof Error ? error : new Error(String(error));
  const rollback = `rollback attempted=${state.attempted.length},succeeded=${state.succeeded.length},failed=${state.failed.length}`;
  if (state.failed.length > 0) {
    original.message = `${original.message} [${rollback}; failures=${state.failed
      .slice(0, 4)
      .join("|")}]`;
  } else {
    original.message = `${original.message} [${rollback}]`;
  }
  Object.defineProperty(original, "rollback", {
    configurable: true,
    enumerable: false,
    value: {
      attempted: [...state.attempted],
      succeeded: [...state.succeeded],
      failed: [...state.failed],
    },
    writable: false,
  });
  return original;
}

function assertOwnedPackagePath(dataDir: string, path: string): void {
  const parent = resolve(dataDir);
  const candidate = resolve(path);
  if (dirname(candidate) !== parent) {
    throw new Error(`AGENT_DOCUMENTATION_CLEANUP_OUTSIDE_DATA_DIR: ${path}`);
  }
  const name = candidate.slice(parent.length + 1);
  if (![AGENT_GUIDE_FILENAME, "docs", "skills"].includes(name)) {
    throw new Error(`AGENT_DOCUMENTATION_CLEANUP_TARGET_INVALID: ${path}`);
  }
}

function assertOwnedArtifactPath(dataDir: string, path: string): void {
  const parent = resolve(dataDir);
  const candidate = resolve(path);
  if (dirname(candidate) !== parent) {
    throw new Error(`AGENT_DOCUMENTATION_CLEANUP_OUTSIDE_DATA_DIR: ${path}`);
  }
  const name = candidate.slice(parent.length + 1);
  if (
    !/^(?:docs|skills)\.(?:staging|backup|backup-committed)-[a-f0-9]{16}$/u.test(name) &&
    !/^ATM_AGENT_GUIDE\.md\.(?:staging|backup|backup-committed)-[a-f0-9]{16}$/u.test(name)
  ) {
    throw new Error(`AGENT_DOCUMENTATION_CLEANUP_TARGET_INVALID: ${path}`);
  }
}

function assertOwnedPath(dataDir: string, path: string): void {
  try {
    assertOwnedPackagePath(dataDir, path);
    return;
  } catch {
    assertOwnedArtifactPath(dataDir, path);
  }
}

function copyToOwnedArtifact(
  dataDir: string,
  source: string,
  target: string,
  fs: AgentDocumentationFs,
): void {
  assertOwnedArtifactPath(dataDir, target);
  fs.copyFile(source, target);
}

function renameOwned(
  dataDir: string,
  source: string,
  target: string,
  fs: AgentDocumentationFs,
  retry: RetryConfig,
): void {
  assertOwnedPath(dataDir, source);
  assertOwnedPath(dataDir, target);
  withBoundedFsRetry(() => fs.rename(source, target), retry);
}

function cleanupOwnedArtifact(
  dataDir: string,
  path: string,
  fs: AgentDocumentationFs,
  retry: RetryConfig,
): void {
  assertOwnedArtifactPath(dataDir, path);
  withBoundedFsRetry(() => fs.remove(path), retry);
}

function cleanupOwnedPackagePath(
  dataDir: string,
  path: string,
  fs: AgentDocumentationFs,
  retry: RetryConfig,
): void {
  assertOwnedPackagePath(dataDir, path);
  withBoundedFsRetry(() => fs.remove(path), retry);
}

function removeInstalledForRollback(
  dataDir: string,
  component: InstallationComponent,
  fs: AgentDocumentationFs,
  retry: RetryConfig,
): void {
  try {
    if (pathExists(component.targetPath)) {
      cleanupOwnedPackagePath(dataDir, component.targetPath, fs, retry);
    }
  } catch (error) {
    // If an antivirus briefly holds the target, move it into this transaction's
    // already-owned staging name so the backup can still be restored. The
    // original remove error is rethrown for the bounded rollback report.
    if (pathExists(component.targetPath) && !pathExists(component.stagePath)) {
      renameOwned(dataDir, component.targetPath, component.stagePath, fs, retry);
    }
    throw error;
  }
}

function assertOwnedDescendant(root: string, path: string): void {
  const relativePath = relative(resolve(root), resolve(path));
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`AGENT_DOCUMENTATION_CLEANUP_OUTSIDE_STAGING: ${path}`);
  }
}

function copyTree(
  dataDir: string,
  source: string,
  target: string,
  fs: AgentDocumentationFs,
  stagingRoot = target,
): void {
  requireDirectory(source, "AGENT_DOCUMENTATION_SOURCE");
  if (stagingRoot === target) assertOwnedArtifactPath(dataDir, target);
  else assertOwnedDescendant(stagingRoot, target);
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`AGENT_DOCUMENTATION_SYMLINK_UNSUPPORTED: ${sourcePath}`);
    }
    if (entry.isDirectory()) {
      copyTree(dataDir, sourcePath, targetPath, fs, stagingRoot);
    } else if (entry.isFile()) {
      assertOwnedDescendant(stagingRoot, targetPath);
      fs.copyFile(sourcePath, targetPath);
    } else {
      throw new Error(`AGENT_DOCUMENTATION_ENTRY_UNSUPPORTED: ${sourcePath}`);
    }
  }
}

type StaleArtifact = Readonly<{
  kind: "staging" | "backup" | "backup-committed";
  name: "guide" | "docs" | "skills";
  nonce: string;
  path: string;
}>;

function parseStaleArtifact(dataDir: string, name: string): StaleArtifact | null {
  const match = ARTIFACT_NAME_PATTERN.exec(name);
  if (!match) return null;
  const componentName = match[1] === AGENT_GUIDE_FILENAME ? "guide" : match[1];
  if (componentName !== "guide" && componentName !== "docs" && componentName !== "skills") {
    return null;
  }
  return {
    kind: match[2] as StaleArtifact["kind"],
    name: componentName,
    nonce: match[3]!,
    path: join(dataDir, name),
  };
}

function artifactTargetPath(dataDir: string, name: StaleArtifact["name"]): string {
  return join(dataDir, name === "guide" ? AGENT_GUIDE_FILENAME : name);
}

function safeDocumentationTree(path: string): boolean {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch {
    return false;
  }
  if (stats.isSymbolicLink()) return false;
  if (stats.isFile()) return true;
  if (!stats.isDirectory()) return false;
  return readdirSync(path, { withFileTypes: true }).every((entry) =>
    safeDocumentationTree(join(path, entry.name)),
  );
}

function liveTargetReady(dataDir: string, name: StaleArtifact["name"]): boolean {
  const path = artifactTargetPath(dataDir, name);
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch {
    return false;
  }
  if (stats.isSymbolicLink()) return false;
  if (name === "guide") return stats.isFile();
  return stats.isDirectory() && safeDocumentationTree(path);
}

function reconcileStaleArtifacts(
  dataDir: string,
  fs: AgentDocumentationFs,
  retry: RetryConfig,
): void {
  const artifacts = readdirSync(dataDir, { withFileTypes: true })
    .map((entry) => parseStaleArtifact(dataDir, entry.name))
    .filter((artifact): artifact is StaleArtifact => artifact !== null)
    .sort((left, right) => left.path.localeCompare(right.path))
    .slice(0, MAX_STALE_ARTIFACTS);
  const backups = artifacts.filter((artifact) => artifact.kind === "backup");
  const committedBackups = artifacts.filter((artifact) => artifact.kind === "backup-committed");
  const staging = artifacts.filter((artifact) => artifact.kind === "staging");

  for (const artifact of backups) {
    const target = artifactTargetPath(dataDir, artifact.name);
    const stage = join(
      dataDir,
      `${artifact.name === "guide" ? AGENT_GUIDE_FILENAME : artifact.name}.staging-${artifact.nonce}`,
    );
    if (!safeDocumentationTree(artifact.path)) continue;
    try {
      if (pathExists(target)) {
        if (pathExists(stage)) cleanupOwnedArtifact(dataDir, stage, fs, retry);
        renameOwned(dataDir, target, stage, fs, retry);
      }
      renameOwned(dataDir, artifact.path, target, fs, retry);
      if (pathExists(stage)) cleanupOwnedArtifact(dataDir, stage, fs, retry);
    } catch {
      // This is an interrupted/failed rollback. Preserve the old backup until
      // it can atomically replace the mixed live component on a later startup.
    }
  }
  for (const artifact of committedBackups) {
    const target = artifactTargetPath(dataDir, artifact.name);
    try {
      if (!liveTargetReady(dataDir, artifact.name) && !pathExists(target)) {
        if (safeDocumentationTree(artifact.path)) {
          renameOwned(dataDir, artifact.path, target, fs, retry);
          continue;
        }
      }
      cleanupOwnedArtifact(dataDir, artifact.path, fs, retry);
    } catch {
      // A committed but locked backup remains eligible for next-start cleanup.
    }
  }
  for (const artifact of staging) {
    try {
      cleanupOwnedArtifact(dataDir, artifact.path, fs, retry);
    } catch {
      // A locked artifact is retained and remains eligible for the next startup.
    }
  }
}

function makeInstallationComponents(dataDir: string, nonce: string): InstallationComponent[] {
  const targets = {
    guide: join(dataDir, AGENT_GUIDE_FILENAME),
    docs: join(dataDir, "docs"),
    skills: join(dataDir, "skills"),
  } as const;
  return (["guide", "docs", "skills"] as const).map((name) => ({
    name,
    targetPath: targets[name],
    stagePath: join(dataDir, `${name === "guide" ? AGENT_GUIDE_FILENAME : name}.staging-${nonce}`),
    backupPath: join(dataDir, `${name === "guide" ? AGENT_GUIDE_FILENAME : name}.backup-${nonce}`),
    committedBackupPath: join(
      dataDir,
      `${name === "guide" ? AGENT_GUIDE_FILENAME : name}.backup-committed-${nonce}`,
    ),
  }));
}

function pathsFromComponents(
  components: readonly InstallationComponent[],
  field: "targetPath" | "stagePath",
): AgentDocumentationComponentPaths {
  const get = (name: InstallationComponent["name"]): string => {
    const component = components.find((item) => item.name === name);
    if (!component) throw new Error("AGENT_DOCUMENTATION_COMPONENTS_MISSING");
    return component[field];
  };
  return { guidePath: get("guide"), docsPath: get("docs"), skillsPath: get("skills") };
}

function installAgentDocumentationInternal(
  bundledRoot: string,
  dataDir: string,
  options?: AgentDocumentationTestOptions,
): {
  guidePath: string;
  docsPath: string;
  skillsPath: string;
} {
  const fs: AgentDocumentationFs = { ...productionFs, ...(options?.fs ?? {}) };
  const retry = boundedRetryConfig(options);
  const expected = buildAgentDocumentationManifest(bundledRoot, "bundled");
  mkdirSync(dataDir, { recursive: true });
  requireDirectory(dataDir, "AGENT_DATA_DIR");
  reconcileStaleArtifacts(dataDir, fs, retry);
  const components = makeInstallationComponents(dataDir, randomBytes(8).toString("hex"));
  for (const component of components) {
    if (pathExists(component.stagePath) || pathExists(component.backupPath)) {
      throw new Error("AGENT_DOCUMENTATION_TRANSACTION_COLLISION");
    }
  }

  const movedToBackup: InstallationComponent[] = [];
  const installed: InstallationComponent[] = [];
  try {
    const guide = components.find((component) => component.name === "guide");
    const docs = components.find((component) => component.name === "docs");
    const skills = components.find((component) => component.name === "skills");
    if (!guide || !docs || !skills) throw new Error("AGENT_DOCUMENTATION_COMPONENTS_MISSING");
    copyToOwnedArtifact(dataDir, join(bundledRoot, AGENT_GUIDE_FILENAME), guide.stagePath, fs);
    copyTree(dataDir, join(bundledRoot, "docs"), docs.stagePath, fs);
    copyTree(dataDir, join(bundledRoot, "integrations", "skills"), skills.stagePath, fs);
    assertAgentDocumentationManifest(
      expected,
      buildAgentDocumentationManifestFromPaths(pathsFromComponents(components, "stagePath")),
    );

    for (const component of components) {
      if (pathExists(component.targetPath)) {
        renameOwned(dataDir, component.targetPath, component.backupPath, fs, retry);
        movedToBackup.push(component);
      }
    }
    for (const component of components) {
      renameOwned(dataDir, component.stagePath, component.targetPath, fs, retry);
      installed.push(component);
    }
    assertAgentDocumentationManifest(
      expected,
      buildAgentDocumentationManifestFromPaths(pathsFromComponents(components, "targetPath")),
    );
  } catch (error) {
    const rollback: RollbackState = { attempted: [], succeeded: [], failed: [] };
    for (const component of installed) {
      recordRollbackAttempt(rollback, `remove-installed:${component.name}`, () => {
        removeInstalledForRollback(dataDir, component, fs, retry);
      });
    }
    for (const component of [...movedToBackup].reverse()) {
      recordRollbackAttempt(rollback, `restore-backup:${component.name}`, () => {
        if (pathExists(component.targetPath)) throw new Error("ROLLBACK_TARGET_PRESENT");
        if (!pathExists(component.backupPath)) throw new Error("ROLLBACK_BACKUP_MISSING");
        renameOwned(dataDir, component.backupPath, component.targetPath, fs, retry);
      });
    }
    for (const component of components) {
      recordRollbackAttempt(rollback, `remove-stage:${component.name}`, () => {
        if (pathExists(component.stagePath)) {
          cleanupOwnedArtifact(dataDir, component.stagePath, fs, retry);
        }
      });
    }
    throw errorWithRollbackState(error, rollback);
  }

  for (const component of movedToBackup) {
    try {
      renameOwned(dataDir, component.backupPath, component.committedBackupPath, fs, retry);
      cleanupOwnedArtifact(dataDir, component.committedBackupPath, fs, retry);
    } catch {
      // A failed state transition remains a conservative rollback backup; a
      // committed backup that cannot be cleaned is safe to reclaim next start.
    }
  }
  const paths = pathsFromComponents(components, "targetPath");
  return paths;
}

export function installAgentDocumentation(
  bundledRoot: string,
  dataDir: string,
): {
  guidePath: string;
  docsPath: string;
  skillsPath: string;
} {
  return installAgentDocumentationInternal(bundledRoot, dataDir);
}

/** @internal Test-only deterministic filesystem seam; production uses the real filesystem. */
export function installAgentDocumentationForTests(
  bundledRoot: string,
  dataDir: string,
  options: AgentDocumentationTestOptions = {},
): {
  guidePath: string;
  docsPath: string;
  skillsPath: string;
} {
  return installAgentDocumentationInternal(bundledRoot, dataDir, options);
}
