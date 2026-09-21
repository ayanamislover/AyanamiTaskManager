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
  KnowledgeAgentSaveInputSchema,
  KnowledgeAuthorSchema,
  type KnowledgeAgentSaveInput,
  type KnowledgeAuthor,
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
        `SELECT json_remove(snapshot, '$.bodyMarkdown') AS snapshot FROM knowledge_revisions WHERE entry_id=? AND revision < ? ORDER BY revision DESC LIMIT ?`,
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
        // Retry wins over optimistic locking: the original response may have been lost.
        const previous = this.replay(opId, payload);
        if (previous) return previous;
        const result = action();
        db.prepare("UPDATE knowledge_meta SET sequence=sequence+1 WHERE singleton=1").run();
        db.prepare("INSERT INTO knowledge_operations VALUES(?, ?, ?)").run(
          opId,
          fingerprint,
          JSON.stringify({
            format: "knowledge-receipt-v2",
            id: result.id,
            revisionId: result.revisionId,
            version: result.version,
            archived: result.archived,
          }),
        );
        return result;
      })
      .immediate();
  }

  private replay(opId: string, payload: unknown): KnowledgeEntry | null {
    const previous = this.database.sqlite
      .prepare("SELECT fingerprint, receipt FROM knowledge_operations WHERE op_id=?")
      .get(opId) as { fingerprint: string; receipt: string } | undefined;
    if (!previous) return null;
    const fingerprint = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    if (previous.fingerprint !== fingerprint) throw new AtmError("IDEMPOTENCY_CONFLICT");
    const receipt = JSON.parse(previous.receipt) as Record<string, unknown>;
    if (receipt.format === "knowledge-receipt-v2") {
      const identity = KnowledgeEntrySchema.pick({
        id: true,
        revisionId: true,
        version: true,
        archived: true,
      }).parse(receipt);
      // Body/author belong to the immutable revision, but version/archive are
      // the original operation's result, NOT today's mutable head state.
      return {
        ...this.get(identity.id, identity.revisionId),
        version: identity.version,
        archived: identity.archived,
      };
    }
    return KnowledgeEntrySchema.parse(receipt);
  }

  private agentOperation(input: KnowledgeAgentSaveInput, author: KnowledgeAuthor) {
    const parsed = KnowledgeAgentSaveInputSchema.parse(input);
    const verifiedAuthor = KnowledgeAuthorSchema.parse(author);
    const operationKey =
      "agent:" +
      createHash("sha256")
        .update(JSON.stringify([verifiedAuthor.projectId, verifiedAuthor.sessionId, parsed.opId]))
        .digest("hex");
    return {
      parsed,
      verifiedAuthor,
      operationKey,
      payload: { operation: "agent.save", ...parsed, author: verifiedAuthor },
    };
  }

  replayForAgent(input: KnowledgeAgentSaveInput, author: KnowledgeAuthor): KnowledgeEntry | null {
    const operation = this.agentOperation(input, author);
    return this.replay(operation.operationKey, operation.payload);
  }

  save(input: KnowledgeSaveInput): KnowledgeEntry {
    const parsed = KnowledgeSaveInputSchema.parse(input);
    return this.mutate(parsed.opId, { operation: "save", ...parsed }, () =>
      this.saveRevision(parsed),
    );
  }

  saveForAgent(input: KnowledgeAgentSaveInput, author: KnowledgeAuthor): KnowledgeEntry {
    const { parsed, verifiedAuthor, operationKey, payload } = this.agentOperation(input, author);
    // Separate receipt namespace; retries bind the caller and original revision,
    // never a newly read head/version. Receipt and publication share one transaction.
    return this.mutate(operationKey, payload, () => {
      const head = parsed.id ? this.head(parsed.id) : null;
      if (head?.archived)
        throw new AtmError("INVALID_ARGUMENT", {
          message: "归档知识不能直接更新；请先由管理界面恢复",
        });
      return this.saveRevision({ ...parsed, expectedVersion: head?.version ?? 0 }, verifiedAuthor);
    });
  }

  private saveRevision(input: KnowledgeSaveInput, publishedBy?: KnowledgeAuthor): KnowledgeEntry {
    const parsed = KnowledgeSaveInputSchema.parse(input);
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
    if (db.prepare("SELECT id FROM knowledge_entries WHERE slug=? AND id<>?").get(content.slug, id))
      throw new AtmError("INVALID_ARGUMENT", { message: "知识 slug 已被使用" });
    const snapshot: KnowledgeRevision = {
      ...content,
      id,
      revision: (head?.head_revision ?? 0) + 1,
      revisionId: createUlid(),
      createdAt: nowIso(),
      ...(publishedBy === undefined ? {} : { publishedBy }),
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
