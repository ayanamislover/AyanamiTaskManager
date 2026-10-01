import { dirname, join } from "node:path";
import { AtmError } from "@ayanami-task/errors";
import { closeAllStages } from "./close-stages.js";
import { openManagedDatabase, type ManagedDatabase } from "./database.js";

export type PoolProject = {
  id: string;
  code: string;
  databasePath: string;
  lifecycle: string;
};

export class ProjectDatabasePool {
  readonly #projects = new Map<
    string,
    { database: ManagedDatabase; lastUsed: number; holds: number }
  >();
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
      const isTrashed = project.lifecycle === "TRASHED";
      throw new AtmError("PROJECT_DB_UNAVAILABLE", {
        message: isTrashed
          ? `项目数据库当前不可用：${project.code}（${project.id}）已在垃圾箱中；请由用户在 ATM「项目 → 垃圾箱」恢复后再重试。quick 模式不会绕过已匹配项目。`
          : `项目数据库当前不可用：${project.code}（${project.id}），生命周期为 ${project.lifecycle}`,
        retryable: !isTrashed,
        details: {
          lifecycle: project.lifecycle,
          project_code: project.code,
          project_id: project.id,
          recovery: isTrashed
            ? {
                action: "restore_project",
                message: "请由用户在 ATM「项目 → 垃圾箱」恢复该项目；不会自动恢复或新建项目。",
              }
            : null,
          quick: isTrashed
            ? {
                matched_project: true,
                action: "do_not_bypass",
                message: "quick 入口保持匹配项目优先，不会静默绕过垃圾箱项目。",
              }
            : null,
        },
      });
    }
    const cached = this.#projects.get(project.id);
    if (cached) {
      cached.lastUsed = Date.now();
      return cached.database;
    }
    while (this.#projects.size >= this.#maxOpenProjects) {
      // 被持有的连接（备份进行中）不淘汰；全被持有时暂时超出上限。
      const oldest = [...this.#projects.entries()]
        .filter(([, entry]) => entry.holds === 0)
        .sort((left, right) => left[1].lastUsed - right[1].lastUsed)[0];
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
      this.#projects.set(project.id, { database, lastUsed: Date.now(), holds: 0 });
      return database;
    } catch (error) {
      this.#markMigrationFailed(project.id);
      throw error;
    }
  }

  /**
   * 跨 await 用着连接的备份（手动、导出、每日维护、恢复前）持有它。lastUsed 只在取连接时
   * 更新，备份跑得比空闲阈值久时，不持有就会被每小时的空闲回收或容量淘汰从手里关掉。
   * 放下时重新计空闲。显式 closeProject / closeAll（恢复换库、垃圾箱、关机）不看持有。
   */
  holdProject(projectId: string): () => void {
    const cached = this.#projects.get(projectId);
    if (!cached) return () => undefined;
    cached.holds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      cached.holds -= 1;
      cached.lastUsed = Date.now();
    };
  }

  /** 关闭空闲超过 maxIdleMs、没人持有的项目库（每小时维护）。 */
  closeIdleProjects(maxIdleMs = 5 * 60_000, at = Date.now()): number {
    let closed = 0;
    for (const [projectId, cached] of [...this.#projects]) {
      if (cached.holds > 0 || at - cached.lastUsed < maxIdleMs) continue;
      this.closeProject(projectId);
      closed += 1;
    }
    return closed;
  }

  /** 仍开着的项目库释放 SQLite 页缓存；连接与预编译语句保留。 */
  shrinkOpenProjects(): void {
    for (const { database } of this.#projects.values())
      if (database.sqlite.open) database.sqlite.pragma("shrink_memory");
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

  /** Close every project database, even when one of them fails to checkpoint or close. */
  closeAll(): void {
    const databases = [...this.#projects.values()].map(({ database }) => database);
    this.#projects.clear();
    closeAllStages(
      databases.map((database) => () => {
        if (!database.sqlite.open) return;
        try {
          database.sqlite.pragma("wal_checkpoint(PASSIVE)");
        } finally {
          database.sqlite.close();
        }
      }),
    );
  }
}
