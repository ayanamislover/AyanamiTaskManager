import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { type DispatchPaths, readJsonFile, writeJsonAtomic } from "./files.js";
import type { DispatchLogger, DispatchRunRecord, DispatchRunView } from "./types.js";

/** 历史与日志都只留最近这么多次。 */
export const DISPATCH_HISTORY_LIMIT = 50;

const SummarySchema = z.object({
  numTurns: z.number().nullable(),
  durationMs: z.number().nullable(),
  totalCostUsd: z.number().nullable(),
  result: z.string(),
});

const RunRecordSchema = z.object({
  run: z.string().min(1),
  project: z.string().min(1),
  key: z.string().min(1),
  title: z.string(),
  origin: z.enum(["mobile", "desktop"]),
  state: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  sessionId: z.string().min(1),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
  summary: SummarySchema.optional(),
  error: z.string().optional(),
  cwd: z.string(),
  requestedBy: z.string().optional(),
  pid: z.number().int().positive().optional(),
});

const RunsFileSchema = z.object({ v: z.literal(1), runs: z.array(z.unknown()) });

/** 读 runs.json；逐条校验，坏条目丢弃并记日志，整个文件坏了就从空历史开始。 */
export function loadRuns(path: string, logger: DispatchLogger): DispatchRunRecord[] {
  const read = readJsonFile(path);
  if (read.kind === "missing") return [];
  if (read.kind === "corrupt") {
    logger.warn("派单历史文件无法解析，已从空历史开始", { path, error: read.error });
    return [];
  }
  const file = RunsFileSchema.safeParse(read.value);
  if (!file.success) {
    logger.warn("派单历史文件格式不对，已从空历史开始", { path });
    return [];
  }
  const runs: DispatchRunRecord[] = [];
  for (const entry of file.data.runs) {
    const parsed = RunRecordSchema.safeParse(entry);
    if (parsed.success) runs.push(stripUndefined(parsed.data) as DispatchRunRecord);
    else logger.warn("派单历史里有一条记录不合法，已丢弃", { path });
  }
  return runs.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

export function saveRuns(path: string, runs: readonly DispatchRunRecord[]): void {
  writeJsonAtomic(path, { v: 1, runs });
}

/**
 * 历史只留最近 {@link DISPATCH_HISTORY_LIMIT} 条；排队中与运行中的永远保留（它们还在被跟踪）。
 * `runs` 按创建时间升序，返回保留的部分（同样升序）。
 */
export function trimHistory(runs: readonly DispatchRunRecord[]): DispatchRunRecord[] {
  if (runs.length <= DISPATCH_HISTORY_LIMIT) return [...runs];
  const active = (record: DispatchRunRecord) =>
    record.state === "queued" || record.state === "running";
  let budget = DISPATCH_HISTORY_LIMIT - runs.filter(active).length;
  const keep = new Set<DispatchRunRecord>();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const record = runs[index]!;
    if (active(record)) keep.add(record);
    else if (budget > 0) {
      keep.add(record);
      budget -= 1;
    }
  }
  return runs.filter((record) => keep.has(record));
}

const LOG_FILE = /^(.+?)\.(?:jsonl|stderr\.log)$/u;

/** 删掉不属于保留历史的日志文件，日志目录因此也只留最近 50 次。 */
export function pruneLogs(paths: DispatchPaths, keep: ReadonlySet<string>, logger: DispatchLogger) {
  let names: string[];
  try {
    names = readdirSync(paths.logs);
  } catch {
    return;
  }
  for (const name of names) {
    const match = LOG_FILE.exec(name);
    if (!match || keep.has(match[1]!)) continue;
    try {
      rmSync(join(paths.logs, name), { force: true });
    } catch (error) {
      logger.warn("清理旧的派单日志失败，下次再试", {
        file: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** 对外视图：去掉 cwd / requestedBy / pid 这些只供本机跟踪进程用的字段。 */
export function toRunView(record: DispatchRunRecord): DispatchRunView {
  const view = { ...record } as Partial<DispatchRunRecord>;
  delete view.cwd;
  delete view.requestedBy;
  delete view.pid;
  return view as DispatchRunView;
}
