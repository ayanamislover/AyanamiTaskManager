import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

type MigrationResult = {
  source: string;
  destination: string;
  destinationBackup: string | null;
  projects: number;
  executed: boolean;
};

type MigrationManifest = Omit<MigrationResult, "executed"> & {
  format: 1;
  migratedAt: string;
};

export type MigrationStage =
  | "AFTER_COPY"
  | "AFTER_MANIFEST"
  | "BEFORE_BACKUP_RUNTIME_SCRUB"
  | "AFTER_BACKUP"
  | "AFTER_COMMIT";

function assertSafeRoots(source: string, destination: string): void {
  if (source.toLowerCase() === destination.toLowerCase()) throw new Error("DATA_ROOTS_MUST_DIFFER");
  if ([source, destination].some((candidate) => dirname(candidate) === candidate))
    throw new Error("DATA_ROOT_TOO_BROAD");
  const sourceToDestination = relative(source, destination);
  const destinationToSource = relative(destination, source);
  if (
    (sourceToDestination &&
      !sourceToDestination.startsWith("..") &&
      !isAbsolute(sourceToDestination)) ||
    (destinationToSource &&
      !destinationToSource.startsWith("..") &&
      !isAbsolute(destinationToSource))
  )
    throw new Error("DATA_ROOTS_MUST_NOT_NEST");
}

async function canonicalDataRoot(path: string): Promise<string> {
  let existing = path;
  const missingSegments: string[] = [];
  let entry: Awaited<ReturnType<typeof lstat>> | null = null;
  while (!entry) {
    try {
      entry = await lstat(existing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (entry) break;
    const parent = dirname(existing);
    if (parent === existing) throw new Error("DATA_ROOT_PARENT_MISSING");
    missingSegments.unshift(basename(existing));
    existing = parent;
  }
  if (existing === path && entry.isSymbolicLink()) throw new Error("DATA_ROOT_LINK_NOT_ALLOWED");
  return resolve(await realpath(existing), ...missingSegments);
}

function runtimeStatePresent(root: string): boolean {
  return (
    existsSync(join(root, "runtime", "daemon.json")) ||
    existsSync(join(root, "runtime", "local.token"))
  );
}

async function assertRuntimeDirectorySafe(root: string): Promise<void> {
  const runtimePath = join(root, "runtime");
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(runtimePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (entry.isSymbolicLink()) throw new Error("DATA_ROOT_RUNTIME_LINK_NOT_ALLOWED");
  if (!entry.isDirectory()) throw new Error("DATA_ROOT_RUNTIME_INVALID");
}

async function scrubRuntimeState(
  root: string,
  onStage?: (stage: MigrationStage) => void | Promise<void>,
): Promise<void> {
  await onStage?.("BEFORE_BACKUP_RUNTIME_SCRUB");
  await assertRuntimeDirectorySafe(root);
  await rm(join(root, "runtime", "daemon.json"), { force: true });
  await rm(join(root, "runtime", "local.token"), { force: true });
}

function quickCheck(path: string): void {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const result = database.pragma("quick_check") as Array<Record<string, unknown>>;
    if (result.length !== 1 || Object.values(result[0] ?? {})[0] !== "ok")
      throw new Error(`SQLITE_QUICK_CHECK_FAILED:${path}`);
  } finally {
    database.close();
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireMigrationLock(destination: string): Promise<() => Promise<void>> {
  const lockPath = join(dirname(destination), `.${basename(destination)}.migration.lock`);
  const nonce = randomBytes(16).toString("hex");
  const content = `${JSON.stringify({ pid: process.pid, nonce })}\n`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(content, "utf8");
      } finally {
        await handle.close();
      }
      return async () => {
        try {
          if ((await readFile(lockPath, "utf8")) === content) await rm(lockPath, { force: true });
        } catch {
          // A successor or prior cleanup owns the path; never unlink blindly.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw new Error("MIGRATION_LOCK_FAILED");
    }
    let ownerPid = 0;
    try {
      const owner = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
      if (Number.isSafeInteger(owner.pid)) ownerPid = Number(owner.pid);
    } catch {
      // Malformed lock content is stale and is quarantined below.
    }
    if (ownerPid > 0 && processAlive(ownerPid)) throw new Error("MIGRATION_IN_PROGRESS");
    const stalePath = `${lockPath}.stale-${process.pid}-${nonce}-${attempt}`;
    try {
      await rename(lockPath, stalePath);
      await rm(stalePath, { force: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EEXIST") throw new Error("MIGRATION_LOCK_FAILED");
    }
  }
  throw new Error("MIGRATION_LOCK_FAILED");
}

async function readMigrationManifest(root: string): Promise<MigrationManifest | null> {
  try {
    const value = JSON.parse(
      await readFile(join(root, "migration-manifest.json"), "utf8"),
    ) as Partial<MigrationManifest> | null;
    if (
      value?.format !== 1 ||
      typeof value.migratedAt !== "string" ||
      typeof value.source !== "string" ||
      typeof value.destination !== "string" ||
      (value.destinationBackup !== null && typeof value.destinationBackup !== "string") ||
      !Number.isSafeInteger(value.projects) ||
      Number(value.projects) <= 0
    )
      return null;
    return value as MigrationManifest;
  } catch {
    return null;
  }
}

function projectPaths(registryPath: string): Array<{ db_path: string | null }> {
  const database = new Database(registryPath, { readonly: true, fileMustExist: true });
  try {
    return database.prepare("SELECT db_path FROM projects").all() as Array<{
      db_path: string | null;
    }>;
  } finally {
    database.close();
  }
}

async function completedMigration(
  source: string,
  destination: string,
): Promise<MigrationResult | null> {
  const manifest = await readMigrationManifest(destination);
  if (!manifest) return null;
  if (resolve(manifest.source) !== source || resolve(manifest.destination) !== destination)
    throw new Error("MIGRATION_MANIFEST_MISMATCH");
  const registryPath = join(destination, "registry", "registry.sqlite");
  quickCheck(registryPath);
  const projects = projectPaths(registryPath);
  if (projects.length !== manifest.projects) throw new Error("MIGRATION_MANIFEST_MISMATCH");
  for (const project of projects) if (project.db_path) quickCheck(project.db_path);
  for (const root of [destination, manifest.destinationBackup])
    if (root && existsSync(root)) {
      await assertRuntimeDirectorySafe(root);
      if (!runtimeStatePresent(root)) continue;
      throw new Error("MIGRATION_RUNTIME_STATE_PRESENT");
    }
  return {
    source,
    destination,
    destinationBackup: manifest.destinationBackup,
    projects: manifest.projects,
    executed: true,
  };
}

async function assertSourceStopped(source: string): Promise<void> {
  const runtimePath = join(source, "runtime", "daemon.json");
  if (!existsSync(runtimePath)) return;
  try {
    const runtime = JSON.parse(await readFile(runtimePath, "utf8")) as { pid?: unknown };
    if (typeof runtime.pid === "number" && processAlive(runtime.pid))
      throw new Error(`SOURCE_DAEMON_STILL_RUNNING:${runtime.pid}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("SOURCE_DAEMON_STILL_RUNNING"))
      throw error;
  }
}

function rewritePath(value: string, source: string, destination: string): string {
  const candidate = resolve(value);
  const relativePath = relative(source, candidate);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) return value;
  return join(destination, relativePath);
}

function rewriteRegistryPaths(registryPath: string, source: string, destination: string): number {
  const database = new Database(registryPath);
  try {
    const projects = database.prepare("SELECT id, db_path FROM projects").all() as Array<{
      id: string;
      db_path: string | null;
    }>;
    const backups = database.prepare("SELECT id, path FROM backup_catalog").all() as Array<{
      id: string;
      path: string;
    }>;
    const updateProject = database.prepare("UPDATE projects SET db_path = ? WHERE id = ?");
    const updateBackup = database.prepare("UPDATE backup_catalog SET path = ? WHERE id = ?");
    database.transaction(() => {
      for (const project of projects)
        if (project.db_path)
          updateProject.run(rewritePath(project.db_path, source, destination), project.id);
      for (const backup of backups)
        updateBackup.run(rewritePath(backup.path, source, destination), backup.id);
    })();
    return projects.length;
  } finally {
    database.close();
  }
}

async function copyableDataRootEntry(path: string, sourceRoot: string): Promise<boolean> {
  if (path === sourceRoot) return true;
  return !(await lstat(path)).isSymbolicLink();
}

export async function migrateDataRoot(input: {
  source: string;
  destination: string;
  execute?: boolean;
  timestamp?: string;
  onStage?: (stage: MigrationStage) => void | Promise<void>;
}): Promise<MigrationResult> {
  if (!isAbsolute(input.source) || !isAbsolute(input.destination))
    throw new Error("DATA_ROOT_MUST_BE_ABSOLUTE");
  const source = await canonicalDataRoot(resolve(input.source));
  const destination = await canonicalDataRoot(resolve(input.destination));
  assertSafeRoots(source, destination);
  await assertRuntimeDirectorySafe(source);
  if (existsSync(destination)) await assertRuntimeDirectorySafe(destination);
  const alreadyCompleted = await completedMigration(source, destination);
  if (alreadyCompleted) return alreadyCompleted;
  const sourceRegistry = join(source, "registry", "registry.sqlite");
  if (!existsSync(sourceRegistry)) throw new Error("SOURCE_REGISTRY_MISSING");
  quickCheck(sourceRegistry);
  const sourceDb = new Database(sourceRegistry, { readonly: true, fileMustExist: true });
  const sourceProjects = Number(
    (sourceDb.prepare("SELECT count(*) AS count FROM projects").get() as { count: number }).count,
  );
  sourceDb.close();
  if (sourceProjects === 0) throw new Error("SOURCE_HAS_NO_PROJECTS");

  const stamp = (input.timestamp ?? new Date().toISOString()).replace(/[:.]/gu, "-");
  const proposedBackup = existsSync(destination)
    ? join(dirname(destination), `${basename(destination)}-before-migration-${stamp}`)
    : null;
  if (!input.execute)
    return {
      source,
      destination,
      destinationBackup: proposedBackup,
      projects: sourceProjects,
      executed: false,
    };

  const releaseLock = await acquireMigrationLock(destination);
  try {
    const completedInsideLock = await completedMigration(source, destination);
    if (completedInsideLock) return completedInsideLock;
    await assertSourceStopped(source);
    const destinationRegistry = join(destination, "registry", "registry.sqlite");
    if (existsSync(destinationRegistry)) {
      quickCheck(destinationRegistry);
      if (projectPaths(destinationRegistry).length > 0)
        throw new Error("DESTINATION_ALREADY_HAS_PROJECTS");
    }

    const staging = join(dirname(destination), `${basename(destination)}-migrating`);
    let stagedManifest = existsSync(staging) ? await readMigrationManifest(staging) : null;
    if (
      stagedManifest &&
      (resolve(stagedManifest.source) !== source ||
        resolve(stagedManifest.destination) !== destination ||
        stagedManifest.projects !== sourceProjects)
    )
      stagedManifest = null;
    if (!stagedManifest) {
      if (existsSync(staging)) await rm(staging, { recursive: true, force: true });
      await cp(source, staging, {
        recursive: true,
        errorOnExist: true,
        force: false,
        filter: (sourcePath) => copyableDataRootEntry(sourcePath, source),
      });
      await input.onStage?.("AFTER_COPY");
      const stagedRegistry = join(staging, "registry", "registry.sqlite");
      rewriteRegistryPaths(stagedRegistry, source, destination);
      await mkdir(join(staging, "runtime"), { recursive: true });
      await rm(join(staging, "runtime", "daemon.json"), { force: true });
      await rm(join(staging, "runtime", "local.token"), { force: true });
      quickCheck(stagedRegistry);
      for (const project of projectPaths(stagedRegistry))
        if (project.db_path) quickCheck(rewritePath(project.db_path, destination, staging));
      stagedManifest = {
        format: 1,
        migratedAt: new Date().toISOString(),
        source,
        destination,
        destinationBackup: proposedBackup,
        projects: sourceProjects,
      };
      await writeFile(
        join(staging, "migration-manifest.json"),
        `${JSON.stringify(stagedManifest, null, 2)}\n`,
        "utf8",
      );
    }
    await input.onStage?.("AFTER_MANIFEST");

    const destinationBackup = stagedManifest.destinationBackup;
    if (destinationBackup && existsSync(destinationBackup) && !existsSync(destination)) {
      await scrubRuntimeState(destinationBackup, input.onStage);
    }
    if (destinationBackup && existsSync(destination)) {
      if (existsSync(destinationBackup)) throw new Error("MIGRATION_TARGET_ALREADY_EXISTS");
      await rename(destination, destinationBackup);
      await scrubRuntimeState(destinationBackup, input.onStage);
      await input.onStage?.("AFTER_BACKUP");
    }
    try {
      await rename(staging, destination);
    } catch (error) {
      if (destinationBackup && !existsSync(destination) && existsSync(destinationBackup))
        await rename(destinationBackup, destination);
      throw error;
    }
    await input.onStage?.("AFTER_COMMIT");
    const committed = await completedMigration(source, destination);
    if (!committed) throw new Error("MIGRATION_COMMIT_INCOMPLETE");
    return committed;
  } finally {
    await releaseLock();
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const source = argument("--source");
  const destination = argument("--destination");
  if (!source || !destination)
    throw new Error("用法：--source <绝对路径> --destination <绝对路径> [--execute]");
  migrateDataRoot({ source, destination, execute: process.argv.includes("--execute") }).then(
    (result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
  );
}
