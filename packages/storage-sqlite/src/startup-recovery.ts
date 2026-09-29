import { basename, dirname, join } from "node:path";
import { existsSync, readdirSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { nowIso } from "@ayanami-task/protocol";
import { quickCheck, type ManagedDatabase } from "./database.js";
import { renameWithRetry } from "./storage-file-operations.js";

type RecoveryProject = {
  id: string;
  lifecycle: string;
};

type RestoreRecoveryRow = {
  id: string;
  db_path: string;
  lifecycle: "ACTIVE" | "RESTORING";
};

function healthyDatabase(path: string): boolean {
  if (!existsSync(path)) return false;
  let sqlite: Database.Database | null = null;
  try {
    sqlite = new Database(path, { readonly: true, fileMustExist: true });
    return quickCheck(sqlite);
  } catch {
    return false;
  } finally {
    if (sqlite?.open) sqlite.close();
  }
}

const HELD_BY_ANOTHER_PROCESS = new Set(["EACCES", "EBUSY", "EPERM"]);

/**
 * Removes a crash leftover unless another process holds that name right now, in which
 * case it stays for the next start. Returns whether the path is gone.
 *
 * On Windows a name next to our backups can belong to someone else for a moment: a
 * real-time scanner that sees `X` deleted creates and deletes its own upper-cased `X.tmp`
 * (captured under load: `UNREGISTERED-CRASH.SQLITE.tmp` right after removing
 * `unregistered-crash.sqlite`, `…SQLITE.TMP-SHM.tmp` after a snapshot's `-shm`). That is the
 * very `.tmp` companion removed next, and the `.tmp` sweep lists it too. The resulting
 * EPERM used to escape AyanamiDatabaseManager.open, so the daemon failed to start over
 * garbage. A leftover is never the only copy of anything, so leaving it is always safe.
 */
function removeLeftover(path: string): boolean {
  try {
    rmSync(path, { force: true });
    return true;
  } catch (error) {
    if (HELD_BY_ANOTHER_PROCESS.has((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

function removeDatabaseFiles(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) rmSync(candidate, { force: true });
}

export class StartupRecovery {
  readonly #dataDir: string;
  readonly #registry: ManagedDatabase;
  readonly #getSetting: <T>(key: string, fallback: T) => { value: T };
  readonly #listProjects: () => RecoveryProject[];
  readonly #recoverStaleSessions: (projectId: string, cutoff: string) => Promise<void>;

  constructor(input: {
    dataDir: string;
    registry: ManagedDatabase;
    getSetting: <T>(key: string, fallback: T) => { value: T };
    listProjects: () => RecoveryProject[];
    recoverStaleSessions: (projectId: string, cutoff: string) => Promise<void>;
  }) {
    this.#dataDir = input.dataDir;
    this.#registry = input.registry;
    this.#getSetting = input.getSetting;
    this.#listProjects = input.listProjects;
    this.#recoverStaleSessions = input.recoverStaleSessions;
  }

  recoverCreatingProjects(): void {
    const creating = this.#registry.sqlite
      .prepare("SELECT * FROM projects WHERE lifecycle = 'CREATING'")
      .all() as any[];
    for (const row of creating) {
      const finalDirectory = join(this.#dataDir, "projects", row.id);
      const databasePath = join(finalDirectory, "project.sqlite");
      if (healthyDatabase(databasePath)) {
        this.#registry.sqlite
          .prepare(
            "UPDATE projects SET db_path = ?, lifecycle = 'ACTIVE', updated_at = ? WHERE id = ?",
          )
          .run(databasePath, nowIso(), row.id);
        continue;
      }
      for (const name of [`.creating-${row.id}`, `${row.id}.creating`]) {
        rmSync(join(this.#dataDir, "projects", name), { recursive: true, force: true });
      }
      this.#registry.sqlite
        .prepare("UPDATE projects SET lifecycle = 'TRASHED', updated_at = ? WHERE id = ?")
        .run(nowIso(), row.id);
    }
  }

  async recoverInterruptedFiles(): Promise<void> {
    const rows = this.#registry.sqlite
      .prepare(
        "SELECT id, db_path, lifecycle FROM projects WHERE lifecycle IN ('ACTIVE','RESTORING')",
      )
      .all() as RestoreRecoveryRow[];
    let preserveRestoreCandidates = false;
    for (const row of rows) {
      const databaseName = basename(row.db_path);
      const databaseDirectory = dirname(row.db_path);
      const rollbackPrefix = `${databaseName}.restore-old-`;
      const rollbackPaths = existsSync(databaseDirectory)
        ? readdirSync(databaseDirectory, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.startsWith(rollbackPrefix))
            .map((entry) => join(databaseDirectory, entry.name))
            .sort()
        : [];
      if (row.lifecycle === "RESTORING") {
        const rollbackPath = [...rollbackPaths].reverse().find(healthyDatabase);
        if (rollbackPath) {
          removeDatabaseFiles(row.db_path);
          await renameWithRetry(rollbackPath, row.db_path);
          for (const stale of rollbackPaths.filter((path) => path !== rollbackPath)) {
            removeDatabaseFiles(stale);
          }
          this.#registry.sqlite
            .prepare("UPDATE projects SET lifecycle = 'ACTIVE', updated_at = ? WHERE id = ?")
            .run(nowIso(), row.id);
        } else if (rollbackPaths.length === 0 && healthyDatabase(row.db_path)) {
          // Interrupted before the first rename: the current database is still the pre-restore source.
          this.#registry.sqlite
            .prepare("UPDATE projects SET lifecycle = 'ACTIVE', updated_at = ? WHERE id = ?")
            .run(nowIso(), row.id);
        } else {
          this.#registry.sqlite
            .prepare(
              "UPDATE projects SET lifecycle = 'MIGRATION_FAILED', updated_at = ? WHERE id = ?",
            )
            .run(nowIso(), row.id);
          preserveRestoreCandidates = true;
          continue;
        }
      } else if (rollbackPaths.length > 0 && healthyDatabase(row.db_path)) {
        // Registry ACTIVE is the commit marker: keep the restored current DB and delete old rollback files.
        for (const rollbackPath of rollbackPaths) removeDatabaseFiles(rollbackPath);
      }
    }

    const projectsDirectory = join(this.#dataDir, "projects");
    if (existsSync(projectsDirectory)) {
      for (const entry of readdirSync(projectsDirectory, { withFileTypes: true })) {
        const path = join(projectsDirectory, entry.name);
        if (entry.isDirectory() && entry.name.startsWith(".restore-")) {
          if (!preserveRestoreCandidates) rmSync(path, { recursive: true, force: true });
          continue;
        }
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          const backups = join(path, "backups");
          this.#recoverPendingRetentionArtifacts(backups);
          this.#recoverPendingBackupArtifacts(backups);
          this.#removeTemporaryFiles(backups);
        }
      }
    }
    const registryBackups = join(this.#dataDir, "backups", "registry");
    this.#recoverPendingRetentionArtifacts(registryBackups);
    this.#recoverPendingBackupArtifacts(registryBackups);
    this.#removeTemporaryFiles(registryBackups);
    const knowledgeBackups = join(this.#dataDir, "backups", "knowledge");
    this.#recoverPendingRetentionArtifacts(knowledgeBackups);
    this.#recoverPendingBackupArtifacts(knowledgeBackups);
    this.#removeTemporaryFiles(knowledgeBackups);
    this.#removeTemporaryFiles(join(this.#dataDir, "exports"));
  }

  async recoverProjectSessions(): Promise<void> {
    const timeoutSetting = this.#getSetting<number>("recovery.sessionTimeoutMinutes", 5);
    const minutes = Math.min(1440, Math.max(1, Number(timeoutSetting.value ?? 5)));
    const cutoff = new Date(Date.now() - minutes * 60_000).toISOString();
    for (const project of this.#listProjects().filter(
      (candidate) => candidate.lifecycle === "ACTIVE",
    )) {
      try {
        await this.#recoverStaleSessions(project.id, cutoff);
      } catch {
        // Project isolation is preserved; repair summaries and doctor surface the failed project.
      }
    }
  }

  #removeTemporaryFiles(directory: string): void {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        (entry.name.endsWith(".tmp") ||
          entry.name.endsWith(".tmp-wal") ||
          entry.name.endsWith(".tmp-shm"))
      ) {
        removeLeftover(join(directory, entry.name));
      }
    }
  }

  #recoverPendingBackupArtifacts(directory: string): void {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".pending")) continue;
      const pendingPath = join(directory, entry.name);
      const finalPath = pendingPath.slice(0, -".pending".length);
      const registered = Boolean(
        this.#registry.sqlite.prepare("SELECT 1 FROM backup_catalog WHERE path = ?").get(finalPath),
      );
      if (!registered) {
        const uncommitted = [finalPath, `${finalPath}.manifest.json`].map(removeLeftover);
        for (const scratch of ["", "-wal", "-shm"]) removeLeftover(`${finalPath}.tmp${scratch}`);
        // The marker is what tells the next start this backup never committed; keep it
        // until the uncommitted artifacts are really gone.
        if (!uncommitted.every(Boolean)) continue;
      }
      removeLeftover(pendingPath);
    }
  }

  #recoverPendingRetentionArtifacts(directory: string): void {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".delete-pending")) continue;
      const markerPath = join(directory, entry.name);
      const finalPath = markerPath.slice(0, -".delete-pending".length);
      const registered = Boolean(
        this.#registry.sqlite.prepare("SELECT 1 FROM backup_catalog WHERE path = ?").get(finalPath),
      );
      if (!registered) {
        const removed = [finalPath, `${finalPath}.manifest.json`, `${finalPath}.pending`].map(
          removeLeftover,
        );
        if (!removed.every(Boolean)) continue;
      }
      removeLeftover(markerPath);
    }
  }
}
