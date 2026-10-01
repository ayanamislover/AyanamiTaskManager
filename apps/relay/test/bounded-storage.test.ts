// 磁盘有界与防 ABA（peer R1-07）：大量不同键「新建 → 删除」之后库里的行数仍有上限；
// 删掉重建的键不接受任何旧修订号；v1 库（逐键高水位表）能平滑迁移到每 app 一行的修订号地板。
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DATABASE_FILE,
  type Database,
  SCHEMA_V1,
  SCHEMA_VERSION,
  loadSqlite,
} from "../src/database.js";
import { encodeChangeCursor } from "../src/documents.js";
import { call, cleanupHarness, startTestRelay, tempDataDir } from "./support/relay-harness.js";

afterEach(cleanupHarness);

const doc = (key: string) => `/v1/apps/atm/documents/${encodeURIComponent(key)}`;

/** 只有管理命令能写的表：不随数据接口的请求增长，不计入数据行数。 */
const ADMIN_TABLES = new Set(["apps", "tokens", "meta"]);

/** 库里每张表的行数（不含 SQLite 自己的 sqlite_* 表）。新加的表自动纳入，不用改这里。 */
function rowCounts(db: Database): Record<string, number> {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite%'")
    .all() as { name: string }[];
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    counts[name] = (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n;
  }
  return counts;
}

function dataRows(counts: Record<string, number>): number {
  return Object.entries(counts)
    .filter(([table]) => !ADMIN_TABLES.has(table))
    .reduce((sum, [, n]) => sum + n, 0);
}

function floors(db: Database): Record<string, number> {
  const rows = db.prepare("SELECT app_id, revision FROM revision_floors").all() as {
    app_id: string;
    revision: number;
  }[];
  return Object.fromEntries(rows.map((row) => [row.app_id, row.revision]));
}

function schemaOf(db: Database): { type: string; name: string; sql: string | null }[] {
  return db
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite%' ORDER BY name",
    )
    .all() as { type: string; name: string; sql: string | null }[];
}

describe("磁盘有界", () => {
  it("大量不同键「新建 → 删除」后，数据表总行数 ≤ 文档上限 + 变更保留条数 + 1，与键的个数无关", async () => {
    const limits = { maxDocumentsPerApp: 1, maxBytesPerApp: 10, changeRetentionCount: 1 };
    const relay = await startTestRelay({ limits });
    const KEYS = 200;
    for (let i = 0; i < KEYS; i++) {
      const key = doc(`cmd/${i}`);
      const created = await call(relay, "PUT", key, { body: { expected_revision: 0, data: 1 } });
      expect(created.status, `第 ${i} 个键新建`).toBe(201);
      const removed = await call(
        relay,
        "DELETE",
        `${key}?expected_revision=${created.json.revision}`,
      );
      expect(removed.status, `第 ${i} 个键删除`).toBe(204);
    }

    const counts = rowCounts(relay.relay.db);
    expect(counts.documents).toBe(0);
    expect(counts.changes).toBeLessThanOrEqual(limits.changeRetentionCount);
    // 数据接口能写到的全部表加起来有界：没有任何一张表为删掉的键留行。
    const bound = limits.maxDocumentsPerApp + limits.changeRetentionCount + 1;
    expect(dataRows(counts), JSON.stringify(counts)).toBeLessThanOrEqual(bound);

    // 配额照常生效：占着一个文档时再建第二个 507。
    const kept = await call(relay, "PUT", doc("kept"), { body: { expected_revision: 0, data: 1 } });
    expect(kept.status).toBe(201);
    const extra = await call(relay, "PUT", doc("extra"), {
      body: { expected_revision: 0, data: 1 },
    });
    expect(extra.status).toBe(507);
    expect(extra.json.error.code).toBe("INSUFFICIENT_STORAGE");
    expect(dataRows(rowCounts(relay.relay.db))).toBeLessThanOrEqual(bound);
  });
});

describe("防 ABA", () => {
  it("删掉重建的键：以前的任何修订号（含删除用掉的那个）做条件写一律 409", async () => {
    const relay = await startTestRelay();
    const key = doc("aba");
    const first = await call(relay, "PUT", key, { body: { expected_revision: 0, data: { g: 1 } } });
    const r1 = first.json.revision as number;
    const second = await call(relay, "PUT", key, {
      body: { expected_revision: r1, data: { g: 2 } },
    });
    const r2 = second.json.revision as number;
    expect(r2).toBe(r1 + 1);
    expect((await call(relay, "DELETE", `${key}?expected_revision=${r2}`)).status).toBe(204);
    const deletedAt = r2 + 1;

    // 删除之后应用里还有别的键在「新建 → 删除」，地板继续抬升也不影响结论。
    for (let i = 0; i < 5; i++) {
      const other = doc(`churn/${i}`);
      const made = await call(relay, "PUT", other, { body: { expected_revision: 0, data: i } });
      await call(relay, "DELETE", `${other}?expected_revision=${made.json.revision}`);
    }

    const again = await call(relay, "PUT", key, { body: { expected_revision: 0, data: { g: 3 } } });
    expect(again.status).toBe(201);
    const r3 = again.json.revision as number;
    expect(r3).toBeGreaterThan(deletedAt);
    for (const stale of [r1, r2, deletedAt]) {
      const put = await call(relay, "PUT", key, {
        body: { expected_revision: stale, data: { g: "stale" } },
      });
      expect(put.status, `PUT expected_revision=${stale}`).toBe(409);
      expect(put.json.current.revision).toBe(r3);
      const del = await call(relay, "DELETE", `${key}?expected_revision=${stale}`);
      expect(del.status, `DELETE expected_revision=${stale}`).toBe(409);
    }
    expect((await call(relay, "GET", key)).json.data).toEqual({ g: 3 });

    // 重建后的世代照常逐次 +1；变更流里同一个键的修订号在各世代之间严格递增。
    const next = await call(relay, "PUT", key, { body: { expected_revision: r3, data: { g: 4 } } });
    expect(next.json.revision).toBe(r3 + 1);
    const feed = await call(relay, "GET", "/v1/apps/atm/changes?limit=500");
    const ours = (feed.json.changes as { key: string; op: string; revision: number }[])
      .filter((change) => change.key === "aba")
      .map((change) => [change.op, change.revision]);
    expect(ours).toEqual([
      ["put", r1],
      ["put", r2],
      ["delete", deletedAt],
      ["put", r3],
      ["put", r3 + 1],
    ]);
  });

  it("没删过文档的应用里新键从 1 开始；删过之后新键取「删除用过的最大修订号 + 1」，更新仍逐次 +1", async () => {
    const relay = await startTestRelay();
    const put = async (key: string, expected: number) =>
      (await call(relay, "PUT", doc(key), { body: { expected_revision: expected, data: 1 } })).json
        .revision as number;
    const remove = (key: string, expected: number) =>
      call(relay, "DELETE", `${doc(key)}?expected_revision=${expected}`);

    expect(await put("a", 0)).toBe(1);
    expect(await put("a", 1)).toBe(2);
    expect(await put("b", 0)).toBe(1);
    expect((await remove("a", 2)).status).toBe(204); // 删除用掉 3，地板 = 3
    expect(await put("c", 0)).toBe(4);
    expect(await put("b", 1)).toBe(2); // 更新不看地板
    expect((await remove("b", 2)).status).toBe(204); // 删除用掉 3，地板不降
    expect(await put("d", 0)).toBe(4);
    expect(floors(relay.relay.db)).toEqual({ atm: 3 });
  });
});

describe("库迁移 v1 → v2", () => {
  it("逐键高水位折算成每 app 的地板后删除；旧文档、旧游标照常可用，删掉的键重建不撞旧修订号", async () => {
    const dataDir = tempDataDir();
    const at = "2026-09-20T00:00:00.000Z";
    const { DatabaseSync } = loadSqlite();
    const old = new DatabaseSync(join(dataDir, DATABASE_FILE));
    old.exec(SCHEMA_V1);
    old.exec("PRAGMA user_version = 1");
    const app = old.prepare("INSERT INTO apps (id, name, created_at) VALUES (?, ?, ?)");
    app.run("atm", "AyanamiTaskManager", at);
    app.run("other", "别的应用", at);
    old
      .prepare(
        `INSERT INTO documents (app_id, key, schema_version, revision, data, size_bytes, updated_at)
         VALUES ('atm', 'live', 1, 7, '{"v":7}', 7, ?)`,
      )
      .run(at);
    const highWater = old.prepare("INSERT INTO revisions (app_id, key, revision) VALUES (?, ?, ?)");
    highWater.run("atm", "live", 7);
    highWater.run("atm", "gone", 12); // 已删除的键：它的历史只剩这一行
    highWater.run("atm", "older", 3);
    highWater.run("other", "x", 4);
    const change = old.prepare(
      "INSERT INTO changes (app_id, key, revision, op, at) VALUES (?, ?, ?, ?, ?)",
    );
    change.run("atm", "gone", 12, "delete", at); // seq 1
    change.run("atm", "live", 7, "put", at); // seq 2
    change.run("other", "x", 4, "delete", at); // seq 3
    old.close();

    const relay = await startTestRelay({ dataDir, now: () => Date.parse("2026-09-21T00:00:00Z") });
    const db = relay.relay.db;
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      SCHEMA_VERSION,
    );
    expect(Object.keys(rowCounts(db))).not.toContain("revisions");
    expect(floors(db)).toEqual({ atm: 12, other: 4 });

    // 旧文档原样可读，按旧修订号更新照常 +1。
    const live = await call(relay, "GET", doc("live"));
    expect(live.json).toMatchObject({ revision: 7, data: { v: 7 } });
    const updated = await call(relay, "PUT", doc("live"), {
      body: { expected_revision: 7, data: { v: 8 } },
    });
    expect(updated.json.revision).toBe(8);

    // 只剩旧高水位的键：重建严格大于它以前的修订号，旧修订号 409。
    const rebuilt = await call(relay, "PUT", doc("gone"), {
      body: { expected_revision: 0, data: { v: "new" } },
    });
    expect(rebuilt.status).toBe(201);
    expect(rebuilt.json.revision).toBe(13);
    for (const stale of [3, 12]) {
      const conflict = await call(relay, "PUT", doc("gone"), {
        body: { expected_revision: stale, data: { v: "stale" } },
      });
      expect(conflict.status).toBe(409);
    }

    // 迁移不动 seq：迁移前拿到的游标继续增量，不被判过期。
    const feed = await call(relay, "GET", `/v1/apps/atm/changes?cursor=${encodeChangeCursor(1)}`);
    expect(feed.status).toBe(200);
    expect(
      feed.json.changes.map((c: { key: string; revision: number }) => [c.key, c.revision]),
    ).toEqual([
      ["live", 7],
      ["live", 8],
      ["gone", 13],
    ]);

    // 再打开一次不重复迁移；结构与新建的库完全一致。
    await relay.stop();
    const reopened = await startTestRelay({ dataDir });
    expect(floors(reopened.relay.db)).toEqual({ atm: 12, other: 4 });
    const fresh = await startTestRelay();
    expect(schemaOf(reopened.relay.db)).toEqual(schemaOf(fresh.relay.db));
  });
});
