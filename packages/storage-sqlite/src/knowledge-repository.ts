import { createHash } from "node:crypto";
import { AtmError } from "@ayanami-task/errors";
import {
  createUlid,
  nowIso,
  KnowledgeArchiveInputSchema,
  KnowledgeEntrySchema,
  KnowledgeRevisionSchema,
  KnowledgeContentSchema,
  KnowledgeHitSchema,
  KnowledgeSaveInputSchema,
  type KnowledgeArchiveInput,
  type KnowledgeEntry,
  type KnowledgeRevision,
  type KnowledgeSaveInput,
} from "@ayanami-task/protocol";
import type { ManagedDatabase } from "./database.js";

type Head = {
  id: string;
  head_revision: number;
  version: number;
  archived: number;
  revision_id: string;
};
export type KnowledgeIdentity = { database_id: string; generation: string; sequence: number };

/** One SQLite transaction owns the revision, head, search projection and retry receipt. */
export class KnowledgeRepository {
  constructor(readonly database: ManagedDatabase) {
    database.sqlite
      .prepare(
        `INSERT INTO knowledge_meta(singleton, database_id, generation)
      VALUES(1, ?, ?) ON CONFLICT(singleton) DO NOTHING`,
      )
      .run(createUlid(), createUlid());
  }

  identity(): KnowledgeIdentity {
    return this.database.sqlite
      .prepare("SELECT database_id, generation, sequence FROM knowledge_meta WHERE singleton=1")
      .get() as KnowledgeIdentity;
  }

  resetGeneration(): void {
    this.database.sqlite
      .prepare("UPDATE knowledge_meta SET generation=?, sequence=sequence+1 WHERE singleton=1")
      .run(createUlid());
  }

  private head(id: string): Head {
    const head = this.database.sqlite
      .prepare(
        "SELECT e.id, e.head_revision, e.version, e.archived, r.revision_id FROM knowledge_entries e JOIN knowledge_revisions r ON r.entry_id=e.id AND r.revision=e.head_revision WHERE e.id=?",
      )
      .get(id) as Head | undefined;
    if (!head) throw new AtmError("NOT_FOUND", { message: "知识条目不存在" });
    return head;
  }

  get(id: string, revision?: number | string): KnowledgeEntry {
    const head = this.head(id);
    const row = this.database.sqlite
      .prepare(
        `SELECT snapshot FROM knowledge_revisions WHERE entry_id=? AND ${typeof revision === "string" ? "revision_id" : "revision"}=?`,
      )
      .get(id, revision ?? head.head_revision) as { snapshot: string } | undefined;
    if (!row) throw new AtmError("NOT_FOUND", { message: "知识修订不存在" });
    return KnowledgeEntrySchema.parse({
      ...JSON.parse(row.snapshot),
      version: head.version,
      archived: head.archived === 1,
    });
  }

  history(
    id: string,
    beforeRevision?: number,
    limit = 50,
  ): { revisions: Omit<KnowledgeRevision, "bodyMarkdown">[]; nextRevision: number | null } {
    this.head(id);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (beforeRevision !== undefined && (!Number.isInteger(beforeRevision) || beforeRevision < 1))
    )
      throw new AtmError("INVALID_ARGUMENT");
    const rows = this.database.sqlite
      .prepare(
        `SELECT snapshot FROM knowledge_revisions WHERE entry_id=? AND revision < ? ORDER BY revision DESC LIMIT ?`,
      )
      .all(id, beforeRevision ?? Number.MAX_SAFE_INTEGER, limit + 1) as { snapshot: string }[];
    const revisions = rows
      .slice(0, limit)
      .map((row) =>
        KnowledgeRevisionSchema.omit({ bodyMarkdown: true }).parse(JSON.parse(row.snapshot)),
      );
    return { revisions, nextRevision: rows.length > limit ? revisions.at(-1)!.revision : null };
  }

  private mutate(opId: string, payload: unknown, action: () => KnowledgeEntry): KnowledgeEntry {
    const db = this.database.sqlite;
    const fingerprint = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    return db
      .transaction(() => {
        const previous = db
          .prepare("SELECT fingerprint, receipt FROM knowledge_operations WHERE op_id=?")
          .get(opId) as { fingerprint: string; receipt: string } | undefined;
        // Retry wins over optimistic locking: the original response may have been lost.
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new AtmError("IDEMPOTENCY_CONFLICT");
          return KnowledgeEntrySchema.parse(JSON.parse(previous.receipt));
        }
        const result = action();
        db.prepare("UPDATE knowledge_meta SET sequence=sequence+1 WHERE singleton=1").run();
        db.prepare("INSERT INTO knowledge_operations VALUES(?, ?, ?)").run(
          opId,
          fingerprint,
          JSON.stringify(result),
        );
        return result;
      })
      .immediate();
  }

  save(input: KnowledgeSaveInput): KnowledgeEntry {
    const parsed = KnowledgeSaveInputSchema.parse(input);
    return this.mutate(parsed.opId, { operation: "save", ...parsed }, () => {
      const { expectedVersion, id: requestedId } = parsed;
      const content = KnowledgeContentSchema.parse(parsed);
      const db = this.database.sqlite;
      const head = requestedId ? this.head(requestedId) : null;
      if (
        (head?.version ?? 0) !== expectedVersion ||
        (head && head.revision_id !== parsed.expectedRevisionId)
      )
        throw new AtmError("VERSION_CONFLICT", {
          message: "知识已被其他编辑者更新，请重新读取并合并",
        });
      const id = requestedId ?? createUlid();
      if (
        db.prepare("SELECT id FROM knowledge_entries WHERE slug=? AND id<>?").get(content.slug, id)
      )
        throw new AtmError("INVALID_ARGUMENT", { message: "知识 slug 已被使用" });
      const snapshot: KnowledgeRevision = {
        ...content,
        id,
        revision: (head?.head_revision ?? 0) + 1,
        revisionId: createUlid(),
        createdAt: nowIso(),
      };
      db.prepare(
        `INSERT INTO knowledge_entries(id, slug, head_revision, version) VALUES(?, ?, ?, 1)
        ON CONFLICT(id) DO UPDATE SET slug=excluded.slug, head_revision=excluded.head_revision, version=knowledge_entries.version+1`,
      ).run(id, content.slug, snapshot.revision);
      db.prepare(
        "INSERT INTO knowledge_revisions(entry_id, revision, revision_id, snapshot) VALUES(?, ?, ?, ?)",
      ).run(id, snapshot.revision, snapshot.revisionId, JSON.stringify(snapshot));
      db.prepare("DELETE FROM knowledge_fts WHERE entry_id=?").run(id);
      db.prepare(
        "INSERT INTO knowledge_fts(entry_id,metadata,title,aliases,tags,summary,use_when,applies_to,body) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        JSON.stringify(
          KnowledgeHitSchema.parse({
            ...snapshot,
            version: (head?.version ?? 0) + 1,
            archived: head?.archived === 1,
          }),
        ),
        content.title,
        content.aliases.join("\n"),
        content.tags.join("\n"),
        content.summary,
        content.useWhen,
        content.appliesTo.join("\n"),
        content.bodyMarkdown,
      );
      return this.get(id);
    });
  }

  archive(input: KnowledgeArchiveInput): KnowledgeEntry {
    const parsed = KnowledgeArchiveInputSchema.parse(input);
    return this.mutate(parsed.opId, { operation: "archive", ...parsed }, () => {
      const head = this.head(parsed.id);
      if (head.version !== parsed.expectedVersion || head.revision_id !== parsed.expectedRevisionId)
        throw new AtmError("VERSION_CONFLICT");
      this.database.sqlite
        .prepare("UPDATE knowledge_entries SET archived=?, version=version+1 WHERE id=?")
        .run(Number(parsed.archived), parsed.id);
      return this.get(parsed.id);
    });
  }
}
