import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { AyanamiDatabaseManager } from "../packages/storage-sqlite/src/index.js";

// Each query runs in a fresh, bounded child. Heap values are sampled after
// SQLite materialization and each JSON parse, not claimed as a continuous peak.
if (process.argv[2] === "--measure") {
  const mode = process.argv[3];
  if (mode !== "legacy" && mode !== "projected") throw Error("Unknown benchmark mode");
  const db = new Database(process.argv[4]!, { readonly: true, fileMustExist: true });
  try {
    global.gc?.();
    const startHeap = process.memoryUsage().heapUsed;
    let sampledPeakHeap = startHeap;
    const started = performance.now();
    const rows = db
      .prepare(
        `SELECT ${mode === "legacy" ? "snapshot" : "json_remove(snapshot, '$.bodyMarkdown')"} AS snapshot FROM knowledge_revisions ORDER BY revision DESC LIMIT 51`,
      )
      .all() as { snapshot: string }[];
    sampledPeakHeap = Math.max(sampledPeakHeap, process.memoryUsage().heapUsed);
    const metadata = rows.slice(0, 50).map((row) => {
      const value = JSON.parse(row.snapshot) as Record<string, unknown>;
      sampledPeakHeap = Math.max(sampledPeakHeap, process.memoryUsage().heapUsed);
      delete value.bodyMarkdown;
      return value;
    });
    console.log(
      JSON.stringify({
        mode,
        rows: metadata.length,
        elapsedMs: performance.now() - started,
        serializedRowsChars: rows.reduce((sum, row) => sum + row.snapshot.length, 0),
        sampledHeapGrowthBytes: sampledPeakHeap - startHeap,
        processPeakRssKb: process.resourceUsage().maxRSS,
      }),
    );
  } finally {
    db.close();
  }
} else {
  const root = await mkdtemp(join(tmpdir(), "atm-knowledge-history-bench-"));
  const manager = await AyanamiDatabaseManager.open({
    dataDir: root,
    migrationsRoot: resolve("migrations"),
  });
  try {
    const repository = await manager.knowledge.open();
    const content = {
      slug: "large-history",
      title: "历史测量",
      summary: "仅元数据",
      bodyMarkdown: "x".repeat(500000),
    };
    let entry = repository.save({ ...content, opId: "create", expectedVersion: 0 });
    for (let index = 1; index < 60; index++)
      entry = repository.save({
        ...content,
        id: entry.id,
        opId: `revision-${index}`,
        expectedVersion: entry.version,
        expectedRevisionId: entry.revisionId,
      });
    const receipts = repository.database.sqlite
      .prepare("SELECT count(*) AS rows, sum(length(receipt)) AS chars FROM knowledge_operations")
      .get();
    const dbPath = repository.database.path;
    manager.close();
    const results = ["legacy", "projected"].map(
      (mode) =>
        JSON.parse(
          execFileSync(
            process.execPath,
            [
              "--expose-gc",
              "--import",
              "tsx",
              fileURLToPath(import.meta.url),
              "--measure",
              mode,
              dbPath,
            ],
            { encoding: "utf8", windowsHide: true, maxBuffer: 100000, timeout: 30000 },
          ),
        ) as Record<string, unknown>,
    );
    const report = {
      bodyChars: 500000,
      revisions: 60,
      receipts,
      results,
      measurement:
        "isolated child; sampled JS heap and process peak RSS, not a continuous JS heap peak",
    };
    await mkdir("output", { recursive: true });
    await writeFile("output/knowledge-history-benchmark.json", JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    manager.close();
    await rm(root, { recursive: true, force: true });
  }
}
