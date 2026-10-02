import { spacePrefix } from "./keys.js";
import { RelayError, type RelayChange, type RelayClient } from "./relay-client.js";

export type FeedBatch = {
  /** 只含本空间的变更。 */
  changes: RelayChange[];
  cursor: string | null;
  /**
   * 游标刚建立或已过期（410）：调用方应该全量列一次本空间的文档，
   * 之后的增量从新游标开始。
   */
  reset: boolean;
};

export type ChangeFeedOptions = {
  client: RelayClient;
  spaceId: string;
  cursor: string | null;
  longPoll: boolean;
  /** 长轮询时每次最多挂起的秒数，默认 25。 */
  maxWait?: number;
  /** 定时轮询间隔（毫秒）。 */
  intervalMs: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

const BOOTSTRAP_PAGE_LIMIT = 200;

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 变更流。每次 `next()` 返回一批（可能为空）。支持长轮询的中继挂起等待；
 * 不支持的（AyanamiCloud）在上一批为空时先睡 `intervalMs` 再问。
 */
export class ChangeFeed {
  readonly #client: RelayClient;
  readonly #prefix: string;
  readonly #longPoll: boolean;
  readonly #maxWait: number;
  readonly #intervalMs: number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  #cursor: string | null;
  #idle = false;

  constructor(options: ChangeFeedOptions) {
    this.#client = options.client;
    this.#prefix = spacePrefix(options.spaceId);
    this.#cursor = options.cursor;
    this.#longPoll = options.longPoll;
    this.#maxWait = Math.min(25, Math.max(1, options.maxWait ?? 25));
    this.#intervalMs = options.intervalMs;
    this.#sleep = options.sleep ?? abortableSleep;
  }

  get cursor(): string | null {
    return this.#cursor;
  }

  /** 下一次 next() 不等待（例如刚发了命令，想尽快看到回执）。 */
  poke(): void {
    this.#idle = false;
  }

  async #bootstrap(signal?: AbortSignal): Promise<FeedBatch> {
    let cursor: string | null = null;
    for (let page = 0; page < BOOTSTRAP_PAGE_LIMIT; page += 1) {
      const options: { limit: number; signal?: AbortSignal } = { limit: 500 };
      if (signal) options.signal = signal;
      const result = await this.#client.changes(cursor, options);
      cursor = result.nextCursor;
      if (!result.hasMore) break;
    }
    this.#cursor = cursor;
    this.#idle = false;
    return { changes: [], cursor, reset: true };
  }

  async next(signal?: AbortSignal): Promise<FeedBatch> {
    if (this.#cursor === null) return this.#bootstrap(signal);
    if (!this.#longPoll && this.#idle) await this.#sleep(this.#intervalMs, signal);
    const options: { limit: number; wait?: number; signal?: AbortSignal } = { limit: 500 };
    if (this.#longPoll) options.wait = this.#maxWait;
    if (signal) options.signal = signal;
    try {
      const result = await this.#client.changes(this.#cursor, options);
      this.#cursor = result.nextCursor ?? this.#cursor;
      this.#idle = !result.hasMore && result.changes.length === 0;
      return {
        changes: result.changes.filter((change) => change.key.startsWith(this.#prefix)),
        cursor: this.#cursor,
        reset: false,
      };
    } catch (error) {
      if (error instanceof RelayError && error.status === 410) {
        this.#cursor = null;
        return this.#bootstrap(signal);
      }
      throw error;
    }
  }
}

/** 网络失败后的退避：1 s → 2 s → … → 60 s。 */
export function backoffDelay(failures: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.max(0, failures - 1));
}
