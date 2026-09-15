import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { AtmError } from "@ayanami-task/errors";
import { createUlid } from "@ayanami-task/protocol";
import { openManagedDatabase, quickCheck, foreignKeyCheck } from "./database.js";
import { KnowledgeRepository } from "./knowledge-repository.js";
import { removeSqliteSidecars } from "./storage-file-operations.js";

function paths(dataDir: string, id: string) {
  return {
    live: join(dataDir, "knowledge", "knowledge.sqlite"),
    journal: join(dataDir, "knowledge", "restore.json"),
    candidate: join(dataDir, "knowledge", `restore-${id}.sqlite`),
    previous: join(dataDir, "backups", "knowledge", `before-restore-${id}.sqlite`),
  };
}

/** Recover only fixed paths derived from a validated nonce; never follow paths from JSON. */
export function recoverKnowledgeRestore(dataDir: string): void {
  const journal = join(dataDir, "knowledge", "restore.json");
  if (!existsSync(journal)) {
    quarantineOrphanCandidates(dataDir);
    return;
  }
  const value = JSON.parse(readFileSync(journal, "utf8")) as { id?: unknown; committed?: unknown };
  if (
    typeof value.id !== "string" ||
    !/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(value.id) ||
    typeof value.committed !== "boolean"
  )
    throw new AtmError("KNOWLEDGE_UNAVAILABLE", {
      message: "知识库恢复日志损坏，保留现场等待恢复",
    });
  const path = paths(dataDir, value.id);
  if (!value.committed && existsSync(path.previous)) {
    rmSync(path.live, { force: true });
    renameSync(path.previous, path.live);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${path.previous}${suffix}`)) {
        rmSync(`${path.live}${suffix}`, { force: true });
        renameSync(`${path.previous}${suffix}`, `${path.live}${suffix}`);
      }
    }
  }
  // After commit the original (even if corrupt) remains as a recovery artifact.
  rmSync(path.candidate, { force: true });
  removeSqliteSidecars(path.candidate);
  rmSync(path.journal, { force: true });
  quarantineOrphanCandidates(dataDir);
}

function quarantineOrphanCandidates(dataDir: string): void {
  const directory = join(dataDir, "knowledge");
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^restore-[0-9A-HJKMNP-TV-Z]{26}\.sqlite$/u.test(entry.name)) continue;
    const backupDirectory = join(dataDir, "backups", "knowledge");
    mkdirSync(backupDirectory, { recursive: true });
    const source = join(directory, entry.name);
    const preserved = join(backupDirectory, `orphan-${createUlid()}-${entry.name}`);
    renameSync(source, preserved);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${source}${suffix}`))
        renameSync(`${source}${suffix}`, `${preserved}${suffix}`);
    }
  }
}

export async function prepareKnowledgeRestore(
  dataDir: string,
  migrationsRoot: string,
  source: string,
) {
  const id = createUlid();
  const path = paths(dataDir, id);
  mkdirSync(join(dataDir, "knowledge"), { recursive: true });
  mkdirSync(join(dataDir, "backups", "knowledge"), { recursive: true });
  copyFileSync(source, path.candidate);
  try {
    const candidate = await openManagedDatabase({
      path: path.candidate,
      migrationDirectory: join(migrationsRoot, "knowledge"),
      backupDirectory: join(dataDir, "backups", "knowledge"),
    });
    try {
      const identity = candidate.sqlite
        .prepare("SELECT database_id, generation FROM knowledge_meta WHERE singleton=1")
        .get() as { database_id?: string; generation?: string } | undefined;
      if (
        !identity?.database_id ||
        !identity.generation ||
        !quickCheck(candidate.sqlite) ||
        !foreignKeyCheck(candidate.sqlite)
      )
        throw new AtmError("BACKUP_INTEGRITY_FAILED");
      new KnowledgeRepository(candidate).resetGeneration();
      candidate.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      candidate.sqlite.close();
    }
  } catch (error) {
    rmSync(path.candidate, { force: true });
    removeSqliteSidecars(path.candidate);
    throw error;
  }
  return {
    commit: () => {
      const journal = (committed: boolean) => {
        writeFileSync(`${path.journal}.new`, JSON.stringify({ id, committed }), { flush: true });
        renameSync(`${path.journal}.new`, path.journal);
      };
      journal(false);
      try {
        if (existsSync(path.live)) renameSync(path.live, path.previous);
        for (const suffix of ["-wal", "-shm"]) {
          if (existsSync(`${path.live}${suffix}`))
            renameSync(`${path.live}${suffix}`, `${path.previous}${suffix}`);
        }
        renameSync(path.candidate, path.live);
        journal(true);
      } catch (error) {
        recoverKnowledgeRestore(dataDir);
        throw error;
      }
      try {
        recoverKnowledgeRestore(dataDir);
      } catch {
        /* Committed restore is valid; retry journal cleanup on next open. */
      }
    },
    discard: () => {
      rmSync(path.candidate, { force: true });
      removeSqliteSidecars(path.candidate);
    },
  };
}
