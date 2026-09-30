// 文档、修订号与变更流。语义逐条对齐 AyanamiCloud 应用数据接口（见 README「兼容性」）。
import { type Database, nowIso, transaction } from "./database.js";
import {
  RelayError,
  insufficientStorage,
  invalidArgument,
  notFound,
  payloadTooLarge,
} from "./errors.js";
import type { RelayLimits } from "./limits.js";

export const KEY_PATTERN = /^[A-Za-z0-9_./-]{1,200}$/;

/** 与 AyanamiCloud 相同：字符集 + 长度，另外禁止首尾斜杠与空段、`.`、`..`。 */
export function validateKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw invalidArgument("文档键只能包含字母、数字、下划线、点、斜杠与连字符，长度 1–200");
  }
  if (key.startsWith("/") || key.endsWith("/")) {
    throw invalidArgument("文档键不能以斜杠开头或结尾");
  }
  for (const segment of key.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw invalidArgument("文档键不能包含空段、. 或 ..");
    }
  }
}

export type DocumentMeta = {
  key: string;
  schema_version: number;
  revision: number;
  updated_at: string;
  updated_by_device: string | null;
  size_bytes: number;
};

export type DocumentRow = DocumentMeta & { data: string };

const META_COLUMNS = "key, schema_version, revision, updated_at, updated_by_device, size_bytes";

function metaOf(row: DocumentMeta): DocumentMeta {
  // 字段顺序与 AyanamiCloud 的响应一致，方便人肉比对。
  return {
    key: row.key,
    schema_version: row.schema_version,
    revision: row.revision,
    updated_at: row.updated_at,
    updated_by_device: row.updated_by_device,
    size_bytes: row.size_bytes,
  };
}

/** Document 的 JSON 文本。`data` 直接拼接库里的紧凑原文，不做 parse/stringify 往返。 */
export function documentJson(row: DocumentRow): string {
  const meta = JSON.stringify(metaOf(row));
  return `${meta.slice(0, -1)},"data":${row.data}}`;
}

export function getDocument(db: Database, appId: string, key: string): DocumentRow | undefined {
  return db
    .prepare(`SELECT ${META_COLUMNS}, data FROM documents WHERE app_id = ? AND key = ?`)
    .get(appId, key) as DocumentRow | undefined;
}

// ───────────────────────── 游标 ─────────────────────────

function cursorInvalid(): RelayError {
  return invalidArgument("游标不合法");
}

/** 文档列表用键集分页：游标是上一页最后一个键的 base64url。并发写入不会让翻页跳过或重复。 */
function decodeDocumentCursor(cursor: string): string | null {
  if (cursor === "") return null;
  if (!/^[A-Za-z0-9_-]{1,300}$/.test(cursor)) throw cursorInvalid();
  const key = Buffer.from(cursor, "base64url").toString("utf8");
  if (!KEY_PATTERN.test(key)) throw cursorInvalid();
  return key;
}

export function encodeChangeCursor(seq: number): string {
  return seq.toString(36);
}

function decodeChangeCursor(cursor: string): number {
  if (cursor === "") return 0;
  if (!/^[0-9a-z]{1,11}$/.test(cursor)) throw cursorInvalid();
  const seq = Number.parseInt(cursor, 36);
  if (!Number.isSafeInteger(seq)) throw cursorInvalid();
  return seq;
}

// ───────────────────────── 读 ─────────────────────────

export type DocumentPage = { documents: DocumentMeta[]; next_cursor: string | null };

export function listDocuments(
  db: Database,
  appId: string,
  prefix: string,
  cursor: string,
  limit: number,
): DocumentPage {
  const after = decodeDocumentCursor(cursor);
  const clauses = ["app_id = ?"];
  const args: (string | number)[] = [appId];
  if (prefix !== "") {
    // 键只含 ASCII 且最大字符是 'z'，所以 [prefix, prefix+"\x7f") 恰好覆盖以 prefix 开头的键，
    // 能走主键索引；substr 再精确核对一次。前缀按字节精确匹配、区分大小写。
    clauses.push("key >= ? AND key < ? AND substr(key, 1, ?) = ?");
    args.push(prefix, `${prefix}\x7f`, prefix.length, prefix);
  }
  if (after !== null) {
    clauses.push("key > ?");
    args.push(after);
  }
  args.push(limit + 1);
  const rows = db
    .prepare(
      `SELECT ${META_COLUMNS} FROM documents WHERE ${clauses.join(" AND ")} ORDER BY key LIMIT ?`,
    )
    .all(...args) as DocumentMeta[];
  const more = rows.length > limit;
  const page = (more ? rows.slice(0, limit) : rows).map(metaOf);
  const last = page[page.length - 1];
  return {
    documents: page,
    next_cursor: more && last ? Buffer.from(last.key, "utf8").toString("base64url") : null,
  };
}

export type Change = {
  seq: number;
  key: string;
  revision: number;
  op: "put" | "delete";
  device_id: string | null;
  at: string;
};

export type ChangePage = { changes: Change[]; next_cursor: string | null; has_more: boolean };

function cursorExpired(): RelayError {
  return new RelayError(410, "CURSOR_EXPIRED", "增量游标已过期，请全量拉取");
}

/**
 * cursor 之后的变更。判定过期的规则与 AyanamiCloud 相同：该 app 还有变更、却没有任何一条
 * seq ≤ 游标，说明游标之后的那段已被裁剪。另加一条：游标比全库最大 seq 还大（换了中继、
 * 或数据目录从旧备份恢复），同样 410——否则客户端会停在一个永远等不到的位置上。
 */
export function listChanges(
  db: Database,
  appId: string,
  cursor: string,
  limit: number,
): ChangePage {
  const after = decodeChangeCursor(cursor);
  if (after > 0) {
    const anchor = db
      .prepare(
        `SELECT EXISTS (SELECT 1 FROM changes WHERE app_id = ? AND seq <= ?) AS anchor,
                EXISTS (SELECT 1 FROM changes WHERE app_id = ?) AS any_change,
                IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'changes'), 0) AS max_seq`,
      )
      .get(appId, after, appId) as { anchor: number; any_change: number; max_seq: number };
    if ((anchor.any_change === 1 && anchor.anchor === 0) || after > anchor.max_seq) {
      throw cursorExpired();
    }
  }
  const rows = db
    .prepare(
      `SELECT seq, key, revision, op, device_id, at FROM changes
        WHERE app_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
    )
    .all(appId, after, limit + 1) as Change[];
  const hasMore = rows.length > limit;
  const changes = hasMore ? rows.slice(0, limit) : rows;
  const last = changes[changes.length - 1];
  let next: string | null = null;
  if (last) next = encodeChangeCursor(last.seq);
  else if (after > 0) next = cursor;
  return { changes: changes.map((c) => ({ ...c })), next_cursor: next, has_more: hasMore };
}

// ───────────────────────── 写 ─────────────────────────

function revisionConflict(current: DocumentRow | undefined, withConflictId: boolean): RelayError {
  const extraJson: [string, string][] = [["current", current ? documentJson(current) : "null"]];
  // PUT 的 409 带 conflict_id（中继不存冲突候选，恒为 null）；DELETE 的 409 只带 current。
  if (withConflictId) extraJson.push(["conflict_id", "null"]);
  return new RelayError(409, "REVISION_CONFLICT", "文档已被其它设备修改", { extraJson });
}

function highWater(db: Database, appId: string, key: string): number {
  const row = db
    .prepare("SELECT revision FROM revisions WHERE app_id = ? AND key = ?")
    .get(appId, key) as { revision: number } | undefined;
  return row?.revision ?? 0;
}

function raiseHighWater(db: Database, appId: string, key: string, revision: number): void {
  db.prepare(
    `INSERT INTO revisions (app_id, key, revision) VALUES (?, ?, ?)
     ON CONFLICT (app_id, key) DO UPDATE SET revision = MAX(revision, excluded.revision)`,
  ).run(appId, key, revision);
}

function recordChange(db: Database, change: Omit<Change, "seq"> & { appId: string }): void {
  db.prepare(
    "INSERT INTO changes (app_id, key, revision, op, device_id, at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(change.appId, change.key, change.revision, change.op, change.device_id, change.at);
}

/**
 * 按「最近 N 条或 M 天」裁剪变更，但**永远保留最新一条**：过期判定靠「游标之前还有没有记录」，
 * 一个长期不活跃的 app 被按时间清空后，停在旧游标上的客户端会拉到空结果、误以为自己是最新的。
 */
export function pruneChanges(db: Database, appId: string, limits: RelayLimits, now: number): void {
  const bounds = db
    .prepare(
      `SELECT (SELECT seq FROM changes WHERE app_id = ? ORDER BY seq LIMIT 1) AS oldest_seq,
              (SELECT at FROM changes WHERE app_id = ? ORDER BY seq LIMIT 1) AS oldest_at,
              (SELECT seq FROM changes WHERE app_id = ? ORDER BY seq DESC LIMIT 1) AS newest_seq`,
    )
    .get(appId, appId, appId) as {
    oldest_seq: number | null;
    oldest_at: string | null;
    newest_seq: number | null;
  };
  if (bounds.oldest_seq === null || bounds.newest_seq === null || bounds.oldest_at === null) return;
  const cutoff = nowIso(now - limits.changeRetentionDays * 24 * 3600 * 1000);
  // seq 全库共用，同一 app 的条数 ≤ 最新 − 最旧 + 1；两条都不超限就不必扫表。
  const mayExceedCount = bounds.newest_seq - bounds.oldest_seq + 1 > limits.changeRetentionCount;
  if (!mayExceedCount && bounds.oldest_at >= cutoff) return;
  db.prepare(
    `DELETE FROM changes
      WHERE app_id = ?
        AND seq < ?
        AND (at < ?
             OR seq <= (SELECT seq FROM changes WHERE app_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?))`,
  ).run(appId, bounds.newest_seq, cutoff, appId, limits.changeRetentionCount);
}

export type PutInput = {
  appId: string;
  key: string;
  expectedRevision: number;
  /** 已校验、已紧凑化的 data 原文。 */
  data: string;
  /** 客户端发来的原文字节数，即 size_bytes（与 AyanamiCloud 一样按原文计）。 */
  sizeBytes: number;
  schemaVersion: number;
  deviceId: string | null;
};

export function checkDataSize(sizeBytes: number, limits: RelayLimits): void {
  if (sizeBytes > limits.maxDataBytes) {
    throw payloadTooLarge(`单个文档不能超过 ${Math.floor(limits.maxDataBytes / 1024)} KiB`);
  }
}

function appUsage(db: Database, appId: string): { count: number; bytes: number } {
  return db
    .prepare(
      "SELECT COUNT(*) AS count, IFNULL(SUM(size_bytes), 0) AS bytes FROM documents WHERE app_id = ?",
    )
    .get(appId) as { count: number; bytes: number };
}

export type PutResult = { created: boolean; document: DocumentRow };

export function putDocument(
  db: Database,
  input: PutInput,
  limits: RelayLimits,
  now: number = Date.now(),
): PutResult {
  const at = nowIso(now);
  return transaction(db, () => {
    const current = getDocument(db, input.appId, input.key);
    let revision: number;
    if (!current) {
      if (input.expectedRevision !== 0) throw revisionConflict(undefined, true);
      const usage = appUsage(db, input.appId);
      if (usage.count >= limits.maxDocumentsPerApp) {
        throw insufficientStorage(`该应用的文档数已达上限（${limits.maxDocumentsPerApp}）`);
      }
      if (usage.bytes + input.sizeBytes > limits.maxBytesPerApp) {
        throw insufficientStorage("该应用的存储空间已达上限");
      }
      // 新建取「历史高水位 + 1」：删掉再建不会回到 1，持有旧修订号的客户端写不进来（防 ABA）。
      revision = highWater(db, input.appId, input.key) + 1;
      db.prepare(
        `INSERT INTO documents (app_id, key, schema_version, revision, data, size_bytes, updated_at, updated_by_device)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.appId,
        input.key,
        input.schemaVersion,
        revision,
        input.data,
        input.sizeBytes,
        at,
        input.deviceId,
      );
    } else {
      if (current.revision !== input.expectedRevision) throw revisionConflict(current, true);
      const usage = appUsage(db, input.appId);
      if (usage.bytes - current.size_bytes + input.sizeBytes > limits.maxBytesPerApp) {
        throw insufficientStorage("该应用的存储空间已达上限");
      }
      revision = current.revision + 1;
      db.prepare(
        `UPDATE documents SET schema_version = ?, revision = ?, data = ?, size_bytes = ?,
                updated_at = ?, updated_by_device = ?
          WHERE app_id = ? AND key = ?`,
      ).run(
        input.schemaVersion,
        revision,
        input.data,
        input.sizeBytes,
        at,
        input.deviceId,
        input.appId,
        input.key,
      );
    }
    raiseHighWater(db, input.appId, input.key, revision);
    recordChange(db, {
      appId: input.appId,
      key: input.key,
      revision,
      op: "put",
      device_id: input.deviceId,
      at,
    });
    pruneChanges(db, input.appId, limits, now);
    return {
      created: !current,
      document: {
        key: input.key,
        schema_version: input.schemaVersion,
        revision,
        updated_at: at,
        updated_by_device: input.deviceId,
        size_bytes: input.sizeBytes,
        data: input.data,
      },
    };
  });
}

/** 删除也消耗一个修订号：变更流里 delete 的 revision = 删除前的修订号 + 1。 */
export function deleteDocument(
  db: Database,
  appId: string,
  key: string,
  expectedRevision: number,
  limits: RelayLimits,
  now: number = Date.now(),
): void {
  const at = nowIso(now);
  transaction(db, () => {
    const current = getDocument(db, appId, key);
    if (!current) throw notFound("文档不存在");
    if (current.revision !== expectedRevision) throw revisionConflict(current, false);
    db.prepare("DELETE FROM documents WHERE app_id = ? AND key = ?").run(appId, key);
    const revision = Math.max(highWater(db, appId, key), current.revision) + 1;
    raiseHighWater(db, appId, key, revision);
    recordChange(db, { appId, key, revision, op: "delete", device_id: null, at });
    pruneChanges(db, appId, limits, now);
  });
}
