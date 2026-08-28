import { dirname, join } from "node:path";
import { AtmError } from "@ayanami-task/errors";
import { openManagedDatabase, type ManagedDatabase } from "./database.js";

export type PoolProject = {
  id: string;
  databasePath: string;
  lifecycle: string;
};

export class ProjectDatabasePool {
  readonly #projects = new Map<string, { database: ManagedDatabase; lastUsed: number }>();
  readonly #migrationsRoot: string;
  readonly #maxOpenProjects: number;
  readonly #getProject: (codeOrId: string) => PoolProject;
  readonly #markMigrationFailed: (projectId: string) => void;

  constructor(input: {
    migrationsRoot: string;
    maxOpenProjects?: number;
    getProject: (codeOrId: string) => PoolProject;
    markMigrationFailed: (projectId: string) => void;
  }) {
    this.#migrationsRoot = input.migrationsRoot;
    this.#maxOpenProjects = input.maxOpenProjects ?? 8;
    this.#getProject = input.getProject;
    this.#markMigrationFailed = input.markMigrationFailed;
  }

  async openProject(codeOrId: string): Promise<ManagedDatabase> {
    const project = this.#getProject(codeOrId);
    if (project.lifecycle !== "ACTIVE" && project.lifecycle !== "ARCHIVED") {
      throw new AtmError("PROJECT_DB_UNAVAILABLE", {
        message: `项目数据库当前不可用：${project.lifecycle}`,
        details: { lifecycle: project.lifecycle },
      });
    }
    const cached = this.#projects.get(project.id);
    if (cached) {
      cached.lastUsed = Date.now();
      return cached.database;
    }
    while (this.#projects.size >= this.#maxOpenProjects) {
      const oldest = [...this.#projects.entries()].sort(
        (left, right) => left[1].lastUsed - right[1].lastUsed,
      )[0];
      if (!oldest) break;
      oldest[1].database.sqlite.pragma("wal_checkpoint(PASSIVE)");
      oldest[1].database.sqlite.close();
      this.#projects.delete(oldest[0]);
    }
    try {
      const database = await openManagedDatabase({
        path: project.databasePath,
        migrationDirectory: join(this.#migrationsRoot, "project"),
        backupDirectory: join(dirname(project.databasePath), "backups"),
      });
      this.#projects.set(project.id, { database, lastUsed: Date.now() });
      return database;
    } catch (error) {
      this.#markMigrationFailed(project.id);
      throw error;
    }
  }

  closeIdleProjects(maxIdleMs = 5 * 60_000, at = Date.now()): number {
    let closed = 0;
    for (const [projectId, cached] of [...this.#projects]) {
      if (at - cached.lastUsed < maxIdleMs) continue;
      this.closeProject(projectId);
      closed += 1;
    }
    return closed;
  }

  closeProject(projectId: string): void {
    const cached = this.#projects.get(projectId);
    if (!cached) return;
    if (cached.database.sqlite.open) {
      cached.database.sqlite.pragma("wal_checkpoint(TRUNCATE)");
      cached.database.sqlite.close();
    }
    this.#projects.delete(projectId);
  }

  closeAll(): void {
    for (const { database } of this.#projects.values()) {
      if (!database.sqlite.open) continue;
      database.sqlite.pragma("wal_checkpoint(PASSIVE)");
      database.sqlite.close();
    }
    this.#projects.clear();
  }
}
