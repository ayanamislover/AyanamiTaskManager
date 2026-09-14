import { join } from "node:path";
import { existsSync } from "node:fs";
import { AtmError } from "@ayanami-task/errors";
import { openManagedDatabase, quickCheck, foreignKeyCheck } from "./database.js";
import { KnowledgeRepository } from "./knowledge-repository.js";
import { prepareKnowledgeRestore, recoverKnowledgeRestore } from "./knowledge-restore.js";

/** Lazy and isolated: an unreadable knowledge DB must not stop ordinary task work. */
export class KnowledgeDatabase {
  readonly path: string;
  #repository: Promise<KnowledgeRepository> | undefined;
  #opened: KnowledgeRepository | undefined;
  #closed = false;
  #restoring = false;
  constructor(
    readonly dataDir: string,
    readonly migrationsRoot: string,
  ) {
    this.path = join(dataDir, "knowledge", "knowledge.sqlite");
  }

  async open(): Promise<KnowledgeRepository> {
    if (this.#restoring)
      throw new AtmError("KNOWLEDGE_UNAVAILABLE", { message: "知识库正在恢复，请稍后重试" });
    if (this.#closed) throw new AtmError("INTERNAL_ERROR", { message: "知识库服务已关闭" });
    this.#repository ??= this.openDatabase().catch((error) => {
      this.#repository = undefined;
      throw new AtmError("KNOWLEDGE_UNAVAILABLE", {
        message: "本地知识库不可用；普通任务不受影响。请检查知识库或从备份恢复。",
        cause: error,
      });
    });
    return this.#repository;
  }

  private async openDatabase(): Promise<KnowledgeRepository> {
    recoverKnowledgeRestore(this.dataDir);
    const database = await openManagedDatabase({
      path: this.path,
      migrationDirectory: join(this.migrationsRoot, "knowledge"),
      backupDirectory: join(this.dataDir, "backups", "knowledge"),
    });
    try {
      if (this.#closed) throw new Error("Knowledge database closed during open");
      this.#opened = new KnowledgeRepository(database);
      return this.#opened;
    } catch (error) {
      database.sqlite.close();
      throw error;
    }
  }

  close(): void {
    this.#closed = true;
    if (this.#opened?.database.sqlite.open) this.#opened.database.sqlite.close();
    this.#opened = undefined;
    this.#repository = undefined;
  }

  async status(): Promise<{ present: boolean; ok: boolean; error: string | null }> {
    const present =
      existsSync(this.path) || existsSync(join(this.dataDir, "knowledge", "restore.json"));
    if (!present) return { present: false, ok: true, error: null };
    try {
      const repository = await this.open();
      const ok =
        quickCheck(repository.database.sqlite) && foreignKeyCheck(repository.database.sqlite);
      return { present: true, ok, error: ok ? null : "知识库完整性检查失败" };
    } catch (error) {
      return {
        present: true,
        ok: false,
        error: error instanceof Error ? error.message.slice(0, 500) : "知识库不可用",
      };
    }
  }

  async restoreFrom(source: string): Promise<void> {
    if (this.#restoring || this.#closed) throw new AtmError("KNOWLEDGE_UNAVAILABLE");
    this.#restoring = true;
    let prepared: Awaited<ReturnType<typeof prepareKnowledgeRestore>> | undefined;
    try {
      // Drain an already accepted lazy open before touching its handle.
      await this.#repository?.catch(() => undefined);
      recoverKnowledgeRestore(this.dataDir);
      prepared = await prepareKnowledgeRestore(this.dataDir, this.migrationsRoot, source);
      if (this.#closed) throw new AtmError("KNOWLEDGE_UNAVAILABLE");
      if (this.#opened?.database.sqlite.open) {
        this.#opened.database.sqlite.pragma("wal_checkpoint(TRUNCATE)");
        this.#opened.database.sqlite.close();
      }
      this.#opened = undefined;
      this.#repository = undefined;
      prepared.commit();
    } finally {
      prepared?.discard();
      this.#restoring = false;
    }
  }
}
