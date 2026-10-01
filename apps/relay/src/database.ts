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

/** 拿不到锁时 SQLite 自己等多久（毫秒）。serve 与管理命令并发打开同一个库时靠它排队。 */
export const BUSY_TIMEOUT_MS = 5000;

/**
 * 切 WAL 的有界重试：最多 WAL_SWITCH_ATTEMPTS 次，第 n 次失败后睡 WAL_RETRY_BASE_MS·2^(n−1)
 * （25、50、100、200 ms，合计 375 ms）；累计耗时已超过 busy_timeout 就不再重试——那说明锁被长期占着，
 * 不是两个打开者撞车。最坏约两倍 busy_timeout 后抛出原错误。
 */
export const WAL_SWITCH_ATTEMPTS = 5;
const WAL_RETRY_BASE_MS = 25;

export type OpenDatabaseOptions = {
  /** 覆盖 BUSY_TIMEOUT_MS（测试用：让「锁一直被占着」的失败路径快点结束）。 */
  busyTimeoutMs?: number;
};

/**
 * 打开（必要时创建）数据目录下的库。打开或迁移失败时先关掉连接再抛出，不留文件句柄。
 *
 * 顺序有讲究：busy_timeout 必须是第一条语句。它不碰文件锁，而后面的切 WAL、读库版本、迁移事务都要锁；
 * 若先切 WAL 后设等待，serve 与 `token …` 同时首次打开空目录或非 WAL 的旧库时，争锁的一方会直接报
 * `database is locked`，根本到不了迁移事务。只提前 busy_timeout 还不够（实测 3 个打开者仍有过半轮次失败），
 * 切 WAL 另有有界重试，见 enableWal。迁移事务里重读库版本，保证多个打开者只有一个真正迁移。
 */
export function openDatabase(dataDir: string, options: OpenDatabaseOptions = {}): Database {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(join(dataDir, DATABASE_FILE));
  try {
    const busyTimeoutMs = Math.max(0, Math.floor(options.busyTimeoutMs ?? BUSY_TIMEOUT_MS));
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    // WAL 让 serve 与管理命令读写互不阻塞。
    enableWal(db, busyTimeoutMs);
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
    return db;
  } catch (error) {
    closeQuietly(db);
    throw error;
  }
}

function closeQuietly(db: Database): void {
  try {
    db.close();
  } catch {
    // 已经关了或关不掉：都不该盖住真正的错误。
  }
}

/** SQLITE_BUSY（5）或 SQLITE_LOCKED（6），含扩展码（看低 8 位）。没有 errcode 的旧版 Node 按错误文本兜底。 */
export function isBusyError(error: unknown): boolean {
  const errcode = (error as { errcode?: unknown } | null)?.errcode;
  if (typeof errcode === "number") return (errcode & 0xff) === 5 || (errcode & 0xff) === 6;
  return /database (table )?is locked/i.test(String((error as Error | null)?.message ?? ""));
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/** openDatabase 是同步接口，退避也只能同步睡。 */
function sleepSync(ms: number): void {
  Atomics.wait(sleepCell, 0, 0, ms);
}

/**
 * 从回滚日志切到 WAL 要短暂独占整个库。busy_timeout 让 SQLite 拿不到锁时先等，但 SQLite 判断
 * 「等下去可能死锁」时会不等、直接回 SQLITE_BUSY；两个连接同时首次打开正是这种情形。
 * 所以 BUSY/LOCKED 再按 WAL_SWITCH_ATTEMPTS 的规则有界重试，别的错误原样抛出。
 */
export function enableWal(
  db: Pick<Database, "exec">,
  busyTimeoutMs: number,
  sleep: (ms: number) => void = sleepSync,
): void {
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (error) {
      const spent = Date.now() - started;
      if (!isBusyError(error) || attempt >= WAL_SWITCH_ATTEMPTS || spent >= busyTimeoutMs) {
        throw error;
      }
      sleep(WAL_RETRY_BASE_MS * 2 ** (attempt - 1));
    }
  }
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
