import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedDatabase } from "../src/database.js";
import { AyanamiDatabaseManager } from "../src/index.js";
import { KnowledgeDatabase } from "../src/knowledge-database.js";

/**
 * Startup recovery removes crash leftovers next to backups. On Windows a name there can
 * belong to another process for a moment: a real-time scanner that sees `X` deleted
 * creates and removes its own upper-cased `X.tmp` (captured under load as
 * `UNREGISTERED-CRASH.SQLITE.tmp` right after `unregistered-crash.sqlite` was removed, and
 * `…SQLITE.TMP-SHM.tmp` after a snapshot's `-shm`). That is the very `.tmp` companion
 * recovery removes next, and the `.tmp` sweep lists it too. rmSync then fails with EPERM,
 * which used to escape AyanamiDatabaseManager.open: the daemon could not start because of
 * garbage, and the Registry handle the failed open left behind locked the data directory.
 *
 * A scanner cannot be scheduled from a test, so these cases make rmSync refuse the
 * contested names the way Windows does and assert what startup does about it.
 */
const { refused, opened, registryWrites } = vi.hoisted(() => ({
  refused: new Map<string, string>(),
  // Every database the manager opens, so a failed open's Registry can still be inspected.
  opened: [] as ManagedDatabase[],
  // When set, the Registry refuses its first write after opening.
  registryWrites: { failure: undefined as Error | undefined },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const rmSync: typeof actual.rmSync = (path, options) => {
    const code = refused.get(String(path).toLowerCase());
    if (code) throw Object.assign(new Error(`${code}: ${String(path)}`), { code });
    return actual.rmSync(path, options);
  };
  return { ...actual, rmSync, default: { ...actual, rmSync } };
});

vi.mock("../src/database.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/database.js")>();
  return {
    ...actual,
    openManagedDatabase: async (input: Parameters<typeof actual.openManagedDatabase>[0]) => {
      const database = await actual.openManagedDatabase(input);
      opened.push(database);
      const failure = registryWrites.failure;
      if (failure && input.path.endsWith("registry.sqlite")) {
        const prepare = database.sqlite.prepare.bind(database.sqlite);
        database.sqlite.prepare = ((source: string) => {
          if (source.includes("INSERT INTO app_meta")) throw failure;
          return prepare(source);
        }) as typeof database.sqlite.prepare;
      }
      return database;
    },
  };
});

const temporary: string[] = [];
const managers: AyanamiDatabaseManager[] = [];
const migrationsRoot = resolve(process.cwd(), "migrations");

afterEach(() => {
  vi.restoreAllMocks();
  registryWrites.failure = undefined;
  refused.clear();
  opened.splice(0);
  for (const manager of managers.splice(0)) manager.close();
  for (const directory of temporary.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function refuse(path: string, code = "EPERM"): void {
  refused.set(path.toLowerCase(), code);
}

async function open(dataDir: string): Promise<AyanamiDatabaseManager> {
  const manager = await AyanamiDatabaseManager.open({ dataDir, migrationsRoot });
  managers.push(manager);
  return manager;
}

function close(manager: AyanamiDatabaseManager): void {
  manager.close();
  managers.splice(managers.indexOf(manager), 1);
}

/** A committed backup plus the leftovers of one that crashed before its catalog commit. */
async function crashedBackup(code: string) {
  const dataDir = mkdtempSync(join(tmpdir(), `atm-recovery-held-${code.toLowerCase()}-`));
  temporary.push(dataDir);
  const manager = await open(dataDir);
  const project = await manager.createProject({ name: code, sourcePath: null, code });
  const backup = await manager.createBackup({
    scope: "PROJECT",
    project: project.id,
    reason: "MANUAL",
  });
  const orphan = join(dirname(backup.path), "unregistered-crash.sqlite");
  copyFileSync(backup.path, orphan);
  writeFileSync(`${orphan}.manifest.json`, "{}\n", "utf8");
  writeFileSync(`${orphan}.pending`, "{}\n", "utf8");
  writeFileSync(`${orphan}.tmp-wal`, "stale", "utf8");
  close(manager);
  return { dataDir, backup, orphan };
}

describe("startup recovery while another process holds a leftover name", () => {
  it("still opens when the .tmp companion of an uncommitted backup is held", async () => {
    const { dataDir, backup, orphan } = await crashedBackup("HELDTMP");
    // What the scanner's own upper-cased copy looks like to us: the name is taken.
    refuse(`${orphan}.tmp`);

    await open(dataDir);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(`${orphan}.manifest.json`)).toBe(false);
    expect(existsSync(`${orphan}.pending`)).toBe(false);
    expect(existsSync(`${orphan}.tmp-wal`)).toBe(false);
    expect(existsSync(backup.path)).toBe(true);
  });

  it("keeps a held temporary file for the next start instead of failing this one", async () => {
    const { dataDir, backup } = await crashedBackup("HELDSWEEP");
    // The scanner's copy after a snapshot's -shm was deleted, as the .tmp sweep lists it.
    const stray = join(dirname(backup.path), `${basename(backup.path).toUpperCase()}.TMP-SHM.tmp`);
    writeFileSync(stray, "", "utf8");
    refuse(stray);

    const first = await open(dataDir);
    expect(existsSync(stray)).toBe(true);
    close(first);

    refused.clear();
    await open(dataDir);
    expect(existsSync(stray)).toBe(false);
  });

  it("keeps the marker of an uncommitted backup it could not remove and finishes next start", async () => {
    const { dataDir, backup, orphan } = await crashedBackup("HELDFINAL");
    refuse(orphan);

    const first = await open(dataDir);
    // The marker is what tells the next start this file was never committed.
    expect(existsSync(orphan)).toBe(true);
    expect(existsSync(`${orphan}.pending`)).toBe(true);
    expect(first.listBackups().map((entry) => entry.path)).toEqual([backup.path]);
    close(first);

    refused.clear();
    await open(dataDir);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(`${orphan}.manifest.json`)).toBe(false);
    expect(existsSync(`${orphan}.pending`)).toBe(false);
    expect(existsSync(backup.path)).toBe(true);
  });

  it.runIf(process.platform === "win32")(
    "a startup that still fails releases the Registry instead of locking the data directory",
    async () => {
      const { dataDir, orphan } = await crashedBackup("FAILOPEN");
      // Not a momentary hold: this one must still fail startup.
      refuse(`${orphan}.tmp`, "EIO");

      await expect(open(dataDir)).rejects.toThrow("EIO");
      // Non-recursive, so no test-side retry: an open Registry handle refuses this at once.
      expect(() => rmSync(join(dataDir, "registry", "registry.sqlite"))).not.toThrow();
    },
  );
});

/** KnowledgeDatabase.close() that does its work and then fails, as a checkpoint error would. */
function failKnowledgeClose(): Error {
  const failure = new Error("knowledge close failed");
  const close = KnowledgeDatabase.prototype.close;
  vi.spyOn(KnowledgeDatabase.prototype, "close").mockImplementation(function (
    this: KnowledgeDatabase,
  ) {
    close.call(this);
    throw failure;
  });
  return failure;
}

function registryOpened(): ManagedDatabase {
  const registry = opened.find((database) => basename(database.path) === "registry.sqlite");
  if (!registry) throw new Error("the Registry was never opened");
  return registry;
}

describe("closing still reaches the Registry when an earlier close stage fails", () => {
  it("a failed startup whose own cleanup fails reports the startup error and closes the Registry", async () => {
    const { dataDir, orphan } = await crashedBackup("FAILCLOSE");
    refuse(`${orphan}.tmp`, "EIO");
    opened.splice(0);
    const knowledgeFailure = failKnowledgeClose();

    const error: unknown = await AyanamiDatabaseManager.open({ dataDir, migrationsRoot }).then(
      () => {
        throw new Error("open should have failed");
      },
      (failure: unknown) => failure,
    );

    expect(error).toMatchObject({ code: "EIO" });
    expect(registryOpened().sqlite.open).toBe(false);
    // The cleanup failure is not swallowed: it rides on the startup error.
    expect((error as { suppressed?: unknown }).suppressed).toEqual([knowledgeFailure]);
  });

  it("a startup that fails before the manager exists still closes the Registry", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-close-early-"));
    temporary.push(dataDir);
    const failure = Object.assign(new Error("SQLITE_IOERR: disk I/O error"), {
      code: "SQLITE_IOERR",
    });
    registryWrites.failure = failure;

    await expect(AyanamiDatabaseManager.open({ dataDir, migrationsRoot })).rejects.toBe(failure);
    expect(registryOpened().sqlite.open).toBe(false);
  });

  it("an ordinary close whose Registry checkpoint fails still closes the Registry", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-close-registry-"));
    temporary.push(dataDir);
    const manager = await open(dataDir);
    managers.splice(managers.indexOf(manager), 1);
    const checkpointFailure = new Error("checkpoint failed");
    vi.spyOn(manager.registry.sqlite, "pragma").mockImplementation(() => {
      throw checkpointFailure;
    });

    expect(() => manager.close()).toThrow(checkpointFailure);
    expect(manager.registry.sqlite.open).toBe(false);
  });

  it("an ordinary close that fails on knowledge still closes the Registry", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-close-knowledge-"));
    temporary.push(dataDir);
    const manager = await open(dataDir);
    managers.splice(managers.indexOf(manager), 1);
    const knowledgeFailure = failKnowledgeClose();

    expect(() => manager.close()).toThrow(knowledgeFailure);
    expect(manager.registry.sqlite.open).toBe(false);
  });

  it("an ordinary close that fails on one project still closes the others and the Registry", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-close-project-"));
    temporary.push(dataDir);
    const manager = await open(dataDir);
    managers.splice(managers.indexOf(manager), 1);
    await manager.createProject({ name: "First", sourcePath: null, code: "CLOSEA" });
    await manager.createProject({ name: "Second", sourcePath: null, code: "CLOSEB" });
    const first = await manager.openProject("CLOSEA");
    const second = await manager.openProject("CLOSEB");
    const checkpointFailure = new Error("checkpoint failed");
    vi.spyOn(first.sqlite, "pragma").mockImplementation(() => {
      throw checkpointFailure;
    });

    expect(() => manager.close()).toThrow(checkpointFailure);
    expect(first.sqlite.open).toBe(false);
    expect(second.sqlite.open).toBe(false);
    expect(manager.registry.sqlite.open).toBe(false);
  });
});
