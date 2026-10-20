/**
 * 真实规模的 2.x 样本库（ATM 3 规格 08 §1）：100 个项目、主项目 PFM 里 1 万条任务、4 万条检索文档。
 * budget-measure（预算）与 power-loss-drill（掉电演练）用同一份：由 2.x 的应用层生成一次，
 * 之后每一轮复制一份当作 2.x 根 L。
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { AyanamiTaskService } from "../packages/application/src/index.js";

export const SAMPLE = { projects: 100, workItems: 10_000, searchDocuments: 40_000 } as const;
const MARKER = "budget-seed.json";

function directoryBytes(path: string): number {
  let bytes = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    bytes += entry.isDirectory() ? directoryBytes(child) : statSync(child).size;
  }
  return bytes;
}

/** 样本库在 seedDir 里就直接用（看标记文件），没有就生成。返回规模与生成耗时。 */
export async function ensureSampleLibrary(
  seedDir: string,
  repoRoot: string,
): Promise<Record<string, unknown>> {
  const marker = join(seedDir, MARKER);
  if (existsSync(marker)) return JSON.parse(readFileSync(marker, "utf8"));
  rmSync(seedDir, { recursive: true, force: true });
  mkdirSync(seedDir, { recursive: true });
  const started = performance.now();
  const service = await AyanamiTaskService.open({
    dataDir: seedDir,
    migrationsRoot: join(repoRoot, "migrations"),
  });
  const primary = await service.createProject({ name: "预算基准", sourcePath: null, code: "PFM" });
  for (let index = 1; index < SAMPLE.projects; index += 1)
    await service.createProject({
      name: `预算项目 ${index}`,
      sourcePath: null,
      code: `P${String(index).padStart(3, "0")}`,
    });
  const objective = await service.createObjectiveAsUser(primary.code, "budget-objective", {
    title: "预算基准目标",
    description: "真实规模样本库",
    definitionOfDone: [],
  });
  for (let batch = 0; batch < SAMPLE.workItems / 50; batch += 1)
    await service.createWorkItemsAsUser(
      primary.code,
      `budget-batch-${batch}`,
      Array.from({ length: 50 }, (_, offset) => {
        const index = batch * 50 + offset;
        return {
          clientRef: `budget-${index}`,
          objectiveId: objective.id,
          title: `预算任务 ${String(index).padStart(5, "0")}`,
          description: `真实规模样本任务 ${index}`,
          type: "TASK" as const,
          priority: index % 20 === 0 ? ("HIGH" as const) : ("NORMAL" as const),
          status: index % 3 === 0 ? ("BACKLOG" as const) : ("READY" as const),
          acceptance: [],
          checklist: [],
          verificationRequired: false,
        };
      }),
    );
  service.close();
  const direct = new Database(primary.databasePath);
  direct.pragma("journal_mode = WAL");
  const insertDocument = direct.prepare(
    "INSERT INTO search_documents(entity_type, entity_id, entity_key, title, body, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertFts = direct.prepare(
    "INSERT INTO search_documents_fts(entity_type, entity_id, entity_key, title, body) VALUES (?, ?, ?, ?, ?)",
  );
  direct.transaction(() => {
    const now = new Date().toISOString();
    for (let index = 0; index < SAMPLE.searchDocuments; index += 1) {
      const id = `budget-document-${index}`;
      const key = `DOC-${index}`;
      const title = `中文预算文档 ${index}`;
      const body = `项目验证关键词 任务管理 本地优先 第 ${index} 条`;
      insertDocument.run("RECORD", id, key, title, body, now);
      insertFts.run("RECORD", id, key, title, body);
    }
  })();
  direct.pragma("wal_checkpoint(TRUNCATE)");
  direct.close();
  const seed = {
    ...SAMPLE,
    seededMs: Math.round(performance.now() - started),
    bytes: directoryBytes(seedDir),
  };
  writeFileSync(marker, JSON.stringify(seed, null, 2));
  return seed;
}

/**
 * 样本库复制一份到 runDir（整个替换），当作这一轮的 2.x 根 L。registry 记的是项目库的绝对路径：
 * 不改写的话，副本里的服务会去开样本目录里的那些库，每一轮都改写同一份样本（实测第一版就是这样
 * 把备份写进了样本目录）。
 */
export function copySampleLibrary(seedDir: string, runDir: string): void {
  rmSync(runDir, { recursive: true, force: true, maxRetries: 2 });
  mkdirSync(runDir, { recursive: true });
  cpSync(seedDir, runDir, { recursive: true, filter: (source) => !source.endsWith(MARKER) });
  const registry = new Database(join(runDir, "registry", "registry.sqlite"));
  try {
    registry
      .prepare("UPDATE projects SET db_path = replace(db_path, ?, ?)")
      .run(seedDir, resolve(runDir));
    const leaked = registry
      .prepare("SELECT count(*) AS count FROM projects WHERE instr(lower(db_path), lower(?)) > 0")
      .get(seedDir) as { count: number };
    if (leaked.count > 0) throw new Error("副本 registry 仍指向样本目录");
  } finally {
    registry.close();
  }
}
