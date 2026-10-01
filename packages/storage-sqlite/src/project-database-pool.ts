import { AsyncLocalStorage } from "node:async_hooks";
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

type PoolEntry = { database: ManagedDatabase; lastUsed: number; holds: number };

/** 一个在途操作，以及它（连同被它调起的下层操作）取用过的项目库。 */
type Activity = { parent: Activity | undefined; projects: Set<string> };

export class ProjectDatabasePool {
  readonly #projects = new Map<string, PoolEntry>();
  readonly #activities = new Set<Activity>();
  readonly #current = new AsyncLocalStorage<Activity>();
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
      this.#touch(project.id, cached);
      return cached.database;
    }
    this.#evictTo(this.#maxOpenProjects - 1);
    try {
      const database = await openManagedDatabase({
        path: project.databasePath,
        migrationDirectory: join(this.#migrationsRoot, "project"),
        backupDirectory: join(dirname(project.databasePath), "backups"),
      });
      const entry: PoolEntry = { database, lastUsed: 0, holds: 0 };
      this.#touch(project.id, entry);
      this.#projects.set(project.id, entry);
      return database;
    } catch (error) {
      this.#markMigrationFailed(project.id);
      throw error;
    }
  }

  /**
   * 把 run 作为一个在途操作执行（服务方法、知识库方法、后台补扫）。它取用过的项目库，在它
   * （含异步）结束前不会被别的操作的空闲回收或容量淘汰关掉：请求拿到缓存的连接后去等 Git、
   * 等子进程，回来时库还得开着（Codex R7-P2-1）。
   *
   * 只挡「别的」操作：同一条调用链自己挨个遍历项目（启动维护、首屏概览扫全部项目）时，
   * 照旧按 LRU 淘汰自己先前取的，池子不因一次遍历涨到项目总数。因保护暂时超出上限的部分，
   * 在操作结束时收回。
   */
  runActivity<T>(run: () => T): T {
    const activity: Activity = { parent: this.#current.getStore(), projects: new Set() };
    this.#activities.add(activity);
    const end = () => {
      this.#activities.delete(activity);
      this.#evictTo(this.#maxOpenProjects);
    };
    let result: T;
    try {
      result = this.#current.run(activity, run);
    } catch (error) {
      end();
      throw error;
    }
    if (!(result instanceof Promise)) {
      end();
      return result;
    }
    return result.then(
      (value: unknown) => {
        end();
        return value;
      },
      (error: unknown) => {
        end();
        throw error;
      },
    ) as T;
  }

  #touch(projectId: string, entry: PoolEntry): void {
    entry.lastUsed = Date.now();
    for (let activity = this.#current.getStore(); activity; activity = activity.parent)
      activity.projects.add(projectId);
  }

  /** 没人持有，也没被当前调用链以外的在途操作取用过。 */
  #reclaimable(projectId: string, entry: PoolEntry): boolean {
    if (entry.holds > 0) return false;
    const chain = new Set<Activity>();
    for (let activity = this.#current.getStore(); activity; activity = activity.parent)
      chain.add(activity);
    for (const activity of this.#activities)
      if (!chain.has(activity) && activity.projects.has(projectId)) return false;
    return true;
  }

  /** 按最久未用淘汰到 limit 个；在用的不淘汰，全在用时暂时超出上限。 */
  #evictTo(limit: number): void {
    while (this.#projects.size > limit) {
      const oldest = [...this.#projects.entries()]
        .filter(([projectId, entry]) => this.#reclaimable(projectId, entry))
        .sort((left, right) => left[1].lastUsed - right[1].lastUsed)[0];
      if (!oldest) return;
      oldest[1].database.sqlite.pragma("wal_checkpoint(PASSIVE)");
      oldest[1].database.sqlite.close();
      this.#projects.delete(oldest[0]);
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
      this.#touch(projectId, cached);
    };
  }

  /** 关闭空闲超过 maxIdleMs、不在用的项目库（每小时维护）。 */
  closeIdleProjects(maxIdleMs = 5 * 60_000, at = Date.now()): number {
    let closed = 0;
    for (const [projectId, cached] of [...this.#projects]) {
      if (!this.#reclaimable(projectId, cached) || at - cached.lastUsed < maxIdleMs) continue;
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
