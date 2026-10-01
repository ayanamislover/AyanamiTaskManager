import { DispatchError } from "./errors.js";
import { writeJsonAtomic } from "./files.js";
import {
  DISPATCH_REQUEST_LIMIT,
  DISPATCH_REQUEST_RETENTION_MS,
  type DispatchRequestEntry,
  type LedgerHistory,
  loadLedgerFile,
  requestTimestamp,
  sameSnapshot,
  type Snapshot,
  snapshotOf,
} from "./ledger-file.js";
import type {
  DispatchLedgerStatus,
  DispatchLogger,
  DispatchRunRecord,
  DispatchRunView,
} from "./types.js";

const LEDGER_UNAVAILABLE_MESSAGE =
  "电脑上的派单记录暂时读不出来（文件权限或磁盘问题），为防重复执行暂不接收手机派单；稍后会自动重试，也可以在电脑上直接派单";

export {
  DISPATCH_REQUEST_ID_PATTERN,
  DISPATCH_REQUEST_LIMIT,
  DISPATCH_REQUEST_MAX_AGE_MS,
  DISPATCH_REQUEST_RETENTION_MS,
  requestTimestamp,
  snapshotView,
  type DispatchRequestEntry,
} from "./ledger-file.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE = new Set(["queued", "running"]);

/** 给新请求预留的一个账本名额：成功或业务拒绝时转成条目，否则释放。 */
export type LedgerReservation = { readonly id: string; open: boolean };

export type LedgerGate =
  | { kind: "replay"; entry: DispatchRequestEntry }
  | { kind: "new"; reservation: LedgerReservation };

/** 发送时间早于水位线的手机派单被拒时给用户看的话。 */
export const REQUEST_STATE_LOST_MESSAGE =
  "电脑上的派单记录损坏过，无法确认这条命令是否已经执行；如需再派，请在手机上重新交给 Claude";

/**
 * 派单请求账本（`dispatch/requests.json`）：requestId → 那次请求的结局（建出来的派单，或被拒的原因）。
 * 同一个 requestId 再来，派单层直接回放这个结局，绝不再起会话；条目在起进程之前落盘。
 *
 * 恢复状态机（读盘规则见 ledger-file.ts 的 loadLedgerFile）：
 * - `unavailable`：文件读不出来。带 requestId 的派单一律 503 DISPATCH_LEDGER_UNAVAILABLE，不改名不重建，
 *   每次派单/查状态前重读，读出来就转入正常状态。
 * - 正常、无水位线：照常幂等。
 * - 正常、有水位线 `lostBefore`（发现数据丢失的时刻，持久化）：记得住的请求（含从带 requestId 的派单历史
 *   补回的）照常精确回放；记不住的，发送时间 ≤ 水位线、或取不出发送时间的一律
 *   409 DISPATCH_REQUEST_STATE_LOST（不记进账本，免得把它固化）；发送时间在水位线之后的照常办理。
 *   水位线在 lostBefore + 保留期后自动清除：那之前发出的命令到时都已过期。
 */
export class RequestLedger {
  readonly #path: string;
  readonly #logger: DispatchLogger;
  readonly #history: () => LedgerHistory;
  readonly #markUsed: (since: string) => void;
  /**
   * 第一次往账本记东西的时刻，持久化在派单历史顶层（见 run-store.ts）；null = 从没用过。
   * 一旦有值就再不清空：每次保存历史都带上它，哪怕之前某次专门写它失败了。
   */
  #requestsSince: string | null;
  /** 标记已确认在盘上（读历史时就有，或专门写成功过）。只有确认过，首次接纳才能跳过那次安全写入。 */
  #markConfirmed: boolean;
  #available = false;
  #entries: DispatchRequestEntry[] = [];
  #lostBefore: number | null = null;
  /** admit 发出、还没用掉或还回来的名额；容量按「条目 + 这些名额」算。 */
  readonly #reserved = new Set<LedgerReservation>();

  /**
   * `markUsed` 把「用过账本」的标记写进派单历史文件，写失败要抛出；缺省只记在内存里（测试用）。
   */
  constructor(
    path: string,
    logger: DispatchLogger,
    history: () => LedgerHistory,
    now: Date,
    markUsed: (since: string) => void = () => {},
  ) {
    this.#path = path;
    this.#logger = logger;
    this.#history = history;
    this.#markUsed = markUsed;
    this.#requestsSince = history().requestsSince ?? null;
    this.#markConfirmed = this.#requestsSince !== null;
    this.#reload(now);
  }

  /** 派单历史保存时要带上的标记。 */
  get requestsSince(): string | null {
    return this.#requestsSince;
  }

  /**
   * 确认标记在盘上（之后单删账本才认得出是数据丢了）：没确认过就专门写一次。写失败抛出，调用方不得记账；
   * 已经决定要的标记（`#requestsSince`）不会因此丢掉，之后任何一次历史保存都会把它带上。
   */
  #ensureMarked(now: Date): void {
    if (this.#markConfirmed) return;
    const since = this.#requestsSince ?? now.toISOString();
    this.#markUsed(since);
    this.#requestsSince = since;
    this.#markConfirmed = true;
  }

  /** 读盘；读不出来就保持 unavailable。发现丢失或补回了条目时立即写盘（写失败下次启动会再判一次丢失）。 */
  #reload(now: Date): void {
    const loaded = loadLedgerFile(this.#path, this.#history(), this.#logger);
    if (loaded.kind === "unavailable") {
      this.#available = false;
      return;
    }
    this.#available = true;
    this.#entries = loaded.entries;
    this.#lostBefore = loaded.lostBefore;
    if (loaded.loss !== null)
      this.#lostBefore = Math.max(this.#lostBefore ?? Number.NEGATIVE_INFINITY, now.getTime());
    this.#prune(now);
    if (loaded.dirty) this.#trySave("写恢复后的派单请求账本失败");
    // 旧版本留下的账本还没有标记：现在就认定要标记（之后每次保存历史都带上），再试着专门写一次；
    // 写失败只记日志——下一次历史保存或下一次手机派单的接纳都会再写。
    if (this.#entries.length > 0 || this.#lostBefore !== null) {
      this.#requestsSince ??= now.toISOString();
      try {
        this.#ensureMarked(now);
      } catch (error) {
        this.#logger.warn("给派单历史补写账本标记失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  #save(): void {
    if (!this.#available) throw new Error("派单请求账本不可用，不能写");
    writeJsonAtomic(this.#path, {
      v: 1,
      ...(this.#lostBefore === null
        ? {}
        : { lostBefore: new Date(this.#lostBefore).toISOString() }),
      requests: this.#entries,
    });
  }

  #trySave(message: string): void {
    try {
      this.#save();
    } catch (error) {
      this.#logger.warn(message, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** 裁掉超过保留期的条目；水位线到期就清除（清除要落盘，免得重启后又冒出来）。 */
  #prune(now: Date): void {
    const cutoff = now.getTime() - DISPATCH_REQUEST_RETENTION_MS;
    this.#entries = this.#entries.filter((entry) => {
      const at = Date.parse(entry.at);
      // 记下时间看不懂的条目宁可留着（受条数上限约束），不能因此丢掉幂等。
      return Number.isNaN(at) || at >= cutoff;
    });
    if (this.#lostBefore !== null && this.#lostBefore < cutoff) {
      this.#lostBefore = null;
      this.#trySave("清除派单请求账本的水位线失败，下次再写");
    }
  }

  /** 读不出来的账本：先重读一次，仍不行就拒绝。 */
  #ensureAvailable(now: Date): void {
    if (!this.#available) this.#reload(now);
    if (!this.#available)
      throw new DispatchError("DISPATCH_LEDGER_UNAVAILABLE", LEDGER_UNAVAILABLE_MESSAGE);
  }

  status(now: Date): DispatchLedgerStatus {
    if (!this.#available) this.#reload(now);
    if (this.#available) this.#prune(now);
    const lost = this.#available ? this.#lostBefore : null;
    return {
      lostBefore: lost === null ? null : new Date(lost).toISOString(),
      lostUntil:
        lost === null ? null : new Date(lost + DISPATCH_REQUEST_RETENTION_MS).toISOString(),
      unavailable: !this.#available,
    };
  }

  /** 已记下的条目（不做可用性检查；不可用时没有条目）。 */
  find(requestId: string, now: Date): DispatchRequestEntry | undefined {
    this.#prune(now);
    return this.#entries.find((entry) => entry.id === requestId);
  }

  get size(): number {
    return this.#entries.length;
  }

  /**
   * 带 requestId 的派单入口，整段同步、没有 await：记过的 → 回放；账本读不出来 → 503；
   * 水位线之前发出的 → 409（不记账）；满了 → 429（不记账，过期后同一 ID 仍可办理）；
   * 否则预留一个名额。容量检查与预留在同一段同步代码里，并发请求不会越过上限。
   */
  admit(requestId: string, now: Date): LedgerGate {
    this.#ensureAvailable(now);
    const entry = this.find(requestId, now);
    if (entry) return { kind: "replay", entry };
    if (this.#lostBefore !== null) {
      const sentAt = requestTimestamp(requestId);
      if (sentAt === null || sentAt <= this.#lostBefore)
        throw new DispatchError("DISPATCH_REQUEST_STATE_LOST", REQUEST_STATE_LOST_MESSAGE, {
          requestId,
          lostBefore: new Date(this.#lostBefore).toISOString(),
        });
    }
    if (this.#entries.length + this.#reserved.size >= DISPATCH_REQUEST_LIMIT)
      throw new DispatchError(
        "DISPATCH_TOO_MANY_REQUESTS",
        `最近 ${DISPATCH_REQUEST_RETENTION_MS / DAY_MS} 天收到的手机派单已达 ${DISPATCH_REQUEST_LIMIT} 次，为防重放暂不接收新的手机派单；可以在电脑上直接派单，或过几天再试`,
      );
    // 第一次接纳之前先落标记：这时新派单还没进历史，写失败直接拒绝，不留半截记录。
    try {
      this.#ensureMarked(now);
    } catch (error) {
      this.#logger.error("写派单账本标记失败，暂不接收手机派单", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new DispatchError("DISPATCH_LEDGER_UNAVAILABLE", LEDGER_UNAVAILABLE_MESSAGE);
    }
    const reservation = { id: requestId, open: true };
    this.#reserved.add(reservation);
    return { kind: "new", reservation };
  }

  /** 没用上的名额还回去（成功或拒绝记账后再调也无妨）。 */
  release(reservation: LedgerReservation): void {
    reservation.open = false;
    this.#reserved.delete(reservation);
  }

  #append(reservation: LedgerReservation, entry: DispatchRequestEntry): void {
    // 写入端也守上限：只认 admit 发出且还没用掉的名额（名额在 admit 时已经计入容量），自己拼的对象不算。
    if (!this.#reserved.has(reservation) || !reservation.open || reservation.id !== entry.id)
      throw new Error("派单请求账本：没有可用名额，拒绝写入");
    this.release(reservation);
    this.#entries.push(entry);
  }

  /** 记下建出来的派单并立即落盘；写盘失败抛出（调用方不得再起会话）。 */
  recordRun(reservation: LedgerReservation, view: DispatchRunView, now: Date): void {
    const entry: DispatchRequestEntry = {
      id: reservation.id,
      at: now.toISOString(),
      run: snapshotOf(view),
    };
    this.#append(reservation, entry);
    try {
      this.#save();
    } catch (error) {
      this.#entries = this.#entries.filter((candidate) => candidate !== entry);
      throw error;
    }
  }

  /** 记下被拒的结局：同一请求再来时原样拒绝，不会因为状态变了就补起一次会话。写盘失败只记日志。 */
  recordRejection(reservation: LedgerReservation, error: DispatchError, now: Date): void {
    if (
      !this.#reserved.has(reservation) ||
      this.#entries.some((entry) => entry.id === reservation.id)
    )
      return;
    this.#append(reservation, {
      id: reservation.id,
      at: now.toISOString(),
      rejected: { code: error.code, message: error.message },
    });
    this.#trySave("写派单请求账本失败（被拒的请求）");
  }

  /**
   * 用派单历史刷新快照（在历史裁剪之前调）：被裁掉的派单在账本里留下的是它最后的状态。
   * 历史里已经没有、快照却还停在排队/运行中的（例如宿主在两次写盘之间崩溃）标成失败。
   */
  sync(
    records: readonly DispatchRunRecord[],
    view: (record: DispatchRunRecord) => DispatchRunView,
  ) {
    if (!this.#available) return;
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
    if (changed) this.#trySave("刷新派单请求账本失败，下次状态变化时再写");
  }
}
