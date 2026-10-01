import { renameSync, rmSync } from "node:fs";
import { z } from "zod";
import { DISPATCH_ERROR_POLICIES, DispatchError, type DispatchErrorCode } from "./errors.js";
import { readJsonFile, writeJsonAtomic } from "./files.js";
import type { DispatchLogger, DispatchRunRecord, DispatchRunView } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 手机命令的有效期：与 `@ayanami-task/sync-protocol` 的 COMMAND_MAX_AGE_MS 同值（7 天）。
 * 架构白名单里 agent-dispatch 只能依赖 agent-config 与 errors，所以在这里另立一份；
 * packages/sync/test/dispatch-replay.test.ts 有一条对照，两边不一致会红。
 */
export const DISPATCH_REQUEST_MAX_AGE_MS = 7 * DAY_MS;

/**
 * 账本条目从记下起保留多久：命令有效期 7 天 + 手机时钟最多快 1 天（同步侧在这个范围内仍接受命令，
 * 于是命令最晚能在首次处理后 8 天被重放而不过期）+ 1 天余量吸收电脑时钟回拨。超过它的重放会被同步侧以
 * COMMAND_EXPIRED 拒绝，不会走到这里。
 */
export const DISPATCH_REQUEST_RETENTION_MS = DISPATCH_REQUEST_MAX_AGE_MS + 2 * DAY_MS;

/**
 * 保留期内最多记这么多条；满了拒收新的手机派单（DISPATCH_TOO_MANY_REQUESTS）而不是挤掉旧条目，
 * 否则被挤掉的命令在有效期内重放就能再起一次会话。正常使用九天里远到不了这个数。
 */
export const DISPATCH_REQUEST_LIMIT = 2_000;

/** requestId 只是不透明的幂等键（手机命令传命令 ID）；限制字符集与长度，免得账本被塞进奇怪的东西。 */
export const DISPATCH_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const ACTIVE = new Set(["queued", "running"]);

/** 派单被历史裁剪后仍要能回答「那次怎么样了」的最小快照：对外视图去掉摘要。 */
const SnapshotSchema = z.object({
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
  error: z.string().optional(),
});
type Snapshot = z.infer<typeof SnapshotSchema>;

const CODES = Object.keys(DISPATCH_ERROR_POLICIES) as [DispatchErrorCode, ...DispatchErrorCode[]];

const EntrySchema = z.union([
  z.object({
    id: z.string().regex(DISPATCH_REQUEST_ID_PATTERN),
    at: z.string(),
    run: SnapshotSchema,
  }),
  z.object({
    id: z.string().regex(DISPATCH_REQUEST_ID_PATTERN),
    at: z.string(),
    rejected: z.object({ code: z.enum(CODES), message: z.string() }),
  }),
]);
export type DispatchRequestEntry = z.infer<typeof EntrySchema>;

const LedgerFileSchema = z.object({ v: z.literal(1), requests: z.array(z.unknown()) });

function snapshotOf(view: DispatchRunView): Snapshot {
  return Object.fromEntries(
    Object.entries(view).filter(([name, value]) => name !== "summary" && value !== undefined),
  ) as Snapshot;
}

/** 账本快照当对外视图用（派单已被历史裁剪时）。快照不含值为 undefined 的键：snapshotOf 滤掉了，解析也不会补。 */
export function snapshotView(snapshot: Snapshot): DispatchRunView {
  return { ...snapshot } as DispatchRunView;
}

function sameSnapshot(left: Snapshot, right: Snapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * 派单请求账本（`dispatch/requests.json`）：requestId → 那次请求的结局（建出来的派单，或被拒的原因）。
 * 同一个 requestId 再来，派单层直接回放这个结局，绝不再起会话；条目在起进程之前落盘。
 * 与 runs.json 同样原子写；文件坏了改名成 `requests.corrupt.json` 留给排查，从空账本开始。
 */
export class RequestLedger {
  readonly #path: string;
  readonly #logger: DispatchLogger;
  #entries: DispatchRequestEntry[] = [];

  constructor(path: string, logger: DispatchLogger) {
    this.#path = path;
    this.#logger = logger;
    this.#entries = this.#load();
  }

  #load(): DispatchRequestEntry[] {
    const read = readJsonFile(this.#path);
    if (read.kind === "missing") return [];
    const file = read.kind === "ok" ? LedgerFileSchema.safeParse(read.value) : null;
    if (!file?.success) {
      this.#quarantine();
      return [];
    }
    const entries: DispatchRequestEntry[] = [];
    for (const raw of file.data.requests) {
      const parsed = EntrySchema.safeParse(raw);
      if (parsed.success) entries.push(parsed.data);
      else this.#logger.warn("派单请求账本里有一条记录不合法，已丢弃", { path: this.#path });
    }
    return entries;
  }

  #quarantine(): void {
    const target = this.#path.replace(/\.json$/u, ".corrupt.json");
    try {
      rmSync(target, { force: true });
      renameSync(this.#path, target);
    } catch {
      // 改名失败不影响：下一次写入会覆盖原文件。
    }
    this.#logger.warn("派单请求账本无法解析，已改名留存并从空账本开始", { path: this.#path });
  }

  #save(): void {
    writeJsonAtomic(this.#path, { v: 1, requests: this.#entries });
  }

  #prune(now: Date): void {
    const cutoff = now.getTime() - DISPATCH_REQUEST_RETENTION_MS;
    this.#entries = this.#entries.filter((entry) => {
      const at = Date.parse(entry.at);
      // 记下时间看不懂的条目宁可留着（受条数上限约束），不能因此丢掉幂等。
      return Number.isNaN(at) || at >= cutoff;
    });
  }

  get size(): number {
    return this.#entries.length;
  }

  find(requestId: string, now: Date): DispatchRequestEntry | undefined {
    this.#prune(now);
    return this.#entries.find((entry) => entry.id === requestId);
  }

  /** 满了就拒收：在做任何事之前调用。 */
  assertCapacity(now: Date): void {
    this.#prune(now);
    if (this.#entries.length >= DISPATCH_REQUEST_LIMIT)
      throw new DispatchError(
        "DISPATCH_TOO_MANY_REQUESTS",
        `最近 ${DISPATCH_REQUEST_RETENTION_MS / DAY_MS} 天收到的手机派单已达 ${DISPATCH_REQUEST_LIMIT} 次，为防重放暂不接收新的手机派单；可以在电脑上直接派单，或过几天再试`,
      );
  }

  /** 记下建出来的派单并立即落盘；写盘失败抛出（调用方不得再起会话）。 */
  recordRun(requestId: string, view: DispatchRunView, now: Date): void {
    const entry: DispatchRequestEntry = {
      id: requestId,
      at: now.toISOString(),
      run: snapshotOf(view),
    };
    this.#entries.push(entry);
    try {
      this.#save();
    } catch (error) {
      this.#entries = this.#entries.filter((candidate) => candidate !== entry);
      throw error;
    }
  }

  /** 记下被拒的结局：同一请求再来时原样拒绝，不会因为状态变了就补起一次会话。写盘失败只记日志。 */
  recordRejection(requestId: string, error: DispatchError, now: Date): void {
    this.#entries.push({
      id: requestId,
      at: now.toISOString(),
      rejected: { code: error.code, message: error.message },
    });
    try {
      this.#save();
    } catch (saveError) {
      this.#logger.warn("写派单请求账本失败（被拒的请求）", {
        error: saveError instanceof Error ? saveError.message : String(saveError),
      });
    }
  }

  /**
   * 用派单历史刷新快照（在历史裁剪之前调）：被裁掉的派单在账本里留下的是它最后的状态。
   * 历史里已经没有、快照却还停在排队/运行中的（例如宿主在两次写盘之间崩溃）标成失败。
   */
  sync(
    records: readonly DispatchRunRecord[],
    view: (record: DispatchRunRecord) => DispatchRunView,
  ) {
    const byRun = new Map(records.map((record) => [record.run, record]));
    let changed = false;
    for (const entry of this.#entries) {
      if (!("run" in entry)) continue;
      const record = byRun.get(entry.run.run);
      let next: Snapshot;
      if (record) next = snapshotOf(view(record));
      else if (ACTIVE.has(entry.run.state))
        next = {
          ...entry.run,
          state: "failed",
          error: "这次派单已不在派单历史里（宿主可能在写盘途中退出）",
        };
      else continue;
      if (sameSnapshot(entry.run, next)) continue;
      entry.run = next;
      changed = true;
    }
    if (!changed) return;
    try {
      this.#save();
    } catch (error) {
      this.#logger.warn("刷新派单请求账本失败，下次状态变化时再写", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
