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
  // 旧版本存的 processCreatedAt（ISO 创建时间）不在这里：解析时被丢弃，身份按未知处理。
  processIdentity: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
});

const RunsFileSchema = z.object({
  v: z.literal(1),
  /**
   * 第一次往请求账本记东西的时刻（ISO）。放在历史文件顶层、不随 50 条裁剪消失：手机派单的记录被裁掉后，
   * 单删 requests.json 也能认出是「数据丢了」，而不是「从没用过手机派单」。
   */
  requestsSince: z.string().min(1).optional(),
  runs: z.array(z.unknown()),
});

export type RunsHistory = {
  runs: DispatchRunRecord[];
  damaged: boolean;
  requestsSince: string | null;
};

/**
 * 读 runs.json；逐条校验，坏条目丢弃并记日志，整个文件坏了就从空历史开始。
 * `damaged` 表示历史读出来时有损（读不出、不是 JSON、格式不对或有条目被丢）：请求账本据此判断
 * 「两份记录都没了」是不是数据丢失，而不是全新安装。`requestsSince` 见 RunsFileSchema。
 */
export function loadRuns(path: string, logger: DispatchLogger): RunsHistory {
  const read = readJsonFile(path);
  if (read.kind === "missing") return { runs: [], damaged: false, requestsSince: null };
  if (read.kind !== "ok") {
    logger.warn("派单历史文件无法读取或解析，已从空历史开始", { path, error: read.error });
    return { runs: [], damaged: true, requestsSince: null };
  }
  const file = RunsFileSchema.safeParse(read.value);
  if (!file.success) {
    logger.warn("派单历史文件格式不对，已从空历史开始", { path });
    return { runs: [], damaged: true, requestsSince: null };
  }
  const runs: DispatchRunRecord[] = [];
  let damaged = false;
  for (const entry of file.data.runs) {
    const parsed = RunRecordSchema.safeParse(entry);
    if (parsed.success) runs.push(stripUndefined(parsed.data) as DispatchRunRecord);
    else {
      damaged = true;
      logger.warn("派单历史里有一条记录不合法，已丢弃", { path });
    }
  }
  runs.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return { runs, damaged, requestsSince: file.data.requestsSince ?? null };
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

export function saveRuns(
  path: string,
  runs: readonly DispatchRunRecord[],
  requestsSince: string | null = null,
): void {
  writeJsonAtomic(path, { v: 1, ...(requestsSince === null ? {} : { requestsSince }), runs });
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

/** 对外视图：去掉 cwd / requestedBy / pid / processIdentity / requestId 这些只供本机用的字段。 */
export function toRunView(record: DispatchRunRecord): DispatchRunView {
  const view = { ...record } as Partial<DispatchRunRecord> & { processCreatedAt?: unknown };
  delete view.cwd;
  delete view.requestedBy;
  delete view.pid;
  delete view.processIdentity;
  delete view.requestId;
  delete view.processCreatedAt;
  return view as DispatchRunView;
}
