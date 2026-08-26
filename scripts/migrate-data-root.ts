import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

function assertSafeRoots(source: string, destination: string): void {
  if (!isAbsolute(source) || !isAbsolute(destination))
    throw new Error("DATA_ROOT_MUST_BE_ABSOLUTE");
  if (source.toLowerCase() === destination.toLowerCase()) throw new Error("DATA_ROOTS_MUST_DIFFER");
  if ([source, destination].some((candidate) => dirname(candidate) === candidate))
    throw new Error("DATA_ROOT_TOO_BROAD");
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
}): Promise<MigrationResult> {
  const source = resolve(input.source);
  const destination = resolve(input.destination);
  assertSafeRoots(source, destination);
  const sourceRegistry = join(source, "registry", "registry.sqlite");
  if (!existsSync(sourceRegistry)) throw new Error("SOURCE_REGISTRY_MISSING");
  quickCheck(sourceRegistry);
  const sourceDb = new Database(sourceRegistry, { readonly: true, fileMustExist: true });
  const sourceProjects = Number(
    (sourceDb.prepare("SELECT count(*) AS count FROM projects").get() as { count: number }).count,
  );
  sourceDb.close();
  if (sourceProjects === 0) throw new Error("SOURCE_HAS_NO_PROJECTS");

  const destinationRegistry = join(destination, "registry", "registry.sqlite");
  if (existsSync(destinationRegistry)) {
    quickCheck(destinationRegistry);
    const destinationDb = new Database(destinationRegistry, {
      readonly: true,
      fileMustExist: true,
    });
    const destinationProjects = Number(
      (destinationDb.prepare("SELECT count(*) AS count FROM projects").get() as { count: number })
        .count,
    );
    destinationDb.close();
    if (destinationProjects > 0) throw new Error("DESTINATION_ALREADY_HAS_PROJECTS");
  }

  const stamp = (input.timestamp ?? new Date().toISOString()).replace(/[:.]/gu, "-");
  const destinationBackup = existsSync(destination)
    ? join(dirname(destination), `${basename(destination)}-before-migration-${stamp}`)
    : null;
  if (!input.execute)
    return {
      source,
      destination,
      destinationBackup,
      projects: sourceProjects,
      executed: false,
    };

  await assertSourceStopped(source);
  const staging = join(dirname(destination), `${basename(destination)}-migrating-${stamp}`);
  if (existsSync(staging) || (destinationBackup && existsSync(destinationBackup)))
    throw new Error("MIGRATION_TARGET_ALREADY_EXISTS");
  await cp(source, staging, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (sourcePath) => copyableDataRootEntry(sourcePath, source),
  });
  const stagedRegistry = join(staging, "registry", "registry.sqlite");
  rewriteRegistryPaths(stagedRegistry, source, destination);
  await mkdir(join(staging, "runtime"), { recursive: true });
  await rm(join(staging, "runtime", "daemon.json"), { force: true });
  const destinationToken = join(destination, "runtime", "local.token");
  if (existsSync(destinationToken))
    await cp(destinationToken, join(staging, "runtime", "local.token"), { force: true });
  quickCheck(stagedRegistry);
  const stagedDatabase = new Database(stagedRegistry, { readonly: true, fileMustExist: true });
  const projectPaths = stagedDatabase.prepare("SELECT db_path FROM projects").all() as Array<{
    db_path: string | null;
  }>;
  stagedDatabase.close();
  for (const project of projectPaths)
    if (project.db_path) quickCheck(rewritePath(project.db_path, destination, staging));

  if (destinationBackup) await rename(destination, destinationBackup);
  try {
    await rename(staging, destination);
  } catch (error) {
    if (destinationBackup && !existsSync(destination) && existsSync(destinationBackup))
      await rename(destinationBackup, destination);
    throw error;
  }
  const manifest = {
    format: 1,
    migratedAt: new Date().toISOString(),
    source,
    destination,
    destinationBackup,
    projects: sourceProjects,
  };
  await writeFile(
    join(destination, "migration-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  quickCheck(join(destination, "registry", "registry.sqlite"));
  for (const project of projectPaths) if (project.db_path) quickCheck(project.db_path);
  return {
    source,
    destination,
    destinationBackup,
    projects: sourceProjects,
    executed: true,
  };
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
