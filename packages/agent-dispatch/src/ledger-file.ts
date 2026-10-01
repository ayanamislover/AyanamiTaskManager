import { copyFileSync } from "node:fs";
import { z } from "zod";
import { DISPATCH_ERROR_POLICIES, type DispatchErrorCode } from "./errors.js";
import { readJsonFile } from "./files.js";
import { toRunView } from "./run-store.js";
import type { DispatchLogger, DispatchRunRecord, DispatchRunView } from "./types.js";

// 请求账本 `dispatch/requests.json` 的格式、常量与「读盘 → 判断有没有丢过数据」。状态与写入见 request-ledger.ts。

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
 * COMMAND_EXPIRED 拒绝，不会走到这里。丢失水位线也保留这么久。
 */
export const DISPATCH_REQUEST_RETENTION_MS = DISPATCH_REQUEST_MAX_AGE_MS + 2 * DAY_MS;

/**
 * 保留期内最多记这么多条（含正在办理、已预留名额的请求）；满了拒收新的手机派单
 * （DISPATCH_TOO_MANY_REQUESTS）而不是挤掉旧条目，否则被挤掉的命令在有效期内重放就能再起一次会话。
 */
export const DISPATCH_REQUEST_LIMIT = 2_000;

/** requestId 只是不透明的幂等键（手机命令传命令 ID）；限制字符集与长度，免得账本被塞进奇怪的东西。 */
export const DISPATCH_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/** 手机命令 ID：`<deviceId>.<13 位 base36 毫秒时间><8 位 hex>`（与 sync-protocol 的 COMMAND_ID_PATTERN 同形）。 */
const COMMAND_ID_SHAPE = /^(?:pc|m)-[0-9a-f]{12}\.([0-9a-z]{13})[0-9a-f]{8}$/u;

/** 从命令形 requestId 里取发送时间（毫秒）；不是命令 ID 的形状返回 null。 */
export function requestTimestamp(requestId: string): number | null {
  const stamp = COMMAND_ID_SHAPE.exec(requestId)?.[1];
  if (stamp === undefined) return null;
  const at = Number.parseInt(stamp, 36);
  return Number.isSafeInteger(at) ? at : null;
}

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
export type Snapshot = z.infer<typeof SnapshotSchema>;

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

const LedgerFileSchema = z.object({
  v: z.literal(1),
  /** 数据丢失水位线（ISO）：见 request-ledger.ts。 */
  lostBefore: z.string().optional(),
  requests: z.array(z.unknown()),
});

export function snapshotOf(view: DispatchRunView): Snapshot {
  return Object.fromEntries(
    Object.entries(view).filter(([name, value]) => name !== "summary" && value !== undefined),
  ) as Snapshot;
}

/** 账本快照当对外视图用（派单已被历史裁剪时）。快照不含值为 undefined 的键：snapshotOf 滤掉了，解析也不会补。 */
export function snapshotView(snapshot: Snapshot): DispatchRunView {
  return { ...snapshot } as DispatchRunView;
}

export function sameSnapshot(left: Snapshot, right: Snapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** 账本读盘时参考的派单历史。`requestsSince` 缺省等同 null（旧调用方、测试）。 */
export type LedgerHistory = {
  runs: readonly DispatchRunRecord[];
  damaged: boolean;
  requestsSince?: string | null;
};

export type LedgerLoad =
  /** 文件在但读不出来：内容未知，什么都不能判断，也不能覆盖它。 */
  | { kind: "unavailable"; code: string }
  | {
      kind: "ok";
      entries: DispatchRequestEntry[];
      /** 文件里已有的水位线（毫秒）。 */
      lostBefore: number | null;
      /** 这次读盘发现的数据丢失原因；null = 没丢。 */
      loss: string | null;
      /** 从带 requestId 的派单历史补回了条目，或发现了丢失：需要立即写盘。 */
      dirty: boolean;
    };

/**
 * 读账本并判断有没有丢过数据：
 * - 不存在：历史完好、没有「用过账本」的标记（requestsSince）、也没有任何手机派单记录（带 requestId 或
 *   origin=mobile）→ 全新；否则 → 丢失（被删了）。标记不随历史裁剪消失，所以手机派单的记录被 50 条
 *   上限挤掉后，单删账本仍会判成丢失。
 * - 读不出来（不是 ENOENT）→ unavailable：调用方拒绝手机派单、下次再读，不改名不重建。
 * - 不是 JSON / 格式不对 → 丢失，原文件复制成 `requests.corrupt.json` 留给排查。
 * - 有条目不合法 → 丢失（合法的照留）。
 * 无论哪种，带 requestId 的派单历史都会补回成精确条目（它们不受水位线影响）。
 */
export function loadLedgerFile(
  path: string,
  history: LedgerHistory,
  logger: DispatchLogger,
): LedgerLoad {
  const read = readJsonFile(path);
  if (read.kind === "unreadable") {
    logger.error("派单请求账本读不出来，暂停接收手机派单，下次派单时重读", {
      path,
      code: read.code,
    });
    return { kind: "unavailable", code: read.code };
  }
  const entries: DispatchRequestEntry[] = [];
  let lostBefore: number | null = null;
  let loss: string | null = null;
  if (read.kind === "missing") {
    const usedBefore =
      (history.requestsSince ?? null) !== null ||
      history.runs.some((record) => record.requestId !== undefined || record.origin === "mobile");
    if (history.damaged || usedBefore)
      loss = "账本文件不见了，而这台电脑用过手机派单（或派单历史也坏了）";
  } else {
    const file = read.kind === "ok" ? LedgerFileSchema.safeParse(read.value) : null;
    if (!file?.success) loss = "账本文件损坏";
    else {
      const mark =
        file.data.lostBefore === undefined ? Number.NaN : Date.parse(file.data.lostBefore);
      if (file.data.lostBefore !== undefined && Number.isNaN(mark)) loss = "账本里的水位线不合法";
      else if (!Number.isNaN(mark)) lostBefore = mark;
      for (const raw of file.data.requests) {
        const parsed = EntrySchema.safeParse(raw);
        if (parsed.success) entries.push(parsed.data);
        else loss = "账本里有记录不合法";
      }
    }
    if (loss !== null) preserve(path, logger);
  }
  let dirty = loss !== null;
  const known = new Set(entries.map((entry) => entry.id));
  // 新的在前：同一个 requestId 在历史里出现两次（旧条目过期后又派过一次）时，以最近那次为准。
  for (const record of [...history.runs].reverse()) {
    if (record.requestId === undefined || known.has(record.requestId)) continue;
    entries.push({
      id: record.requestId,
      at: record.createdAt,
      run: snapshotOf(toRunView(record)),
    });
    known.add(record.requestId);
    dirty = true;
  }
  if (loss !== null) logger.warn("派单请求账本数据丢失，设下水位线", { path, reason: loss });
  return { kind: "ok", entries, lostBefore, loss, dirty };
}

/** 覆盖之前把坏掉的账本原样复制一份留给排查（复制而不是改名：新账本写失败时原文件还在，下次照样判丢失）。 */
function preserve(path: string, logger: DispatchLogger): void {
  try {
    copyFileSync(path, path.replace(/\.json$/u, ".corrupt.json"));
  } catch (error) {
    logger.warn("留存损坏的派单请求账本失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
