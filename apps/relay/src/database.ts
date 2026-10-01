// SQLite 打开、建表与事务。只用内置 node:sqlite，零第三方依赖。
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export type Database = DatabaseSync;

let sqliteModule: typeof import("node:sqlite") | undefined;

/**
 * 加载 node:sqlite，只把它自己那一条 ExperimentalWarning 静默掉。
 *
 * 必须在运行时按需加载：静态 `import "node:sqlite"` 会在任何代码执行之前就打出警告。
 * 过滤只在加载的这一瞬间生效，加载完立即还原 `process.emitWarning`，其它警告照常输出。
 */
export function loadSqlite(): typeof import("node:sqlite") {
  if (sqliteModule) return sqliteModule;
  if (typeof process.getBuiltinModule !== "function") {
    throw new Error("atm-relay 需要 Node.js 22.13 或更高版本");
  }
  const original = process.emitWarning;
  process.emitWarning = function filtered(warning: string | Error, ...rest: unknown[]) {
    const first = rest[0];
    const type =
      typeof first === "string" ? first : (first as { type?: unknown } | undefined)?.type;
    const text = typeof warning === "string" ? warning : warning.message;
    if (type === "ExperimentalWarning" && /SQLite/i.test(text)) return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    const loaded = process.getBuiltinModule("node:sqlite");
    if (!loaded) throw new Error("当前 Node.js 没有内置 node:sqlite，需要 22.13 或更高版本");
    sqliteModule = loaded;
    return loaded;
  } finally {
    process.emitWarning = original;
  }
}

// v1 的原始结构。**冻结不改**：新库也先建 v1 再逐步迁移，保证新库与升级上来的库结构完全一致，
// 迁移用例也拿它构造旧库。v1 的 revisions 表为每个出现过的键永久留一行高水位（删除也不删），
// 会随「新键 + 删除」无界增长，v2 已把它换成每个 app 一行的修订号地板（见 MIGRATE_V1_TO_V2）。
// 变更表的 seq 用 AUTOINCREMENT：删掉的 seq 永不复用，游标才可能判断「过期」和「来自未来」。
export const SCHEMA_V1 = `
CREATE TABLE apps (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE TABLE tokens (
  id           TEXT PRIMARY KEY,
  app_id       TEXT NOT NULL REFERENCES apps (id),
  label        TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);
CREATE INDEX tokens_app ON tokens (app_id, created_at);
CREATE TABLE documents (
  app_id            TEXT NOT NULL REFERENCES apps (id),
  key               TEXT NOT NULL,
  schema_version    INTEGER NOT NULL,
  revision          INTEGER NOT NULL,
  data              TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL,
  updated_at        TEXT NOT NULL,
  updated_by_device TEXT,
  PRIMARY KEY (app_id, key)
);
CREATE TABLE revisions (
  app_id   TEXT NOT NULL,
  key      TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (app_id, key)
) WITHOUT ROWID;
CREATE TABLE changes (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id    TEXT NOT NULL,
  key       TEXT NOT NULL,
  revision  INTEGER NOT NULL,
  op        TEXT NOT NULL CHECK (op IN ('put', 'delete')),
  device_id TEXT,
  at        TEXT NOT NULL
);
CREATE INDEX changes_app_seq ON changes (app_id, seq);
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * v1 → v2：逐键高水位换成每个 app 一行的「修订号地板」（语义见 documents.ts「修订号」一节）。
 *
 * 地板初值取该 app 在旧库里出现过的最大修订号（高水位表、现存文档、变更流三处取最大）。
 * 高水位表本来就覆盖另外两处，多取两处只是防御：初值只能偏大不能偏小——偏大只让新建的
 * 修订号起点高一些，偏小才会让删掉的键重建后撞上旧修订号（ABA）。变更的 seq 与修订号无关，不参与。
 * 旧高水位行在同一事务里删掉，迁移后库里不再有任何逐键的历史元数据。
 */
const MIGRATE_V1_TO_V2 = `
CREATE TABLE revision_floors (
  app_id   TEXT PRIMARY KEY,
  revision INTEGER NOT NULL
) WITHOUT ROWID;
INSERT INTO revision_floors (app_id, revision)
  SELECT app_id, MAX(revision) FROM (
    SELECT app_id, revision FROM revisions
    UNION ALL SELECT app_id, revision FROM documents
    UNION ALL SELECT app_id, revision FROM changes
  ) GROUP BY app_id;
DROP TABLE revisions;
`;

/** 第 i 项把库从版本 i 升到 i + 1。只追加，不改已有项。 */
const MIGRATIONS: readonly string[] = [SCHEMA_V1, MIGRATE_V1_TO_V2];

export const SCHEMA_VERSION = MIGRATIONS.length;

export const DATABASE_FILE = "relay.db";

/** 打开（必要时创建）数据目录下的库。 */
export function openDatabase(dataDir: string): Database {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(join(dataDir, DATABASE_FILE));
  // CLI（token create/revoke）与 serve 可能同时打开同一个库：WAL + busy_timeout 让两边都不报 SQLITE_BUSY。
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

function schemaVersion(db: Database): number {
  const version = Number(
    (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
  );
  if (version > SCHEMA_VERSION) {
    throw new Error(`数据目录由更新版本的 atm-relay 创建（库版本 ${version}），请升级 atm-relay`);
  }
  return version;
}

function migrate(db: Database): void {
  if (schemaVersion(db) === SCHEMA_VERSION) return;
  transaction(db, () => {
    // 拿到写锁之后再读一次：serve 与 token 命令可能同时打开同一个旧库，另一边也许刚迁移完。
    const version = schemaVersion(db);
    for (let step = version; step < SCHEMA_VERSION; step++) db.exec(MIGRATIONS[step]!);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
}

/** 写事务。BEGIN IMMEDIATE：先拿写锁，免得读后写升级锁时与另一个进程死锁。 */
export function transaction<T>(db: Database, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** 库内统一时间格式：RFC 3339 UTC 毫秒，与 AyanamiCloud 的 `2006-01-02T15:04:05.000Z` 相同。 */
export function nowIso(now: number = Date.now()): string {
  return new Date(now).toISOString();
}
