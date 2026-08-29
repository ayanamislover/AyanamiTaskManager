import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AyanamiTaskService } from "../packages/application/src/index.js";

type Metric = { p95Ms: number; targetMs: number; passed: boolean; samples: number[] };

const root = process.cwd();
const outputDir = join(root, "output");
const dataDir = join(outputDir, "benchmark-data");
const reportPath = join(outputDir, "benchmark-report.json");
await mkdir(outputDir, { recursive: true });
await rm(dataDir, { recursive: true, force: true });

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

async function measure(
  action: () => Promise<unknown> | unknown,
  iterations: number,
  targetMs: number,
): Promise<Metric> {
  await action();
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now();
    await action();
    samples.push(performance.now() - start);
  }
  const value = p95(samples);
  return {
    p95Ms: Number(value.toFixed(3)),
    targetMs,
    passed: value <= targetMs,
    samples: samples.map((sample) => Number(sample.toFixed(3))),
  };
}

let service = await AyanamiTaskService.open({ dataDir, migrationsRoot: join(root, "migrations") });
const primary = await service.createProject({ name: "性能基准", sourcePath: null, code: "PFM" });
for (let index = 1; index < 100; index += 1) {
  await service.createProject({
    name: `性能项目 ${index}`,
    sourcePath: null,
    code: `P${String(index).padStart(3, "0")}`,
  });
}
const objective = await service.createObjectiveAsUser(primary.code, "benchmark-objective", {
  title: "性能基准目标",
  description: "在真实 SQLite 文件上验证规格预算",
  definitionOfDone: [],
});

for (let batch = 0; batch < 200; batch += 1) {
  await service.createWorkItemsAsUser(
    primary.code,
    `benchmark-batch-${batch}`,
    Array.from({ length: 50 }, (_, offset) => {
      const index = batch * 50 + offset;
      return {
        clientRef: `benchmark-${index}`,
        objectiveId: objective.id,
        title: `性能任务 ${String(index).padStart(5, "0")}`,
        description: `用于筛选性能基准的真实任务 ${index}`,
        type: "TASK" as const,
        priority: index % 20 === 0 ? ("HIGH" as const) : ("NORMAL" as const),
        status: index % 3 === 0 ? ("BACKLOG" as const) : ("READY" as const),
        acceptance: [],
        checklist: [],
        verificationRequired: false,
      };
    }),
  );
}
service.close();

const direct = new Database(primary.databasePath);
direct.pragma("journal_mode = WAL");
direct.pragma("synchronous = FULL");
const insertDocument = direct.prepare(
  "INSERT INTO search_documents(entity_type, entity_id, entity_key, title, body, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
);
const insertFts = direct.prepare(
  "INSERT INTO search_documents_fts(entity_type, entity_id, entity_key, title, body) VALUES (?, ?, ?, ?, ?)",
);
const insertSearchCorpus = direct.transaction(() => {
  const now = new Date().toISOString();
  for (let index = 0; index < 40_000; index += 1) {
    const id = `benchmark-document-${index}`;
    const key = `DOC-${index}`;
    const title = `中文性能文档 ${index}`;
    const body = `项目验证关键词 任务管理 本地优先 第 ${index} 条`;
    insertDocument.run("RECORD", id, key, title, body, now);
    insertFts.run("RECORD", id, key, title, body);
  }
});
insertSearchCorpus();
direct.close();

const coldStartAt = performance.now();
service = await AyanamiTaskService.open({ dataDir, migrationsRoot: join(root, "migrations") });
const coldStartMs = performance.now() - coldStartAt;
const overview = await measure(() => service.overview(), 30, 200);
const filteredList = await measure(
  () => service.listWorkItems(primary.code, { status: "READY", limit: 100, offset: 4_000 }),
  30,
  200,
);
const search = await measure(() => service.search(primary.code, "项目验证关键词", 20), 30, 300);
const delta = await measure(() => service.delta(primary.code, 0, 100), 30, 100);

let mutable: { key: string; version: number } = (
  await service.listWorkItems(primary.code, { limit: 1 })
)[0]!;
const writeSamples: number[] = [];
for (let index = 0; index < 30; index += 1) {
  const start = performance.now();
  const result = await service.patchWorkItemsAsUser(primary.code, `benchmark-patch-${index}`, [
    {
      taskKey: mutable.key,
      expectedVersion: mutable.version,
      operation: "edit",
      title: `性能写入 ${index}`,
    },
  ]);
  writeSamples.push(performance.now() - start);
  mutable = { key: result.items[0]!.key, version: result.items[0]!.version };
}
const writeP95 = p95(writeSamples);
const statusWrite: Metric = {
  p95Ms: Number(writeP95.toFixed(3)),
  targetMs: 100,
  passed: writeP95 <= 100,
  samples: writeSamples.map((sample) => Number(sample.toFixed(3))),
};
service.close();
const memoryProbe = spawnSync(
  process.execPath,
  ["--expose-gc", "--import", "tsx", join(root, "scripts", "benchmark-memory.ts"), dataDir],
  { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 * 4 },
);
if (memoryProbe.status !== 0) throw new Error(`空闲内存探针失败：${memoryProbe.stderr}`);
const memoryResult = JSON.parse(memoryProbe.stdout.trim()) as {
  rssMb: number;
  rssSamplesMb: number[];
};
const rssMb = Number(memoryResult.rssMb);
const report = {
  generatedAt: new Date().toISOString(),
  data: {
    realSqlite: existsSync(primary.databasePath),
    projects: 100,
    workItems: 10_000,
    searchDocuments: 50_000,
  },
  metrics: {
    coldStart: {
      milliseconds: Number(coldStartMs.toFixed(3)),
      targetMs: 3_000,
      passed: coldStartMs <= 3_000,
    },
    overview100Projects: overview,
    filteredList10000Items: filteredList,
    singleWriteAndEvent: statusWrite,
    delta100Events: delta,
    chineseSearch50000Documents: search,
    serviceRss: {
      megabytes: Number(rssMb.toFixed(2)),
      targetMb: 150,
      passed: rssMb <= 150,
      samples: memoryResult.rssSamplesMb.map((sample) => Number(sample.toFixed(2))),
    },
  },
};
const passed = Object.values(report.metrics).every((metric) => metric.passed);
await writeFile(reportPath, `${JSON.stringify({ passed, ...report }, null, 2)}\n`, "utf8");
await rm(dataDir, { recursive: true, force: true });
process.stdout.write(
  `${JSON.stringify({ passed, reportPath, metrics: report.metrics }, null, 2)}\n`,
);
if (!passed) process.exitCode = 1;
