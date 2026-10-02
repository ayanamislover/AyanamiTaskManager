// 打开库（peer R2-04）：serve 与管理命令同时首次打开空目录、或同时打开非 WAL 的 v1 库，
// 每个打开者都要成功并看到同一个结果；切 WAL 的重试有界；打开、迁移或启动服务失败时连接必须已经关掉。
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DATABASE_FILE,
  type Database,
  SCHEMA_V1,
  SCHEMA_VERSION,
  WAL_SWITCH_ATTEMPTS,
  enableWal,
  isBusyError,
  loadSqlite,
  openDatabase,
} from "../src/database.js";
import { startRelay } from "../src/server.js";
import { cleanupHarness, startTestRelay, tempDataDir } from "./support/relay-harness.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupHarness();
});

const DATABASE_MODULE = new URL("../src/database.ts", import.meta.url).href;

/** v2 库应有的全部表（不含 sqlite_*）：没有 v1 的逐键高水位表 revisions。 */
const V2_TABLES = ["apps", "changes", "documents", "meta", "revision_floors", "tokens"];

type Snapshot = {
  version: number;
  journal: string;
  tables: string[];
  floors: [string, number][];
};
type OpenOutcome = { ok: true; snapshot: Snapshot } | { ok: false; message: string };

// 打开者线程：先加载模块，再在自旋屏障上会合，尽量在同一时刻调用 openDatabase。
// 屏障带 10 秒期限，免得某个线程加载失败时其余线程永远自旋。
const OPENER_SOURCE = `
const { workerData, parentPort } = require("node:worker_threads");
(async () => {
  const { openDatabase } = await import(workerData.moduleUrl);
  const arrived = new Int32Array(workerData.barrier);
  Atomics.add(arrived, 0, 1);
  const deadline = Date.now() + 10000;
  while (Atomics.load(arrived, 0) < workerData.parties && Date.now() < deadline) {}
  let db;
  try {
    db = openDatabase(workerData.dir);
  } catch (error) {
    parentPort.postMessage({ ok: false, message: String((error && error.message) || error) });
    return;
  }
  try {
    const one = (sql) => db.prepare(sql).get();
    const snapshot = {
      version: one("PRAGMA user_version").user_version,
      journal: one("PRAGMA journal_mode").journal_mode,
      tables: db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite%' ORDER BY name")
        .all()
        .map((row) => row.name),
      floors: db
        .prepare("SELECT app_id, revision FROM revision_floors ORDER BY app_id")
        .all()
        .map((row) => [row.app_id, row.revision]),
    };
    parentPort.postMessage({ ok: true, snapshot });
  } finally {
    db.close();
  }
})();
`;

function runOpener(dir: string, barrier: SharedArrayBuffer, parties: number): Promise<OpenOutcome> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(OPENER_SOURCE, {
      eval: true,
      workerData: { moduleUrl: DATABASE_MODULE, dir, barrier, parties },
    });
    let outcome: OpenOutcome | undefined;
    worker.once("message", (message: OpenOutcome) => {
      outcome = message;
    });
    worker.once("error", reject);
    // 等线程退出再交结果：它的连接这时一定关了，Windows 上临时目录才删得掉。
    worker.once("exit", (code) => {
      if (outcome) resolve(outcome);
      else reject(new Error(`打开者线程退出（${code}），没有回报结果`));
    });
  });
}

async function openConcurrently(dir: string, parties: number): Promise<OpenOutcome[]> {
  const barrier = new SharedArrayBuffer(4);
  return Promise.all(Array.from({ length: parties }, () => runOpener(dir, barrier, parties)));
}

/** 回滚日志模式（非 WAL）的 v1 库：一个现存文档、一个只剩高水位的已删除键、另一个 app。 */
function writeV1Database(dir: string): void {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(join(dir, DATABASE_FILE));
  try {
    db.exec(SCHEMA_V1);
    db.exec("PRAGMA user_version = 1");
    const at = "2026-09-20T00:00:00.000Z";
    db.exec(
      `INSERT INTO apps (id, name, created_at) VALUES ('atm', 'ATM', '${at}'), ('other', '别的', '${at}')`,
    );
    db.exec(
      `INSERT INTO documents (app_id, key, schema_version, revision, data, size_bytes, updated_at)
       VALUES ('atm', 'live', 1, 7, '1', 1, '${at}')`,
    );
    db.exec(
      "INSERT INTO revisions (app_id, key, revision) VALUES ('atm', 'live', 7), ('atm', 'gone', 99), ('other', 'x', 4)",
    );
    const journal = (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string })
      .journal_mode;
    expect(journal, "前提：旧库不是 WAL").not.toBe("wal");
  } finally {
    db.close();
  }
}

function expectAllAgree(outcomes: OpenOutcome[], floors: [string, number][]): void {
  const failures = outcomes.filter((outcome) => !outcome.ok);
  expect(failures, JSON.stringify(failures)).toEqual([]);
  for (const outcome of outcomes) {
    if (!outcome.ok) continue;
    expect(outcome.snapshot).toEqual({
      version: SCHEMA_VERSION,
      journal: "wal",
      tables: V2_TABLES,
      floors,
    });
  }
}

const ROUNDS = 8;
const PARTIES = 3;
// 打开者线程直接加载 src/database.ts，靠 Node 内置的类型擦除（CI 固定 Node 24）。
const canStripTypes = Boolean((process.features as { typescript?: unknown }).typescript);

describe.skipIf(!canStripTypes)("并发打开", () => {
  it(`${PARTIES} 个线程同时首次打开空目录：全部成功，结果一致（重复 ${ROUNDS} 轮）`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const outcomes = await openConcurrently(tempDataDir(), PARTIES);
      expectAllAgree(outcomes, []);
    }
  });

  it(`${PARTIES} 个线程同时打开非 WAL 的 v1 库：全部成功，只迁移一次，地板正确、旧表已删（重复 ${ROUNDS} 轮）`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const dir = tempDataDir();
      writeV1Database(dir);
      const outcomes = await openConcurrently(dir, PARTIES);
      expectAllAgree(outcomes, [
        ["atm", 99],
        ["other", 4],
      ]);
    }
  });
});

describe("切 WAL 的有界重试", () => {
  const busy = (errcode: number) =>
    Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode });

  function flakyDb(failures: Error[]) {
    const calls: string[] = [];
    return {
      calls,
      db: {
        exec(sql: string) {
          calls.push(sql);
          const next = failures.shift();
          if (next) throw next;
        },
      },
    };
  }

  it("BUSY/LOCKED（含扩展码）按 25ms 起翻倍退避重试，成功即停", () => {
    const sleeps: number[] = [];
    const { db, calls } = flakyDb([busy(5), busy(262), busy(6)]);
    enableWal(db, 5000, (ms) => sleeps.push(ms));
    expect(calls).toEqual(Array(4).fill("PRAGMA journal_mode = WAL"));
    expect(sleeps).toEqual([25, 50, 100]);
  });

  it(`一直 BUSY：最多试 ${WAL_SWITCH_ATTEMPTS} 次后抛出原错误`, () => {
    const sleeps: number[] = [];
    const errors = Array.from({ length: 20 }, () => busy(5));
    const last = errors[WAL_SWITCH_ATTEMPTS - 1];
    const { db, calls } = flakyDb(errors);
    expect(() => enableWal(db, 5000, (ms) => sleeps.push(ms))).toThrow(last);
    expect(calls).toHaveLength(WAL_SWITCH_ATTEMPTS);
    expect(sleeps).toEqual([25, 50, 100, 200]);
  });

  it("别的错误不重试；累计耗时已超过 busy_timeout 也不再重试", () => {
    const sleeps: number[] = [];
    const ioError = Object.assign(new Error("disk I/O error"), { errcode: 10 });
    const io = flakyDb([ioError]);
    expect(() => enableWal(io.db, 5000, (ms) => sleeps.push(ms))).toThrow(ioError);
    expect(io.calls).toHaveLength(1);

    const spent = flakyDb([busy(5), busy(5)]);
    expect(() => enableWal(spent.db, 0, (ms) => sleeps.push(ms))).toThrow(/locked/);
    expect(spent.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("isBusyError 认 errcode 的低 8 位，没有 errcode 时认错误文本", () => {
    expect(isBusyError(busy(517))).toBe(true); // SQLITE_BUSY_SNAPSHOT
    expect(isBusyError(Object.assign(new Error("x"), { errcode: 1 }))).toBe(false);
    expect(isBusyError(new Error("database table is locked"))).toBe(true);
    expect(isBusyError(new Error("no such table: x"))).toBe(false);
    expect(isBusyError(null)).toBe(false);
  });
});

describe("打开失败时关闭连接", () => {
  /** 监视 close：mock.contexts 就是被关的连接，可以再确认它确实不能用了。 */
  function watchClose() {
    return vi.spyOn(loadSqlite().DatabaseSync.prototype, "close");
  }

  function expectClosed(connections: unknown[]): void {
    expect(connections).toHaveLength(1);
    expect(() => (connections[0] as Database).prepare("SELECT 1")).toThrow();
  }

  it("库版本比本程序新：抛错，连接已关", () => {
    const dir = tempDataDir();
    const { DatabaseSync } = loadSqlite();
    const future = new DatabaseSync(join(dir, DATABASE_FILE));
    future.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    future.close();

    const close = watchClose();
    expect(() => openDatabase(dir)).toThrow(/更新版本/);
    expectClosed(close.mock.contexts);
  });

  it("迁移失败：整体回滚，库仍是 v1，连接已关", () => {
    const dir = tempDataDir();
    writeV1Database(dir);
    const { DatabaseSync } = loadSqlite();
    const sabotage = new DatabaseSync(join(dir, DATABASE_FILE));
    sabotage.exec("CREATE TABLE revision_floors (x)"); // 让 v1 → v2 的 CREATE TABLE 失败
    sabotage.close();

    const close = watchClose();
    expect(() => openDatabase(dir)).toThrow(/revision_floors/);
    expectClosed(close.mock.contexts);
    close.mockRestore();

    const check = new DatabaseSync(join(dir, DATABASE_FILE));
    try {
      expect(check.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      const revisions = check.prepare("SELECT COUNT(*) AS n FROM revisions").get() as { n: number };
      expect(revisions.n).toBe(3);
    } finally {
      check.close();
    }
  });

  it("锁一直被别的连接占着：等满 busy_timeout、不再重试，抛 database is locked，连接已关", () => {
    const dir = tempDataDir();
    writeV1Database(dir);
    const { DatabaseSync } = loadSqlite();
    const holder = new DatabaseSync(join(dir, DATABASE_FILE));
    try {
      holder.exec("BEGIN EXCLUSIVE");
      const close = watchClose();
      const started = performance.now();
      let thrown: unknown;
      try {
        openDatabase(dir, { busyTimeoutMs: 200 });
      } catch (error) {
        thrown = error;
      }
      const elapsed = performance.now() - started;
      expect(isBusyError(thrown), String(thrown)).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(150);
      expect(elapsed).toBeLessThan(3000);
      expectClosed(close.mock.contexts);
      close.mockRestore();
      holder.exec("ROLLBACK");
    } finally {
      holder.close();
    }
    // 锁放开之后照常打开并完成迁移。
    const db = openDatabase(dir);
    try {
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    } finally {
      db.close();
    }
  });

  it("startRelay 打开库之后监听失败（端口被占）：抛错，库已关", async () => {
    const running = await startTestRelay();
    const close = watchClose();
    await expect(
      startRelay({ dataDir: tempDataDir(), host: "127.0.0.1", port: running.relay.port }),
    ).rejects.toThrow(/EADDRINUSE/);
    expectClosed(close.mock.contexts);
  });
});
